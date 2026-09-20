# clipimg

从 Windows 剪贴板取图，加入 Pi 的待发送图片；不修改当前输入，也不自动回车。

## 快捷键

- `Alt+V`：PNG 经 WezTerm 发送，兼容路径。
- `Alt+Shift+V`：PNG 二进制直传，推荐路径。

高速路径会自动识别运行环境：本地直接执行 `clipimg.exe --stdout`；SSH 会话通过 `win-launch` 从 Windows 桌面读取剪贴板。

SSH 模式只需设置 Windows 的 SSH 别名：

```bash
export WIN_SSH_HOST=windows
```

要求：`clipimg.exe` 在 Windows `PATH` 中，`.win-launch.exe --server` 运行于桌面会话。

## 命令

```bash
clipimg PANE_ID   # PNG 经 WezTerm 发送
clipimg --stdout  # 输出 PNG 二进制
```

图片上限约 18 MB；WezTerm base64 路径上限约 24 MB。

## 构建

```bash
cargo build --release --target x86_64-pc-windows-gnu
x86_64-w64-mingw32-gcc -municode -mwindows -Os -s ../win-launch.c \
  -o .win-launch.exe -lshell32
```
