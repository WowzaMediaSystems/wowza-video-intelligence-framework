#!/usr/bin/env bash
#
# Phase-0 gate, lock timeout: a wedged engine must not hold the pool's lock
# forever. SIGSTOP the child so it never answers /health, then assert the
# launcher releases the lock, exits 75, and the restart policy brings the
# container back to a healthy engine.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
trap cleanup_containers EXIT

NAME=vif-spike-wedged
PORT="${VIF_SPIKE_PORT_A:-18001}"
HEALTH_TIMEOUT="${VIF_SPIKE_HEALTH_TIMEOUT:-90}"

reset_state_dir
write_state "${MODEL_A}"

VIF_SPIKE_RESTART=on-failure:2 \
  engine_start "${NAME}" "${PORT}" "${MODEL_A}" \
  -e VLM_HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT}"

log "waiting for the child to appear, then wedging it..."
CHILD_PID=""
DEADLINE=$((SECONDS + 120))
while [ "${SECONDS}" -lt "${DEADLINE}" ]; do
  CHILD_PID="$(engine_child_pid "${NAME}" || true)"
  [ -n "${CHILD_PID}" ] && break
  sleep 2
done
if [ -z "${CHILD_PID}" ]; then
  fail "never saw a supervised child"
  finish
fi
docker exec "${NAME}" kill -STOP "${CHILD_PID}"
log "SIGSTOPped pid ${CHILD_PID}; expecting exit 75 within ~$((HEALTH_TIMEOUT + 30))s"

# The restart policy relaunches it, and `.State.ExitCode` is reset to 0 the
# moment it comes back -- polling it races the restart and usually samples the
# fresh container. Take the code from the daemon's own `die` event instead.
RECORDED="$(timeout "$((HEALTH_TIMEOUT + 90))" docker events \
  --filter "container=${NAME}" --filter 'event=die' \
  --format '{{.Actor.Attributes.exitCode}}' 2>/dev/null | head -n1 || true)"
expect_eq "exit code after the health timeout" "75" "${RECORDED:-<none, never exited>}"

# `grep -q` would exit at the first match, hand `docker logs` a SIGPIPE and make
# the pipeline 141 under lib.sh's `set -o pipefail` -- reported as "not found"
# even when the line is there. `grep -c` consumes the whole stream instead.
if [ "$(docker logs "${NAME}" 2>&1 | grep -c 'load lock released' || true)" != "0" ]; then
  pass "the lock was released before exiting"
else
  fail "no 'load lock released' in the logs -- the lock rode the process down"
fi

log "waiting for the restart policy to produce a healthy engine..."
if wait_ready "${NAME}" "${PORT}"; then
  pass "restarted into a healthy engine (the retry is the promise, not the exit)"
fi

finish
