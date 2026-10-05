# clipimg

从本机剪贴板取图，加入 Pi 的待发送图片；不修改当前输入，也不自动回车。支持 macOS 和 Windows。

## 快捷键

Pi 扩展在 macOS 注册 `Ctrl+V`，Windows 注册 `Alt+V`（也可用 `/clipimg`）。macOS 的 Kitty 需配置 `map ctrl+v send_key ctrl+v`，让按键传给 Pi；`map cmd+v paste_from_clipboard` 保留文本粘贴。其他终端需自行放行该按键。`~/.pi/agent/keybindings.json` 需禁用 Pi 内置的 `app.clipboard.pasteImage`，以免快捷键冲突。图片保存为本地 PNG，不经过终端文本传输。

扩展会自动识别运行环境：macOS 本地运行 `clipimg --output PATH`，Windows 本地运行 `clipimg.exe --output PATH`；SSH 会话通过 `win-launch` 从 Windows 桌面读取剪贴板。

SSH 模式只需设置 Windows 的 SSH 别名：

```bash
export WIN_SSH_HOST=windows
```

要求：`clipimg.exe` 在 Windows `PATH` 中，`.win-launch.exe --server` 运行于桌面会话。

## 命令

```bash
clipimg --stdout           # 输出 PNG 二进制
clipimg --output shot.png  # 保存到指定路径
```

图片上限为 18 MB。

## macOS 安装

```bash
cargo install --path .
```

确保 `~/.cargo/bin` 在 `PATH` 中，重载 Pi 和 Kitty 配置后使用 `/clipimg` 或 `Ctrl+V`。在 macOS 桌面会话运行；`pbpaste` 只处理文本，不能替代本程序读取图片。

## Windows 构建

```bash
cargo build --release --target x86_64-pc-windows-gnu
x86_64-w64-mingw32-gcc -municode -mwindows -Os -s ../win-launch.c \
  -o .win-launch.exe -lshell32
```
