#!/usr/bin/env python3
import json
import re
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from transformers.generation import GenerationConfig

MODEL = "Qwen/Qwen-Audio-Chat"
HOST = "127.0.0.1"
PORT = 8001
PROMPT = "请逐字转写该音频，只输出转写文本，不要解释。"
CHUNK_SECONDS = 30


def load_model():
    tokenizer = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL,
        device_map="auto",
        trust_remote_code=True,
        low_cpu_mem_usage=True,
        torch_dtype=torch.bfloat16,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
        ),
    ).eval()
    model.generation_config = GenerationConfig.from_pretrained(MODEL, trust_remote_code=True)
    return model, tokenizer


model, tokenizer = load_model()


def transcribe_chunk(path):
    query = tokenizer.from_list_format([
        {"audio": str(path)},
        {"text": PROMPT},
    ])
    with torch.inference_mode():
        response, _ = model.chat(tokenizer, query=query, history=None)
    match = re.search(r'[“"]([^”"]+)[”"]', response)
    return match.group(1).strip() if match else response.strip()


def transcribe(path):
    audio = Path(path).expanduser().resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="qwen-asr-") as temp_dir:
        pattern = str(Path(temp_dir) / "%06d.wav")
        subprocess.run(
            [
                "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                "-i", str(audio), "-f", "segment",
                "-segment_time", str(CHUNK_SECONDS), "-reset_timestamps", "1",
                "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", pattern,
            ],
            check=True,
        )
        chunks = sorted(Path(temp_dir).glob("*.wav"))
        if not chunks:
            raise ValueError("音频没有可识别内容")
        return "".join(transcribe_chunk(chunk) for chunk in chunks)


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send_json(200, {"status": "ok"}) if self.path == "/health" else self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self.send_json(404, {"error": "not found"})
            return
        try:
            size = int(self.headers.get("content-length", "0"))
            request = json.loads(self.rfile.read(size))
            self.send_json(200, {"transcript": transcribe(request["audio_path"])})
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def log_message(self, fmt, *args):
        return


HTTPServer((HOST, PORT), Handler).serve_forever()
