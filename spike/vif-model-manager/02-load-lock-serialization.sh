#!/usr/bin/env bash
#
# Phase-0 gate, load lock: two engines starting at once on one GPU must load one
# after the other. The assert is on the log timestamps -- the second engine's
# weight load starts only after the first reports ready.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
trap cleanup_containers EXIT

NAME_A=vif-spike-lock-a
NAME_B=vif-spike-lock-b
PORT_A="${VIF_SPIKE_PORT_A:-18001}"
PORT_B="${VIF_SPIKE_PORT_B:-18002}"

reset_state_dir
clear_state                        # both sleep once ready; neither is active

engine_start "${NAME_A}" "${PORT_A}" "${MODEL_A}"
engine_start "${NAME_B}" "${PORT_B}" "${MODEL_B}"

wait_ready "${NAME_A}" "${PORT_A}" || finish
wait_ready "${NAME_B}" "${PORT_B}" || finish

# docker logs -t prefixes RFC3339 timestamps; both engines log to the same clock.
# The logs are captured first: piping `docker logs` straight into `grep -m1` makes
# grep exit early, `docker logs` take SIGPIPE, and lib.sh's `set -e -o pipefail`
# abort the whole check with 141 before a single assertion runs.
first_match() {
  local logs
  logs="$(docker logs -t "$1" 2>&1)" || true
  printf '%s\n' "${logs}" | grep -m1 -- "$2" | awk '{print $1}' || true
}

A_RELEASED="$(first_match "${NAME_A}" 'load lock released')"
B_WAITING="$(first_match "${NAME_B}" 'waiting for the load lock')"
B_ACQUIRED="$(first_match "${NAME_B}" 'load lock acquired')"
B_LOADING="$(first_match "${NAME_B}" 'Loading weights')"

log "A released ${A_RELEASED:-<none>} | B waiting ${B_WAITING:-<none>} acquired ${B_ACQUIRED:-<none>} loading ${B_LOADING:-<none>}"

if [ -z "${B_WAITING}" ]; then
  fail "B never waited for the lock -- it was free, so nothing was serialized"
elif [[ "${B_ACQUIRED}" > "${A_RELEASED}" ]]; then
  pass "B acquired the lock after A released it"
else
  fail "B acquired the lock at ${B_ACQUIRED}, before A released it at ${A_RELEASED}"
fi

if [ -n "${B_LOADING}" ] && [[ "${B_LOADING}" > "${A_RELEASED}" ]]; then
  pass "B started loading weights after A was ready"
else
  fail "B loaded weights at ${B_LOADING:-<none>}, not after A's ${A_RELEASED}"
fi

finish
