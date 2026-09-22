#!/usr/bin/env python3
"""按模型上限分段识别音频并生成 SRT/TXT。"""

import argparse
import json
import subprocess
import tempfile
import urllib.request
from pathlib import Path

CHUNK_SECONDS = 30
SERVICE_URL = "http://127.0.0.1:8001/transcribe"


def timestamp(seconds: float) -> str:
    millis = round(seconds * 1000)
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    seconds, millis = divmod(millis, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def get_duration(audio: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(audio),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout)


def transcribe(audio: Path) -> str:
    request = urllib.request.Request(
        SERVICE_URL,
        data=json.dumps({"audio_path": str(audio)}).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        result = json.load(response)
    if "error" in result:
        raise RuntimeError(result["error"])
    return result["transcript"].strip()


def main() -> None:
    parser = argparse.ArgumentParser(description="生成带时间轴的字幕")
    parser.add_argument("audio", type=Path)
    parser.add_argument("srt", type=Path)
    args = parser.parse_args()

    audio = args.audio.expanduser().resolve(strict=True)
    total = get_duration(audio)
    subtitles: list[str] = []
    transcripts: list[str] = []

    with tempfile.TemporaryDirectory(prefix="qwen-subtitles-") as temp_dir:
        pattern = str(Path(temp_dir) / "%06d.wav")
        subprocess.run(
            [
                "ffmpeg", "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                "-i", str(audio), "-f", "segment",
                "-segment_time", str(CHUNK_SECONDS), "-reset_timestamps", "1",
                "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", pattern,
            ],
            check=True,
        )
        chunks = sorted(Path(temp_dir).glob("*.wav"))
        if not chunks:
            raise RuntimeError("音频没有可识别内容")

        for index, chunk in enumerate(chunks):
            text = transcribe(chunk)
            if text:
                start = index * CHUNK_SECONDS
                end = min((index + 1) * CHUNK_SECONDS, total)
                subtitles.append(
                    f"{len(subtitles) + 1}\n"
                    f"{timestamp(start)} --> {timestamp(end)}\n{text}\n"
                )
                transcripts.append(text)
            print(f"{audio.name}: {index + 1}/{len(chunks)}", flush=True)

    args.srt.parent.mkdir(parents=True, exist_ok=True)
    args.srt.write_text("\n".join(subtitles), encoding="utf-8")
    args.srt.with_suffix(".txt").write_text(" ".join(transcripts), encoding="utf-8")
    print(f"字幕已生成：{args.srt}")


if __name__ == "__main__":
    main()
