/*
 * Windows launcher bridge for ~/.win_bash.
 *
 * Build on Windows:
 *   gcc -municode -mwindows -Os -s .win-launch.c \
 *       -o .win-launch.exe -lshell32
 *
 * --server runs in the interactive desktop session and receives launch
 * requests over a named pipe. Client mode forwards APP and PATH to it.
 */
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>

#define PIPE_NAME L"\\\\.\\pipe\\PiWinLaunch"
#define MAX_CHARS 32767

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

    wchar_t command[MAX_CHARS + 1];
    if (swprintf(
            command, MAX_CHARS + 1, L"\"%ls\" \"%ls\"", exe, path
        ) < 0)
        return ERROR_BUFFER_OVERFLOW;

    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process;
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_SHOWNORMAL;

    if (!CreateProcessW(
            NULL, command, NULL, NULL, FALSE, CREATE_NO_WINDOW,
            NULL, NULL, &startup, &process
        ))
        return GetLastError();

    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return ERROR_SUCCESS;
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
                result = launch(app, path);
            }
        }

        transfer(pipe, &result, sizeof(result), TRUE);
        FlushFileBuffers(pipe);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);

        if (app)
            HeapFree(GetProcessHeap(), 0, app);
        if (path)
            HeapFree(GetProcessHeap(), 0, path);
    }
}

static int send_request(const wchar_t *app, const wchar_t *path)
{
    Request request = {
        (DWORD)wcslen(app),
        (DWORD)wcslen(path)
    };

    if (!WaitNamedPipeW(PIPE_NAME, 2000))
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

    CloseHandle(pipe);
    return ok ? (int)result : (int)GetLastError();
}

int WINAPI wWinMain(
    HINSTANCE instance, HINSTANCE previous, PWSTR line, int show
)
{
    int argc;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv)
        return 2;

    int result;
    if (argc == 2 && wcscmp(argv[1], L"--server") == 0)
        result = serve();
    else if (argc == 3)
        result = send_request(argv[1], argv[2]);
    else
        result = 2;

    LocalFree(argv);
    return result;
}
