#!/usr/bin/env bash
#
# Phase-0 gate, self-sleep: an engine parks itself unless the state file names
# it. Absent state and foreign state both mean sleep -- the default that keeps N
# engines from claiming one card. The launcher never wakes anything.

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

finish
