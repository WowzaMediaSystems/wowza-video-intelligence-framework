#!/usr/bin/env bash
#
# Shared helpers for the Model Manager spike checks. Sourced, not run.

set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SPIKE_DIR}/../.." && pwd)"

IMAGE="${VIF_SPIKE_IMAGE:-vllm/vllm-openai:v0.26.0}"
# shellcheck disable=SC2034  # read by the checks that source this file.
MODEL_A="${VIF_SPIKE_MODEL_A:-Qwen/Qwen3-VL-4B-Instruct-FP8}"
# shellcheck disable=SC2034  # read by the checks that source this file.
MODEL_B="${VIF_SPIKE_MODEL_B:-Qwen/Qwen3-VL-4B-Instruct-FP8}"
GPUS="${VIF_SPIKE_GPUS:-all}"
STATE_DIR="${VIF_SPIKE_STATE_DIR:-/tmp/vif-spike-state}"
HF_CACHE="${VIF_SPIKE_HF_CACHE:-${HOME}/.cache/huggingface}"
# The launcher defaults to 0.90, which on a 46 GB card leaves no room for a
# second engine beside a sleeping one (a sleeper still holds ~1.5 GiB of cumem
# pool). The pool checks need both engines resident, so size them like the
# shipped profiles do.
UTILIZATION="${VIF_SPIKE_UTILIZATION:-0.80}"
READY_TIMEOUT="${VIF_SPIKE_READY_TIMEOUT:-900}"
# dist-packages of the pinned image; --middleware resolves vif_auth from here.
SITE_PACKAGES="${VIF_SPIKE_SITE_PACKAGES:-/usr/local/lib/python3.12/dist-packages}"

CHECK_NAME="$(basename "${0}" .sh)"
FAILURES=0
CONTAINERS=()

log() { printf '[%s] %s\n' "${CHECK_NAME}" "$*"; }
pass() { printf '[%s] PASS  %s\n' "${CHECK_NAME}" "$*"; }
fail() { printf '[%s] FAIL  %s\n' "${CHECK_NAME}" "$*" >&2; FAILURES=$((FAILURES + 1)); }

expect_eq() {
  local what="$1" expected="$2" actual="$3"
  if [ "${expected}" = "${actual}" ]; then
    pass "${what} = ${actual}"
  else
    fail "${what}: expected ${expected}, got ${actual}"
  fi
}

cleanup_containers() {
  local name
  for name in "${CONTAINERS[@]:-}"; do
    [ -n "${name}" ] || continue
    docker rm -f "${name}" >/dev/null 2>&1 || true
  done
}

reset_state_dir() {
  rm -rf "${STATE_DIR}"
  mkdir -p "${STATE_DIR}"
}

write_state() {
  printf '%s\n' "$1" > "${STATE_DIR}/active-model"
}

clear_state() {
  rm -f "${STATE_DIR}/active-model"
}

# engine_start <name> <host-port> <model> [extra `docker run` args...]
# Brings up one engine with the pool duties enabled, the launcher and the auth
# middleware bind-mounted from this checkout.
engine_start() {
  local name="$1" port="$2" model="$3"
  shift 3
  CONTAINERS+=("${name}")
  docker rm -f "${name}" >/dev/null 2>&1 || true
  docker run -d --name "${name}" \
    --gpus "${GPUS}" --ipc=host \
    --restart="${VIF_SPIKE_RESTART:-no}" \
    -p "${port}:8000" \
    -v "${REPO_ROOT}/vlm-entrypoint.sh:/vlm-entrypoint.sh:ro" \
    -v "${REPO_ROOT}/vif-vlm-launcher.py:/vif-vlm-launcher.py:ro" \
    -v "${REPO_ROOT}/vlm-patches/vif_auth.py:${SITE_PACKAGES}/vif_auth.py:ro" \
    -v "${STATE_DIR}:/vif-state" \
    -v "${HF_CACHE}:/root/.cache/huggingface" \
    -e VLM_MODEL="${model}" \
    -e VLM_GPU_MEMORY_UTILIZATION="${UTILIZATION}" \
    -e VLM_SLEEP_MODE=1 \
    -e VLM_LOAD_LOCK_FILE=/vif-state/load.lock \
    -e VLM_STATE_FILE=/vif-state/active-model \
    -e HF_TOKEN="${HF_TOKEN:-}" \
    "$@" \
    --entrypoint /bin/bash "${IMAGE}" /vlm-entrypoint.sh >/dev/null
  log "started ${name} (${model}) on :${port}"
}

# engine_key <model id> -- the filesystem-safe key VIS and the launcher share.
engine_key() {
  python3 -c 'import re,sys; print(re.sub(r"[^a-z0-9]+", "-", sys.argv[1].lower()).strip("-"))' "$1"
}

