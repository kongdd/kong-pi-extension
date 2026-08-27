# clipimg

从剪贴板取出一张图，送到本机一个小收件箱；再在 WezTerm 里敲 `/clipimg`，让对面自己来取。

截图很大，不宜塞进终端，因此图片只走本机 HTTP；终端仅接收私有控制信号，不会自动回车。

## 日常用法

先让收件箱在跑，再复制图像，然后：

```bash
clipimg "$WEZTERM_PANE"
```

它会：把图 POST 到本机 → 通知当前 pane 自动挂图。已有输入不受影响，也不会立即发送。

另外两个入口：

```bash
clipimg --http    # 只把图送进收件箱，不碰终端
clipimg --serve   # 开收件箱（通常交给 systemd）
```

图片大约超过 18 MB 会拒绝。

发送端通过 `wezterm.exe cli send-text` 把字打进 pane（WSL 调 Windows 上的 WezTerm）。

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

`src/main.rs` 是入口：能走 HTTP 就走 HTTP，否则 base64。其余按事拆开——`cli` 参数，`clipboard` 读剪贴板并编 PNG，`http` 收发，`wezterm` 往 pane 打字并回车。


### 1.3 剪贴板图片

- **`clipimg.ts`** — 注册 `/clipimg`。无参数时从 `http://127.0.0.1:17323/image` GET PNG，挂到待发送队列；`clear [1,2,...]` 删除。扩展本身不监听端口。
- **`clipimg/`** — Rust 收图服务。`clipimg --serve` 监听上述地址（POST 存图、GET 取走）；`clipimg PANE_ID` 读剪贴板后 POST，再以私有控制信号通知对应 pane。地址与口令可用 `CLIPIMG_ADDR`、`CLIPIMG_TOKEN` 覆盖。

```bash
cargo build --release --manifest-path clipimg/Cargo.toml
install -m 755 clipimg/target/release/clipimg ~/.local/bin/clipimg
ln -sfn ~/.pi/agent/clipimg/clipimg.service ~/.config/systemd/user/clipimg.service
systemctl --user daemon-reload
systemctl --user enable --now clipimg
```
