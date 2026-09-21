#!/usr/bin/env bash
#
# Entrypoint for the bundled vLLM VLM sidecar (the `vlm` service in
# docker-compose.yaml). Runs unchanged on any supported GPU and model:
# defaults adapt to the hardware at startup, and everything else is
# tunable through VLM_* variables -- you should not need to edit this
# file. Model knobs come from the model's env file (vlm-env/<name>.env,
# picked by VLM_CONF in .env); GPU placement (VLM_GPU_IDS) and secrets
# come from .env via the compose service.
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
# TUNABLE (defaults fit Qwen3-VL-4B-Instruct-FP8 on a DEDICATED
# 24 GB-class GPU). All of these live in the model's env file, except
# VLM_GPU_IDS which is deployment placement and lives in .env:
#   VLM_GPU_IDS                  (.env) Pin the sidecar to specific GPU(s),
#                                e.g. "1" or "2,3". Indices match
#                                `nvidia-smi` order. Unset = first visible
#                                GPU (GPU 0), which WSE and VIS also use --
#                                pin this on multi-GPU hosts so they don't
#                                contend.
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
# VLM_MAX_NUM_BATCHED_TOKENS, VLM_MAX_PIXELS / VLM_MIN_PIXELS (Qwen-style
# processor kwargs; no default -- some processors reject them),
# VLM_MAX_IMAGES_PER_PROMPT, and VLM_EXTRA_ARGS (raw passthrough).
#
# HF_TOKEN (higher rate limits on the first-boot weight download) and
# HF_HUB_OFFLINE=1 (skip Hub probes on air-gapped hosts with pre-seeded
# weights) are read by vLLM/HuggingFace directly, not by this script;
# set them in .env (see the `vlm` service in docker-compose.yaml).
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
#
# ── POOL DUTIES (opt-in, OFF by default) ────────────────────────────────
# These exist for a pool of resident engines sharing one GPU, where a
# manager decides which one serves. With NONE of them set this script
# behaves exactly as it always has: it execs `vllm serve` directly.
#   VLM_SLEEP_MODE               "1"/"true" adds --enable-sleep-mode and
#                                exports VLLM_SERVER_DEV_MODE=1, which is
#                                what mounts /sleep, /wake_up and
#                                /is_sleeping. Default off.
#   VLM_LOAD_LOCK_FILE           Path to a lock file on a volume shared by
#                                every engine on the GPU. Held from before
#                                the engine launches until it is ready, so
#                                cold loads serialize instead of claiming
#                                the card at once. Unset = no locking.
#   VLM_HEALTH_TIMEOUT_SECONDS   How long to wait for this engine's own
#                                /health while holding the lock (default
#                                1800). On timeout the lock is released,
#                                the engine is stopped (SIGTERM, then
#                                SIGKILL 10s later) and the container exits
#                                75 so the restart policy retries -- one
#                                wedged engine must not block the pool.
#   VLM_HEALTH_POLL_SECONDS      Interval between /health polls (default 2).
#   VLM_STATE_FILE               Path on the shared volume naming the model
#                                that should be serving (first non-empty
#                                line = a model id). Once healthy, this
#                                engine sleeps unless the file names it --
#                                an absent or unreadable file means sleep,
#                                because several awake engines on one card
#                                is how you OOM it. This script only ever
#                                sleeps itself; waking is the manager's job.
#   VLM_SLEEP_LEVEL              Sleep level for that self-sleep (default 1:
#                                weights to host RAM; 2 discards them).
#
# Setting VLM_LOAD_LOCK_FILE or VLM_STATE_FILE means there is work to do
# after the engine is up, so the engine runs as a child process and this
# script supervises it: SIGTERM/SIGINT are forwarded and the child's exit
# code becomes the container's.
#
# EXIT CODES: 75 health-check timeout (see above), 78 bad configuration
# (reported before the engine launches); anything else is vLLM's own.

set -euo pipefail

# Bump on every edit to this file.
ENTRYPOINT_REVISION="2026-09-21"
echo "[vlm-entrypoint] revision ${ENTRYPOINT_REVISION}"

EXIT_HEALTH_TIMEOUT=75
EXIT_CONFIG=78
# Grace between SIGTERM and SIGKILL when this script stops a wedged engine.
STOP_GRACE_SECONDS=10

