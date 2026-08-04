# Speech Recognition

Pi 本地语音识别扩展，使用 4-bit Qwen-Audio-Chat。

## 安装

```bash
cd ~/.pi/agent/extensions/speech-recognition
./setup.sh
mkdir -p ~/.config/systemd/user
ln -sfn "$PWD/qwen-audio.service" ~/.config/systemd/user/qwen-audio.service
systemctl --user daemon-reload
systemctl --user enable --now qwen-audio.service
```

若需退出登录后继续运行：

```bash
sudo loginctl enable-linger "$USER"
```

可通过 `QWEN_ASR_ENV`、`HF_HOME` 和 `QWEN_AUDIO_URL` 覆盖默认配置。服务会自动将长音频按 30 秒分段后识别并拼接结果。

## 使用

```text
/asr /path/audio.wav
/asr-srt /path/audio.wav [/path/output.srt]
```

识别结果会填入 Pi 输入框。`/asr-srt` 自动按 30 秒分段并生成 `.srt` 和 `.txt`。LLM 也可调用 `speech_recognize` 工具；提供 `reference_path` 时同时计算 CER。

## 文件

- `index.ts`：Pi extension
- `server.py`：仅监听 `127.0.0.1:8001` 的推理服务
- `subtitles.py`：分段识别并生成 SRT/TXT
- `qwen-audio.service`：user systemd 示例与实际配置
- `setup.sh`：环境安装
- `run.sh`：服务入口

执行 `/reload` 加载扩展。
