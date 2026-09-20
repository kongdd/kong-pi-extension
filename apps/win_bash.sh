# Launcher source: ~/.win-launch.c (Windows: %USERPROFILE%\.win-launch.c)
win_path() {
    local drive input_path relative_path

    [ "$#" -eq 1 ] || {
        printf 'Usage: win_path PATH\n' >&2
        return 2
    }

    input_path=$(realpath -m -- "$1") || return
    case "$input_path" in
        /mnt/? | /mnt/?/*)
            drive=${input_path#/mnt/}
            drive=${drive%%/*}
            relative_path=${input_path#/mnt/$drive}
            relative_path=${relative_path//\//\\}
            printf '%s:%s\n' "$drive" "${relative_path:-\\}"
            ;;
        *)
            printf 'win_path: path must be under /mnt/<drive>: %s\n' "$input_path" >&2
            return 2
            ;;
    esac
}

win_ssh() {
    [ -n "${WIN_SSH_HOST:-}" ] || {
        printf 'win: set WIN_SSH_HOST\n' >&2
        return 2
    }
    ssh -o ControlMaster=auto -o ControlPersist=10m \
        -o ControlPath="$HOME/.ssh/cm-%C" "$WIN_SSH_HOST" "$@"
}

win_launch() {
    local app=$1 remote_path=$2

    case "$app$remote_path" in
        *\"*)
            printf 'win: double quotes are not supported\n' >&2
            return 2
            ;;
    esac

    win_ssh \
        "\"%USERPROFILE%\\.win-launch.exe\" \"$app\" \"$remote_path\""
}

# 输出 Windows 剪贴板 PNG；用法：win_clipboard > image.png
win_clipboard() {
    win_ssh '"%USERPROFILE%\.win-launch.exe" --clipboard'
}

win() {
    local app remote_path

    [ "$#" -ge 1 ] && [ "$#" -le 2 ] || {
        printf 'Usage: win APP [PATH]\n' >&2
        return 2
    }

    app=$1
    case "$app" in
        start) app=explorer.exe ;;
        code) app='C:\Program Files\Microsoft VS Code\Code.exe' ;;
    esac
    remote_path=$(win_path "${2:-$PWD}") || return
    win_launch "$app" "$remote_path"
}

smerge() {
    win smerge "$@"
}

start() {
    win start "$@"
}

code-ssh() {
    [ "$#" -le 1 ] || {
        printf 'Usage: code-ssh [PATH]\n' >&2
        return 2
    }
    [ -n "${REMOTE_SSH_HOST:-}" ] || {
        printf 'code-ssh: set REMOTE_SSH_HOST\n' >&2
        return 2
    }
    win_launch 'C:\Program Files\Microsoft VS Code\Code.exe' \
        "--folder-uri=vscode-remote://ssh-remote+$REMOTE_SSH_HOST$(realpath -m -- "${1:-$PWD}")"
}

zed() {
    [ "$#" -le 1 ] || {
        printf 'Usage: zed-ssh [PATH]\n' >&2
        return 2
    }
    [ -n "${REMOTE_SSH_HOST:-}" ] || {
        printf 'zed: set REMOTE_SSH_HOST\n' >&2
        return 2
    }
    win_launch Zed \
        "ssh://$REMOTE_SSH_HOST:$(realpath -m -- "${1:-$PWD}")"
}
