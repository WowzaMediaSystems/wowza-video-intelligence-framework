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
