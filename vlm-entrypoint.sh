#!/usr/bin/env bash
#
# Entrypoint for the bundled vLLM VLM sidecar (the `vlm` service in
# docker-compose.yaml). Runs unchanged on any supported GPU: defaults
# adapt to the hardware at startup, and everything else is tunable through
# VLM_* variables in .env -- you should not need to edit this file.
#
# FIXED flags (not overridable) are tuned to the VIS workload -- unique,
# non-repeating video frames with short structured responses:
#   --no-enable-prefix-caching   frames never repeat, so prefix caching
#                                only adds overhead
#   --mm-processor-cache-gb 0    same reason, for the multimodal
#                                preprocessor cache
#
# AUTO-DETECTED at startup:
#   kv-cache dtype               fp8 when every GPU the server uses has
#                                compute capability >= 8.9 (Ada/Hopper or
#                                newer), else "auto" -- fp8 KV cache is
#                                not supported on older GPUs such as
#                                A10G/A100. Set VLM_KV_CACHE_DTYPE to
#                                override.
#
# TUNABLE via .env (defaults fit Qwen3-VL-4B-Instruct-FP8 on a DEDICATED
# 24 GB-class GPU):
#   VLM_GPU_IDS                  Pin the sidecar to specific GPU(s), e.g.
#                                "1" or "2,3". Indices match `nvidia-smi`
#                                order. Unset = first visible GPU (GPU 0),
#                                which WSE and VIS also use -- pin this on
#                                multi-GPU hosts so they don't contend.
#   VLM_TENSOR_PARALLEL_SIZE     Shard the model across N GPUs (default 1).
#   VLM_GPU_MEMORY_UTILIZATION   Fraction of the GPU vLLM reserves
#                                (default 0.90). Best practice: give the
#                                VLM a dedicated GPU via VLM_GPU_IDS and
#                                keep other workloads on other cards; the
#                                ~10% left over still fits a lightweight
#                                object-detection model. Lower it only
#                                when heavier workloads must share the
#                                card.
#   VLM_PORT                     Served port (default 8000). The compose
#                                healthcheck follows it; point your
#                                streams' `endpoint_url` at the same port.
# plus VLM_MODEL, VLM_MAX_MODEL_LEN, VLM_MAX_NUM_SEQS, VLM_KV_CACHE_DTYPE,
# VLM_MAX_NUM_BATCHED_TOKENS, VLM_MAX_PIXELS / VLM_MIN_PIXELS,
# VLM_MAX_IMAGES_PER_PROMPT, and VLM_EXTRA_ARGS (raw passthrough).
#
# HF_TOKEN (higher rate limits on the first-boot weight download) and
# HF_HUB_OFFLINE=1 (skip Hub probes on air-gapped hosts with pre-seeded
# weights) are read by vLLM/HuggingFace directly, not by this script;
# set them in .env like the VLM_* knobs (see the `vlm` service in
# docker-compose.yaml).
#
# SIZING CONCURRENCY: there is no universal "right" --max-num-seqs; vLLM
# computes the real ceiling for your GPU at startup and prints it. Watch
# the boot log for:
#
#   Maximum concurrency for <max_model_len> tokens per request: <Y>x
#
# By default (VLM_MAX_NUM_SEQS=auto) the flag is omitted and vLLM sizes
# the ceiling to your GPU's KV-cache capacity. To pin it instead, set
# VLM_MAX_NUM_SEQS to floor(<Y>) -- useful on a constrained GPU if
# preemptions climb (`vllm:num_preemptions_total`).
#
# Use the same <Y> to size the `max_concurrent_requests` cap in the VIS
# WebSocket VLM config -- vLLM does not expose the ceiling over HTTP, so
# VIS cannot read it automatically.

set -euo pipefail

# Bump on every edit to this file.
ENTRYPOINT_REVISION="2026-06-10"
echo "[vlm-entrypoint] revision ${ENTRYPOINT_REVISION}"

MODEL="${VLM_MODEL:-Qwen/Qwen3-VL-4B-Instruct-FP8}"
MAX_MODEL_LEN="${VLM_MAX_MODEL_LEN:-16384}"
GPU_MEM_UTIL="${VLM_GPU_MEMORY_UTILIZATION:-0.90}"
MAX_NUM_BATCHED_TOKENS="${VLM_MAX_NUM_BATCHED_TOKENS:-8192}"
MAX_NUM_SEQS="${VLM_MAX_NUM_SEQS:-auto}"
TENSOR_PARALLEL_SIZE="${VLM_TENSOR_PARALLEL_SIZE:-1}"
MIN_PIXELS="${VLM_MIN_PIXELS:-3136}"        # 4*28*28
MAX_PIXELS="${VLM_MAX_PIXELS:-401408}"      # 512*28*28 ~= 512 vision tokens/image
MAX_IMAGES="${VLM_MAX_IMAGES_PER_PROMPT:-8}"
PORT="${VLM_PORT:-8000}"

