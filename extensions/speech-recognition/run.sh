#!/usr/bin/env bash
set -euo pipefail

readonly env=${QWEN_ASR_ENV:-$HOME/.conda/envs/qwen-audio}
export HF_HOME=${HF_HOME:-$HOME/models/huggingface}
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

exec "$env/bin/python" server.py
