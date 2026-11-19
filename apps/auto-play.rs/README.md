# audio-play

播放本地 MP3 的命令行工具。使用 Rust 和 `rodio`，无需外部播放器；播完自动退出。

## Windows

安装 Rust（MSVC 工具链）和 Visual Studio C++ Build Tools，在 `apps/auto-play.rs` 目录运行：

```powershell
cargo build --release --locked
.\target\release\audio-play.exe ".\示例 音频.mp3"
```

将 `target\release\audio-play.exe` 复制到用户或系统 `PATH` 中的目录，重启 Pi。Friday 会从继承的 `PATH` 中查找它，无需额外配置。