MODEL="${VLM_MODEL:-Qwen/Qwen3-VL-4B-Instruct-FP8}"
MAX_MODEL_LEN="${VLM_MAX_MODEL_LEN:-16384}"
GPU_MEM_UTIL="${VLM_GPU_MEMORY_UTILIZATION:-0.90}"
MAX_NUM_BATCHED_TOKENS="${VLM_MAX_NUM_BATCHED_TOKENS:-8192}"
MAX_NUM_SEQS="${VLM_MAX_NUM_SEQS:-auto}"
TENSOR_PARALLEL_SIZE="${VLM_TENSOR_PARALLEL_SIZE:-1}"
# Per-image pixel caps are Qwen-style PROCESSOR kwargs -- other processors
# (e.g. Nemotron's) reject them, so there is no default here; set them in the
# model's env file when its processor supports them.
MIN_PIXELS="${VLM_MIN_PIXELS:-}"
MAX_PIXELS="${VLM_MAX_PIXELS:-}"
MAX_IMAGES="${VLM_MAX_IMAGES_PER_PROMPT:-8}"
PORT="${VLM_PORT:-8000}"

LOAD_LOCK_FILE="${VLM_LOAD_LOCK_FILE:-}"
STATE_FILE="${VLM_STATE_FILE:-}"
HEALTH_TIMEOUT="${VLM_HEALTH_TIMEOUT_SECONDS:-1800}"
HEALTH_POLL="${VLM_HEALTH_POLL_SECONDS:-2}"
SLEEP_LEVEL="${VLM_SLEEP_LEVEL:-1}"

case "${VLM_SLEEP_MODE:-}" in
  1|true|TRUE|yes|YES) SLEEP_MODE=1 ;;
  ''|0|false|FALSE|no|NO) SLEEP_MODE=0 ;;
  *)
    echo "[vlm-entrypoint] VLM_SLEEP_MODE='${VLM_SLEEP_MODE}' is not a boolean." >&2
    exit "${EXIT_CONFIG}"
    ;;
esac

# Self-sleep goes through /sleep, which only exists in dev mode. Refuse the
# combination up front rather than leaving an engine awake that the pool is
# sized for asleep.
if [ -n "${STATE_FILE}" ] && [ "${SLEEP_MODE}" -eq 0 ]; then
  echo "[vlm-entrypoint] VLM_STATE_FILE needs VLM_SLEEP_MODE=1 (the /sleep endpoint)." >&2
  exit "${EXIT_CONFIG}"
fi

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
)

# Processor kwargs only when the model's env file sets pixel caps.
if [ -n "${MIN_PIXELS}" ] || [ -n "${MAX_PIXELS}" ]; then
  MM_KWARGS="{"
  [ -n "${MIN_PIXELS}" ] && MM_KWARGS="${MM_KWARGS}\"min_pixels\": ${MIN_PIXELS}"
  [ -n "${MIN_PIXELS}" ] && [ -n "${MAX_PIXELS}" ] && MM_KWARGS="${MM_KWARGS}, "
  [ -n "${MAX_PIXELS}" ] && MM_KWARGS="${MM_KWARGS}\"max_pixels\": ${MAX_PIXELS}"
  MM_KWARGS="${MM_KWARGS}}"
  ARGS+=("--mm-processor-kwargs=${MM_KWARGS}")
fi

# --max-num-seqs: pin to the value, or omit when "auto" so vLLM sizes it
# to this GPU's KV capacity.
if [ "${MAX_NUM_SEQS}" = "auto" ]; then
  echo "[vlm-entrypoint] VLM_MAX_NUM_SEQS=auto -> letting vLLM derive --max-num-seqs from KV capacity."
else
  ARGS+=(--max-num-seqs="${MAX_NUM_SEQS}")
fi

# Sleep mode is what makes an engine parkable: the process, its compiled
# graphs and its warm state survive, but the GPU memory does not.
if [ "${SLEEP_MODE}" -eq 1 ]; then
  export VLLM_SERVER_DEV_MODE=1
  ARGS+=(--enable-sleep-mode)
  echo "[vlm-entrypoint] VLM_SLEEP_MODE -> --enable-sleep-mode, VLLM_SERVER_DEV_MODE=1."
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

# Nothing to do once the engine is up: hand the container straight to vLLM,
# exactly as this script always has.
if [ -z "${LOAD_LOCK_FILE}" ] && [ -z "${STATE_FILE}" ]; then
  exec vllm serve "${MODEL}" "${ARGS[@]}"
fi

CHILD_PID=""
LOCK_FD=""
TERMINATING=0

# shellcheck disable=SC2329  # invoked from the traps below.
forward_signal() {
  local signal="$1"
  TERMINATING=1
  if [ -n "${CHILD_PID}" ]; then
    kill -s "${signal}" "${CHILD_PID}" 2>/dev/null || true
  fi
}

