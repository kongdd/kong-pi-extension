# Launcher source: ~/.win-launch.c (Windows: C:\Users\hydro\.win-launch.c)
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

win_launch() {
    local app=$1 remote_path=$2

    case "$app$remote_path" in
        *\"*)
            printf 'win: double quotes are not supported\n' >&2
            return 2
            ;;
    esac

    ssh -o ControlMaster=auto -o ControlPersist=10m \
        -o ControlPath="$HOME/.ssh/cm-%C" kong \
        "\"C:\\Users\\hydro\\.win-launch.exe\" \"$app\" \"$remote_path\""
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

code-ssh() {
    [ "$#" -le 1 ] || {
        printf 'Usage: code-ssh [PATH]\n' >&2
        return 2
    }
    win_launch 'C:\Program Files\Microsoft VS Code\Code.exe' \
        "--folder-uri=vscode-remote://ssh-remote+amd$(realpath -m -- "${1:-$PWD}")"
}
