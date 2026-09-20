/*
 * Windows launcher bridge for ~/.win_bash.
 *
 * Build on Windows:
 *   gcc -municode -mwindows -Os -s .win-launch.c \
 *       -o .win-launch.exe -lshell32
 *
 * --server runs in the interactive desktop session and receives launch
 * requests over a named pipe. Client mode launches APP or streams clipboard PNG.
 */
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>

#define PIPE_NAME L"\\\\.\\pipe\\PiWinLaunch"
#define CLIPBOARD_ARG L"--clipboard"
#define MAX_CHARS 32767
#define MAX_IMAGE_BYTES (18 * 1024 * 1024)
#define CLIPBOARD_TIMEOUT_MS 8000

typedef struct {
    DWORD app_chars;
    DWORD path_chars;
} Request;

static BOOL transfer(HANDLE pipe, void *buffer, DWORD size, BOOL write)
{
    BYTE *data = buffer;

    while (size) {
        DWORD done = 0;
        BOOL ok = write ? WriteFile(pipe, data, size, &done, NULL)
                        : ReadFile(pipe, data, size, &done, NULL);
        if (!ok || !done)
            return FALSE;

        data += done;
        size -= done;
    }
    return TRUE;
}

static DWORD launch(const wchar_t *app, const wchar_t *path)
{
    wchar_t resolved[MAX_CHARS + 1];
    DWORD length = SearchPathW(
        NULL, app, L".exe", MAX_CHARS, resolved, NULL
    );
    const wchar_t *exe = length && length <= MAX_CHARS ? resolved : app;

    wchar_t parameters[MAX_CHARS + 1];
    if (swprintf(parameters, MAX_CHARS + 1, L"\"%ls\"", path) < 0)
        return ERROR_BUFFER_OVERFLOW;

    INT_PTR result = (INT_PTR)ShellExecuteW(
        NULL, NULL, exe, parameters, NULL, SW_SHOWNORMAL
    );
    return result > 32 ? ERROR_SUCCESS : (DWORD)result;
}

/* Run clipimg in the desktop session and capture its output. */
static DWORD capture_clipboard(BYTE **output, DWORD *output_size)
{
    wchar_t exe[MAX_CHARS + 1];
    DWORD length = SearchPathW(
        NULL, L"clipimg.exe", NULL, MAX_CHARS, exe, NULL
    );
    if (!length || length > MAX_CHARS)
        return ERROR_FILE_NOT_FOUND;

    wchar_t command[MAX_CHARS + 1];
    if (swprintf(command, MAX_CHARS + 1, L"\"%ls\" --stdout", exe) < 0)
        return ERROR_BUFFER_OVERFLOW;

    wchar_t temp_dir[MAX_PATH];
    wchar_t temp_file[MAX_PATH];
    length = GetTempPathW(MAX_PATH, temp_dir);
    if (!length || length >= MAX_PATH ||
        !GetTempFileNameW(temp_dir, L"pwl", 0, temp_file))
        return GetLastError();

    SECURITY_ATTRIBUTES security = {sizeof(security), NULL, TRUE};
    HANDLE capture = CreateFileW(
        temp_file, GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        &security, TRUNCATE_EXISTING,
        FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, NULL
    );
    if (capture == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        DeleteFileW(temp_file);
        return error;
    }

    HANDLE null = CreateFileW(
        L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security, OPEN_EXISTING, 0, NULL
    );
    if (null == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        CloseHandle(capture);
        return error;
    }

    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process;
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    startup.wShowWindow = SW_HIDE;
    startup.hStdInput = null;
    startup.hStdOutput = capture;
    startup.hStdError = capture;

    BOOL started = CreateProcessW(
        exe, command, NULL, NULL, TRUE, CREATE_NO_WINDOW,
        NULL, NULL, &startup, &process
    );
    DWORD result = started ? ERROR_SUCCESS : GetLastError();
    CloseHandle(null);
    if (!started) {
        CloseHandle(capture);
        return result;
    }

    DWORD wait = WaitForSingleObject(
        process.hProcess, CLIPBOARD_TIMEOUT_MS
    );
    if (wait != WAIT_OBJECT_0) {
        result = wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError();
        TerminateProcess(process.hProcess, result);
        WaitForSingleObject(process.hProcess, 1000);
    }

    DWORD exit_code = 1;
    if (result == ERROR_SUCCESS &&
        (!GetExitCodeProcess(process.hProcess, &exit_code) || exit_code))
        result = ERROR_INVALID_DATA;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);

    LARGE_INTEGER size;
    LARGE_INTEGER start = {0};
    if (!GetFileSizeEx(capture, &size)) {
        if (result == ERROR_SUCCESS)
            result = GetLastError();
    } else if (size.QuadPart > MAX_IMAGE_BYTES) {
        if (result == ERROR_SUCCESS)
            result = ERROR_FILE_TOO_LARGE;
    } else if (!SetFilePointerEx(capture, start, NULL, FILE_BEGIN)) {
        if (result == ERROR_SUCCESS)
            result = GetLastError();
    } else if (size.QuadPart) {
        *output_size = (DWORD)size.QuadPart;
        *output = HeapAlloc(GetProcessHeap(), 0, *output_size);
        if (!*output) {
            result = ERROR_OUTOFMEMORY;
            *output_size = 0;
        } else if (!transfer(
                       capture, *output, *output_size, FALSE
                   )) {
            result = GetLastError();
            HeapFree(GetProcessHeap(), 0, *output);
            *output = NULL;
            *output_size = 0;
        }
    } else if (result == ERROR_SUCCESS) {
        result = ERROR_INVALID_DATA;
    }

    CloseHandle(capture);
    return result;
}

