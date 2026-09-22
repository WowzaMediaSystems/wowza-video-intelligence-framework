#!/usr/bin/env bash
#
# Phase-0 gate, standing down: an engine stands down unless it is the one that
# should be serving. Absent state and foreign state both mean stand down -- the
# default that keeps N engines from claiming one card.
#
# Two halves, and two depths. The LEGACY half reads the state file and puts the
# engine to SLEEP: its weights move to host RAM and the process stays. The
# MANAGED half reads a spec and follows it between all three desired states,
# including PARKED -- the cold tier, no engine process at all, with the launcher
# answering /health so the container stays healthy.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
trap cleanup_containers EXIT

NAME=vif-spike-selfsleep
PORT="${VIF_SPIKE_PORT_A:-18001}"

check_case() {
  local label="$1" expected="$2"
  engine_start "${NAME}" "${PORT}" "${MODEL_A}"
  wait_ready "${NAME}" "${PORT}" || return 1
  # /health is 200 for a sleeping engine, so give the self-sleep POST a moment.
  sleep 5
  expect_eq "${label}: is_sleeping" "${expected}" "$(is_sleeping "${PORT}")"
  expect_eq "${label}: /health" "200" "$(http_status GET "http://127.0.0.1:${PORT}/health")"
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
}

reset_state_dir

clear_state
check_case "state absent" "true"

write_state "definitely/not-this-model"
check_case "state names another model" "true"

write_state "${MODEL_A}"
check_case "state names this model" "false"

# ── the managed half: the spec's desired state, and the cold tier ───────────

NAME_SPEC=vif-spike-desired-state
reset_state_dir

# COLD from the start: no engine process, and a container that stays healthy.
write_spec "${MODEL_A}" parked
engine_start_spec "${NAME_SPEC}" "${PORT}" "${MODEL_A}"
if wait_parked "${NAME_SPEC}" "${PORT}"; then
  expect_eq "parked: /health" "200" "$(http_status GET "http://127.0.0.1:${PORT}/health")"
  expect_eq "parked: /vif/parked" "200" "$(http_status GET "http://127.0.0.1:${PORT}/vif/parked")"
  expect_eq "parked: /is_sleeping" "404" "$(http_status GET "http://127.0.0.1:${PORT}/is_sleeping")"
  expect_eq "parked: engine process" "no" "$(engine_has_child "${NAME_SPEC}")"
fi

# parked -> awake: the watch loop cold-starts the engine, nobody restarts it.
write_spec "${MODEL_A}" awake
if wait_ready "${NAME_SPEC}" "${PORT}"; then
  sleep 5
  expect_eq "unparked: is_sleeping" "false" "$(is_sleeping "${PORT}")"
  expect_eq "unparked: /vif/parked" "404" "$(http_status GET "http://127.0.0.1:${PORT}/vif/parked")"
  expect_eq "unparked: engine process" "yes" "$(engine_has_child "${NAME_SPEC}")"
  # The log tee: VIS reads this file to show engine logs without a Docker socket.
  key="$(engine_key "${MODEL_A}")"
  if [ -s "${STATE_DIR}/logs/${key}.log" ]; then
    pass "unparked: engine log teed to logs/${key}.log"
  else
    fail "unparked: logs/${key}.log is empty or missing"
  fi
fi

# awake -> asleep: the hot tier, in host RAM.
write_spec "${MODEL_A}" asleep
sleep 10
expect_eq "asleep: is_sleeping" "true" "$(is_sleeping "${PORT}")"
expect_eq "asleep: engine process" "yes" "$(engine_has_child "${NAME_SPEC}")"

# asleep -> parked: the process goes, and with it the host RAM it held.
write_spec "${MODEL_A}" parked
if wait_parked "${NAME_SPEC}" "${PORT}"; then
  expect_eq "re-parked: engine process" "no" "$(engine_has_child "${NAME_SPEC}")"
  expect_eq "re-parked: /health" "200" "$(http_status GET "http://127.0.0.1:${PORT}/health")"
fi
docker rm -f "${NAME_SPEC}" >/dev/null 2>&1 || true

# Capability beats configuration: asked to sleep without a /sleep endpoint, the
# engine parks instead of staying awake on a card it was not given.
reset_state_dir
write_spec "${MODEL_A}" asleep false
engine_start_spec "${NAME_SPEC}" "${PORT}" "${MODEL_A}"
if wait_parked "${NAME_SPEC}" "${PORT}"; then
  expect_eq "no sleep mode: engine process" "no" "$(engine_has_child "${NAME_SPEC}")"
fi

finish
