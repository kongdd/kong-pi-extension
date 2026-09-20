# clipimg

从客户端剪贴板取图，通过 WezTerm 私有帧发送给远端扩展；不修改当前输入，也不自动回车。

默认把 PNG 编成 base64 发送；HTTP 收件箱仅通过 `--http` / `--serve` 使用。

## 日常用法

在客户端复制图像，然后：

```bash
clipimg "$WEZTERM_PANE"
```

它会：把图编成 base64，发送给扩展并加入待发送图片；你可继续修改文字，最后手动回车。

另外三个入口：

```bash
clipimg --http    # 只把图送进收件箱，不碰终端
clipimg --serve   # 开收件箱（通常交给 systemd）
clipimg --stdout  # 输出 PNG，供 win-launch 经 SSH 回传
```

图片大约超过 18 MB 会拒绝；base64 数据上限约 24 MB。

发送端通过 `wezterm.exe cli send-text` 把字打进 pane（WSL 调 Windows 上的 WezTerm）。

`Alt+Shift+V` 是高速路径：本地 Pi 直接调用 `clipimg.exe --stdout`；SSH 会话通过复用连接调用 Windows 桌面中的 `win-launch --clipboard`。两者都直接保存 PNG，不再经终端传输 base64。

SSH 模式只需配置 Windows 的 SSH 别名：

```bash
export WIN_SSH_HOST=windows
```

其中 `clipimg.exe` 须在 Windows `PATH` 中，`.win-launch.exe --server` 须运行在桌面会话。

## 收件箱

本机监听 `127.0.0.1:17323`，只接受 `/image`，一次只存一张：新的覆盖旧的，取走即空。

- 发送：`POST /image`，正文是 PNG
- 取图：`GET /image`

可选环境变量：

- `CLIPIMG_ADDR` — 改监听/连接地址
- `CLIPIMG_TOKEN` — 口令；两边设成一样。请求头为 `X-Clipimg-Token`

## 安装

```bash
cargo build --release
cp target/release/clipimg ~/.local/bin/
systemctl --user enable --now clipimg.service
```

`clipimg.service` 会启动 `~/.local/bin/clipimg --serve`，挂了会自行拉起。

## 代码

`src/main.rs` 是入口：默认发送 base64 私有帧，`--http` 才走 HTTP。其余按事拆开——`cli` 参数，`clipboard` 读剪贴板并编 PNG，`http` 收发，`wezterm` 发送私有帧。


### 1.3 剪贴板图片

- **`clipimg.ts`** — 注册 `/clipimg`。无参数时从 `http://127.0.0.1:17323/image` GET PNG，挂到待发送队列；`clear [1,2,...]` 删除。扩展本身不监听端口。
- **`clipimg/`** — Rust 收图服务。`clipimg --serve` 监听上述地址；`clipimg PANE_ID` 默认用 base64 私有帧发送。地址与口令可用 `CLIPIMG_ADDR`、`CLIPIMG_TOKEN` 覆盖。

```bash
cargo build --release --manifest-path clipimg/Cargo.toml
install -m 755 clipimg/target/release/clipimg ~/.local/bin/clipimg
ln -sfn ~/.pi/agent/clipimg/clipimg.service ~/.config/systemd/user/clipimg.service
systemctl --user daemon-reload
systemctl --user enable --now clipimg
```