static int serve(void)
{
    HANDLE mutex = CreateMutexW(NULL, FALSE, L"Local\\PiWinLaunchServer");
    if (!mutex || GetLastError() == ERROR_ALREADY_EXISTS)
        return 0;

    for (;;) {
        HANDLE pipe = CreateNamedPipeW(
            PIPE_NAME,
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            sizeof(DWORD),
            65536,
            0,
            NULL
        );
        if (pipe == INVALID_HANDLE_VALUE)
            return (int)GetLastError();

        BOOL connected = ConnectNamedPipe(pipe, NULL) ||
                         GetLastError() == ERROR_PIPE_CONNECTED;
        Request request;
        DWORD result = ERROR_INVALID_DATA;
        DWORD payload_size = 0;
        BYTE *payload = NULL;
        BOOL clipboard = FALSE;
        wchar_t *app = NULL;
        wchar_t *path = NULL;

        if (connected &&
            transfer(pipe, &request, sizeof(request), FALSE) &&
            request.app_chars && request.app_chars <= MAX_CHARS &&
            request.path_chars && request.path_chars <= MAX_CHARS) {
            app = HeapAlloc(
                GetProcessHeap(), 0,
                (request.app_chars + 1) * sizeof(wchar_t)
            );
            path = HeapAlloc(
                GetProcessHeap(), 0,
                (request.path_chars + 1) * sizeof(wchar_t)
            );

            if (app && path &&
                transfer(
                    pipe, app,
                    request.app_chars * sizeof(wchar_t), FALSE
                ) &&
                transfer(
                    pipe, path,
                    request.path_chars * sizeof(wchar_t), FALSE
                )) {
                app[request.app_chars] = L'\0';
                path[request.path_chars] = L'\0';
                clipboard = wcscmp(app, CLIPBOARD_ARG) == 0;
                result = clipboard
                    ? capture_clipboard(&payload, &payload_size)
                    : launch(app, path);
            }
        }

        transfer(pipe, &result, sizeof(result), TRUE);
        if (clipboard &&
            transfer(pipe, &payload_size, sizeof(payload_size), TRUE) &&
            payload_size)
            transfer(pipe, payload, payload_size, TRUE);
        FlushFileBuffers(pipe);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);

        if (app)
            HeapFree(GetProcessHeap(), 0, app);
        if (path)
            HeapFree(GetProcessHeap(), 0, path);
        if (payload)
            HeapFree(GetProcessHeap(), 0, payload);
    }
}

static int send_request(
    const wchar_t *app, const wchar_t *path, BOOL receive_output
)
{
    Request request = {
        (DWORD)wcslen(app),
        (DWORD)wcslen(path)
    };

    if (!WaitNamedPipeW(PIPE_NAME, CLIPBOARD_TIMEOUT_MS + 2000))
        return (int)GetLastError();

    HANDLE pipe = CreateFileW(
        PIPE_NAME,
        GENERIC_READ | GENERIC_WRITE,
        0,
        NULL,
        OPEN_EXISTING,
        0,
        NULL
    );
    if (pipe == INVALID_HANDLE_VALUE)
        return (int)GetLastError();

    DWORD result = ERROR_WRITE_FAULT;
    BOOL ok = transfer(pipe, &request, sizeof(request), TRUE) &&
              transfer(
                  pipe, (void *)app,
                  request.app_chars * sizeof(wchar_t), TRUE
              ) &&
              transfer(
                  pipe, (void *)path,
                  request.path_chars * sizeof(wchar_t), TRUE
              ) &&
              transfer(pipe, &result, sizeof(result), FALSE);

    BYTE *payload = NULL;
    DWORD payload_size = 0;
    if (ok && receive_output) {
        ok = transfer(
            pipe, &payload_size, sizeof(payload_size), FALSE
        );
        if (ok &&
            (payload_size > MAX_IMAGE_BYTES ||
             (result == ERROR_SUCCESS && !payload_size))) {
            SetLastError(ERROR_INVALID_DATA);
            ok = FALSE;
        }
        if (ok && payload_size) {
            payload = HeapAlloc(GetProcessHeap(), 0, payload_size);
            if (!payload) {
                SetLastError(ERROR_OUTOFMEMORY);
                ok = FALSE;
            }
        }
        if (ok && payload_size)
            ok = transfer(pipe, payload, payload_size, FALSE);
        if (ok && payload_size)
            ok = transfer(
                GetStdHandle(
                    result == ERROR_SUCCESS
                        ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE
                ),
                payload, payload_size, TRUE
            );
    }

    DWORD error = ok ? result : GetLastError();
    if (payload)
        HeapFree(GetProcessHeap(), 0, payload);
    CloseHandle(pipe);
    return (int)error;
}

int WINAPI wWinMain(
    HINSTANCE instance, HINSTANCE previous, PWSTR line, int show
)
{
    (void)instance;
    (void)previous;
    (void)line;
    (void)show;

    int argc;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv)
        return 2;

    int result;
    if (argc == 2 && wcscmp(argv[1], L"--server") == 0)
        result = serve();
    else if (argc == 2 && wcscmp(argv[1], CLIPBOARD_ARG) == 0)
        result = send_request(CLIPBOARD_ARG, L"-", TRUE);
    else if (argc == 3)
        result = send_request(argv[1], argv[2], FALSE);
    else
        result = 2;

    LocalFree(argv);
    return result;
}
