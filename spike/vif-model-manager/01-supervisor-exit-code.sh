#!/usr/bin/env bash
#
# Phase-0 gate, supervisor: `docker stop` must reach the vLLM child through the
# launcher and come back as a clean exit -- not a SIGKILL at the daemon's grace.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
trap cleanup_containers EXIT

NAME=vif-spike-supervisor
PORT="${VIF_SPIKE_PORT_A:-18001}"

reset_state_dir
write_state "${MODEL_A}"          # stay awake: this check is about signals only
engine_start "${NAME}" "${PORT}" "${MODEL_A}"
wait_ready "${NAME}" "${PORT}" || finish

CHILD_PID="$(engine_child_pid "${NAME}")"
log "supervised child pid ${CHILD_PID}"
if [ -z "${CHILD_PID}" ]; then
  fail "no supervised 'vllm serve' child -- the launcher took the exec path"
  finish
fi

log "docker stop (10s grace)..."
STARTED="${SECONDS}"
docker stop --timeout 10 "${NAME}" >/dev/null
ELAPSED=$((SECONDS - STARTED))

expect_eq "exit code" "0" "$(container_exit_code "${NAME}")"
if [ "${ELAPSED}" -lt 10 ]; then
  pass "stopped in ${ELAPSED}s, before the 10s SIGKILL"
else
  fail "took ${ELAPSED}s -- the daemon's SIGKILL, not a forwarded SIGTERM"
fi

docker logs "${NAME}" 2>&1 | tail -20
finish