# Pin the sidecar to the GPU(s) named in VLM_GPU_IDS; indices match
# `nvidia-smi` output.
if [ -n "${VLM_GPU_IDS:-}" ]; then
  export CUDA_DEVICE_ORDER=PCI_BUS_ID
  export CUDA_VISIBLE_DEVICES="${VLM_GPU_IDS}"
  echo "[vlm-entrypoint] VLM_GPU_IDS=${VLM_GPU_IDS} -> pinned via CUDA_VISIBLE_DEVICES."
fi

# Log the detected hardware so the startup "Maximum concurrency" line can
# be sanity-checked against it.
if command -v nvidia-smi >/dev/null 2>&1; then
  echo "[vlm-entrypoint] Detected GPU(s):"
  nvidia-smi --query-gpu=index,name,memory.total,compute_cap --format=csv,noheader || true
else
  echo "[vlm-entrypoint] nvidia-smi not found; skipping GPU probe."
fi

# Lowest compute capability among the GPU(s) the server will actually use
# (only the VLM_GPU_IDS-pinned cards, when set).
min_compute_cap() {
  local -a query=(--query-gpu=compute_cap --format=csv,noheader)
  if [ -n "${VLM_GPU_IDS:-}" ]; then
    query=(-i "${VLM_GPU_IDS}" "${query[@]}")
  fi
  nvidia-smi "${query[@]}" 2>/dev/null | sort -t. -k1,1n -k2,2n | head -n1
}

# fp8 KV cache halves KV memory (more concurrency per GB) but is not
# supported on pre-Ada GPUs. Unless VLM_KV_CACHE_DTYPE is set, pick fp8
# only when the hardware supports it.
KV_CACHE_DTYPE="${VLM_KV_CACHE_DTYPE:-}"
if [ -z "${KV_CACHE_DTYPE}" ]; then
  COMPUTE_CAP="$(min_compute_cap || true)"
  if [ -n "${COMPUTE_CAP}" ] && awk -v c="${COMPUTE_CAP}" 'BEGIN { exit !(c + 0 >= 8.9) }'; then
    KV_CACHE_DTYPE="fp8"
    echo "[vlm-entrypoint] compute capability ${COMPUTE_CAP} >= 8.9 -> --kv-cache-dtype fp8."
  else
    KV_CACHE_DTYPE="auto"
    echo "[vlm-entrypoint] compute capability '${COMPUTE_CAP:-unknown}' (< 8.9 or probe failed) -> --kv-cache-dtype auto."
  fi
fi

LIMIT_MM="{\"image\": ${MAX_IMAGES}, \"video\": 0}"
MM_KWARGS="{\"min_pixels\": ${MIN_PIXELS}, \"max_pixels\": ${MAX_PIXELS}}"

ARGS=(
  --port="${PORT}"
  --max-model-len="${MAX_MODEL_LEN}"
  --gpu-memory-utilization="${GPU_MEM_UTIL}"
  --max-num-batched-tokens="${MAX_NUM_BATCHED_TOKENS}"
  --tensor-parallel-size="${TENSOR_PARALLEL_SIZE}"
  --kv-cache-dtype="${KV_CACHE_DTYPE}"
  --no-enable-prefix-caching
  --mm-processor-cache-gb=0
  "--limit-mm-per-prompt=${LIMIT_MM}"
  "--mm-processor-kwargs=${MM_KWARGS}"
)

# --max-num-seqs: pin to the value, or omit when "auto" so vLLM sizes it
# to this GPU's KV capacity.
if [ "${MAX_NUM_SEQS}" = "auto" ]; then
  echo "[vlm-entrypoint] VLM_MAX_NUM_SEQS=auto -> letting vLLM derive --max-num-seqs from KV capacity."
else
  ARGS+=(--max-num-seqs="${MAX_NUM_SEQS}")
fi

# Escape hatch for vLLM flags not exposed above (e.g. --disable-log-requests,
# --quantization). Space-separated; flag values containing spaces cannot be
# passed here.
if [ -n "${VLM_EXTRA_ARGS:-}" ]; then
  set -f
  # shellcheck disable=SC2206
  EXTRA=(${VLM_EXTRA_ARGS})
  set +f
  ARGS+=("${EXTRA[@]}")
fi

echo "[vlm-entrypoint] Launching vLLM with:"
printf '  %s\n' "${MODEL}" "${ARGS[@]}"
echo "[vlm-entrypoint] On startup, find: 'Maximum concurrency for ${MAX_MODEL_LEN} tokens per request: <Y>x'"
echo "[vlm-entrypoint] -> set VLM_MAX_NUM_SEQS to floor(<Y>) to match THIS GPU's KV capacity."

exec vllm serve "${MODEL}" "${ARGS[@]}"