take_load_lock() {
  [ -n "${LOAD_LOCK_FILE}" ] || return 0
  exec {LOCK_FD}>>"${LOAD_LOCK_FILE}"
  echo "[vlm-entrypoint] waiting for the load lock (${LOAD_LOCK_FILE})..."
  flock -x "${LOCK_FD}"
  echo "[vlm-entrypoint] load lock acquired."
}

# flock also drops when the process dies; releasing explicitly is what lets
# the next engine start while this one keeps serving.
release_load_lock() {
  [ -n "${LOCK_FD}" ] || return 0
  flock -u "${LOCK_FD}"
  exec {LOCK_FD}>&-
  LOCK_FD=""
  echo "[vlm-entrypoint] load lock released."
}

# 0 ready, 1 timed out, 2 the engine exited on its own. Every probe is
# time-boxed: a wedged engine still accepts connections, so an untimed curl
# would wait out the very deadline it is being polled against.
wait_for_health() {
  local deadline=$(( SECONDS + HEALTH_TIMEOUT ))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if [ "${TERMINATING}" -eq 1 ]; then
      return 2
    fi
    if ! kill -0 "${CHILD_PID}" 2>/dev/null; then
      return 2
    fi
    if curl -fs -o /dev/null --connect-timeout 2 --max-time 5 \
        "http://127.0.0.1:${PORT}/health"; then
      return 0
    fi
    sleep "${HEALTH_POLL}"
  done
  return 1
}

read_active_model() {
  [ -r "${STATE_FILE}" ] || return 0
  grep -v '^[[:space:]]*$' "${STATE_FILE}" 2>/dev/null | head -n1 | tr -d '[:space:]'
}

# Sleep unless the state file names this model. An absent, unreadable or
# foreign state file all mean the same thing: this engine is not the one
# that should be holding the card.
maybe_self_sleep() {
  [ -n "${STATE_FILE}" ] || return 0
  local active
  active="$(read_active_model || true)"
  if [ -n "${active}" ] && [ "${active}" = "${MODEL}" ]; then
    echo "[vlm-entrypoint] state file names ${MODEL} -> staying awake."
    return 0
  fi
  echo "[vlm-entrypoint] active model is '${active:-<none>}', not ${MODEL} -> sleeping at level ${SLEEP_LEVEL}."
  local -a auth=()
  if [ -n "${VLLM_API_KEY:-}" ]; then
    auth=(-H "Authorization: Bearer ${VLLM_API_KEY}")
  fi
  if curl -fsS -o /dev/null --connect-timeout 2 --max-time 30 -X POST "${auth[@]}" \
      "http://127.0.0.1:${PORT}/sleep?level=${SLEEP_LEVEL}"; then
    echo "[vlm-entrypoint] asleep."
  else
    echo "[vlm-entrypoint] /sleep failed; this engine stays awake and keeps its GPU memory." >&2
  fi
}

# `wait` returns >128 when a trapped signal interrupts it, so keep waiting
# until the child is really gone; its status is the container's.
await_child() {
  local status=0
  set +e
  wait "${CHILD_PID}"
  status=$?
  while [ "${status}" -gt 128 ] && kill -0 "${CHILD_PID}" 2>/dev/null; do
    wait "${CHILD_PID}"
    status=$?
  done
  set -e
  return "${status}"
}

# A wedged engine may be unable to act on SIGTERM at all, so the watchdog
# guarantees this script still reaches its exit.
stop_child() {
  kill -s TERM "${CHILD_PID}" 2>/dev/null || true
  ( sleep "${STOP_GRACE_SECONDS}"; kill -s KILL "${CHILD_PID}" 2>/dev/null || true ) &
  local watchdog=$!
  await_child || true
  kill "${watchdog}" 2>/dev/null || true
  wait "${watchdog}" 2>/dev/null || true
}

trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

take_load_lock

vllm serve "${MODEL}" "${ARGS[@]}" &
CHILD_PID=$!

health=0
wait_for_health || health=$?

case "${health}" in
  0)
    maybe_self_sleep
    release_load_lock
    ;;
  1)
    echo "[vlm-entrypoint] no /health in ${HEALTH_TIMEOUT}s; releasing the lock and stopping." >&2
    release_load_lock
    stop_child
    exit "${EXIT_HEALTH_TIMEOUT}"
    ;;
  *)
    release_load_lock
    ;;
esac

CHILD_STATUS=0
await_child || CHILD_STATUS=$?
exit "${CHILD_STATUS}"