# write_spec <model> <desired state> [sleep mode: true|false] [load lock file]
# The engine spec VIS would write, rendered from the same values the legacy env
# path resolves. Written through a rename, as VIS writes it.
write_spec() {
  local model="$1" desired="$2" sleep_mode="${3:-true}" lock="${4:-}"
  mkdir -p "${STATE_DIR}/engines"
  SPEC_MODEL="${model}" SPEC_DESIRED="${desired}" SPEC_SLEEP="${sleep_mode}"   SPEC_LOCK="${lock}" SPEC_UTILIZATION="${UTILIZATION}" SPEC_DIR="${STATE_DIR}"   python3 - <<'PYTHON'
import json, os, re

model = os.environ["SPEC_MODEL"]
desired = os.environ["SPEC_DESIRED"]
sleep_mode = os.environ["SPEC_SLEEP"] == "true"
lock = os.environ["SPEC_LOCK"] or None
key = re.sub(r"[^a-z0-9]+", "-", model.lower()).strip("-")

args = [
    "--port=8000",
    f"--served-model-name={model}",
    "--max-model-len=16384",
    f"--gpu-memory-utilization={os.environ['SPEC_UTILIZATION']}",
    "--max-num-batched-tokens=8192",
    "--tensor-parallel-size=1",
    "--kv-cache-dtype=auto",
    "--no-enable-prefix-caching",
    "--mm-processor-cache-gb=0",
    '--limit-mm-per-prompt={"image": 8, "video": 0}',
]
env = {}
if sleep_mode:
    args.append("--enable-sleep-mode")
    env["VLLM_SERVER_DEV_MODE"] = "1"

document = {
    "spec_version": 1,
    "catalog_id": model,
    "model": model,
    "served_model_name": model,
    "port": 8000,
    "args": args,
    "env": env,
    "sleep_mode": sleep_mode,
    "sleep_level": 1,
    "active": desired == "awake",
    "desired_state": desired,
    "gpu_ids": None,
    "tensor_parallel_size": 1,
    "tuning_tier": "compact",
    "load_lock_file": lock,
    "health_timeout_seconds": 1800,
    "generated_by": "spike",
    "generated_at": "2026-09-22T00:00:00Z",
}
directory = os.path.join(os.environ["SPEC_DIR"], "engines")
path = os.path.join(directory, f"{key}.json")
temporary = f"{path}.tmp"
with open(temporary, "w", encoding="utf-8") as handle:
    json.dump(document, handle, indent=2)
    handle.write("\n")
os.replace(temporary, path)
PYTHON
}

# engine_start_spec <name> <host-port> <model> [extra `docker run` args...]
# The managed path: the engine takes everything from the spec on the state
# volume, and keeps following it (the watch loop) for as long as it runs.
engine_start_spec() {
  local name="$1" port="$2" model="$3"
  shift 3
  CONTAINERS+=("${name}")
  docker rm -f "${name}" >/dev/null 2>&1 || true
  docker run -d --name "${name}" \
    --gpus "${GPUS}" --ipc=host \
    --restart="${VIF_SPIKE_RESTART:-no}" \
    -p "${port}:8000" \
    -v "${REPO_ROOT}/vlm-entrypoint.sh:/vlm-entrypoint.sh:ro" \
    -v "${REPO_ROOT}/vif-vlm-launcher.py:/vif-vlm-launcher.py:ro" \
    -v "${REPO_ROOT}/vlm-patches/vif_auth.py:${SITE_PACKAGES}/vif_auth.py:ro" \
    -v "${STATE_DIR}:/vif-state" \
    -v "${HF_CACHE}:/root/.cache/huggingface" \
    -e VIF_STATE_DIR=/vif-state \
    -e VLM_MODEL="${model}" \
    -e HF_TOKEN="${HF_TOKEN:-}" \
    "$@" \
    --entrypoint /bin/bash "${IMAGE}" /vlm-entrypoint.sh >/dev/null
  log "started ${name} (${model}) on :${port}, following its spec"
}

# engine_has_child <name> -- "yes" when a supervised `vllm serve` is running.
engine_has_child() {
  if docker exec "$1" bash -c 'pgrep -f "vllm[ ]serve" >/dev/null'; then
    printf 'yes'
  else
    printf 'no'
  fi
}

# wait_parked <name> <host-port> -- the stub answering in place of an engine.
wait_parked() {
  local name="$1" port="$2" deadline=$((SECONDS + 120))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if [ "$(http_status GET "http://127.0.0.1:${port}/vif/parked")" = "200" ]; then
      return 0
    fi
    sleep 2
  done
  fail "${name} did not park within 120s"
  return 1
}

# engine_child_pid <name> -- the `vllm serve` process the launcher supervises.
# The pattern is bracketed so it cannot match the `bash -c` wrapper running it:
# in a pipeline bash forks and keeps a command line containing the pattern, and
# `head -n1` would then return that transient pid, which is gone by the time the
# caller signals it.
engine_child_pid() {
  docker exec "$1" bash -c 'pgrep -f "vllm[ ]serve" | head -n1'
}

container_state() { docker inspect --format '{{.State.Status}}' "$1"; }
container_exit_code() { docker inspect --format '{{.State.ExitCode}}' "$1"; }

# wait_ready <name> <host-port> -- the launcher's own readiness signal, which
# is the point at which it releases the load lock.
wait_ready() {
  local name="$1" port="$2" deadline=$((SECONDS + READY_TIMEOUT))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if [ "$(container_state "${name}")" != "running" ]; then
      fail "${name} exited while loading (exit $(container_exit_code "${name}"))"
      return 1
    fi
    if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:${port}/health"; then
      return 0
    fi
    sleep 2
  done
  fail "${name} was not ready within ${READY_TIMEOUT}s"
  return 1
}

# wait_exited <name> <timeout>
wait_exited() {
  local name="$1" timeout="$2"
  local deadline=$((SECONDS + timeout))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    [ "$(container_state "${name}")" = "exited" ] && return 0
    sleep 1
  done
  fail "${name} was still $(container_state "${name}") after ${timeout}s"
  return 1
}

# http_status <method> <url> [curl args...]
http_status() {
  local method="$1" url="$2"
  shift 2
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X "${method}" "$@" "${url}"
}

is_sleeping() {
  local port="$1"
  shift
  curl -fsS --max-time 15 "$@" "http://127.0.0.1:${port}/is_sleeping" \
    | python3 -c 'import json,sys; print(str(json.load(sys.stdin)["is_sleeping"]).lower())'
}

finish() {
  cleanup_containers
  if [ "${FAILURES}" -eq 0 ]; then
    log "all checks passed"
    exit 0
  fi
  log "${FAILURES} check(s) failed"
  exit 1
}
