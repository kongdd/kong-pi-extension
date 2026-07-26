#!/usr/bin/env bash
set -euo pipefail

readonly env=${QWEN_ASR_ENV:-$HOME/.conda/envs/qwen-audio}
readonly conda=${CONDA_EXE:-/opt/miniforge3/bin/conda}

if [[ ! -x "$env/bin/python" ]]; then
  "$conda" create -y -p "$env" python=3.11
fi

"$env/bin/python" -m pip install -U pip 'setuptools<81'
"$env/bin/python" -m pip install \
  torch==2.7.1 torchvision==0.22.1 \
  --index-url https://download.pytorch.org/whl/cu128
"$env/bin/python" -m pip install \
  'transformers==4.32.0' 'accelerate==0.21.0' bitsandbytes \
  tiktoken einops 'transformers_stream_generator==0.0.4' scipy matplotlib
