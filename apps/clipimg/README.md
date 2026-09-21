# clipimg

从 Windows 剪贴板取图，加入 Pi 的待发送图片；不修改当前输入，也不自动回车。

## 快捷键

Pi 扩展原生注册 `Alt+V`，无需配置 WezTerm；图片保存为本地 PNG，不经过终端文本传输。

扩展会自动识别运行环境：本地直接执行 `clipimg.exe --stdout`；SSH 会话通过 `win-launch` 从 Windows 桌面读取剪贴板。

SSH 模式只需设置 Windows 的 SSH 别名：

```bash
export WIN_SSH_HOST=windows
```

要求：`clipimg.exe` 在 Windows `PATH` 中，`.win-launch.exe --server` 运行于桌面会话。

## 命令

```bash
clipimg --stdout  # 输出 PNG 二进制
```

图片上限为 18 MB。

## 构建

```bash
cargo build --release --target x86_64-pc-windows-gnu
x86_64-w64-mingw32-gcc -municode -mwindows -Os -s ../win-launch.c \
  -o .win-launch.exe -lshell32
```
