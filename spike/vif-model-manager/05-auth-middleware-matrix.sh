#!/usr/bin/env bash
#
# Phase-0 gate, vif_auth: with VLLM_API_KEY set the dev surface needs the Bearer
# and the open paths do not; /v1 keeps being vLLM's own business. With no key
# the middleware is inert -- the documented keyless posture.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
trap cleanup_containers EXIT

NAME=vif-spike-auth
PORT="${VIF_SPIKE_PORT_A:-18001}"
KEY="${VIF_SPIKE_API_KEY:-spike-key}"
BASE="http://127.0.0.1:${PORT}"
AUTH=(-H "Authorization: Bearer ${KEY}")

reset_state_dir
write_state "${MODEL_A}"           # awake, so /v1 can be exercised for real

engine_start "${NAME}" "${PORT}" "${MODEL_A}" \
  -e VLLM_API_KEY="${KEY}" \
  -e VLM_EXTRA_ARGS="--middleware vif_auth.VifAuthMiddleware"
wait_ready "${NAME}" "${PORT}" || finish

log "--- with a key set"
expect_eq "GET /health, no key"      "200" "$(http_status GET "${BASE}/health")"
expect_eq "GET /ping, no key"        "200" "$(http_status GET "${BASE}/ping")"
expect_eq "GET /metrics, no key"     "200" "$(http_status GET "${BASE}/metrics")"
expect_eq "GET /version, no key"     "200" "$(http_status GET "${BASE}/version")"
expect_eq "GET /is_sleeping, no key" "401" "$(http_status GET "${BASE}/is_sleeping")"
expect_eq "GET /is_sleeping, key"    "200" "$(http_status GET "${BASE}/is_sleeping" "${AUTH[@]}")"
expect_eq "GET /v1/models, key"      "200" "$(http_status GET "${BASE}/v1/models" "${AUTH[@]}")"
expect_eq "GET /v1/models, no key"   "401" "$(http_status GET "${BASE}/v1/models")"

# The rejection must be a rejection, not a 401 after the work happened.
BEFORE="$(is_sleeping "${PORT}" "${AUTH[@]}")"
expect_eq "POST /collective_rpc, no key" "401" \
  "$(http_status POST "${BASE}/collective_rpc" -H 'Content-Type: application/json' -d '{"method":"sleep"}')"
expect_eq "POST /sleep, no key" "401" "$(http_status POST "${BASE}/sleep?level=1")"
expect_eq "is_sleeping unchanged by the rejected calls" "${BEFORE}" "$(is_sleeping "${PORT}" "${AUTH[@]}")"

docker rm -f "${NAME}" >/dev/null 2>&1 || true

log "--- with no key (inert, the documented keyless posture)"
reset_state_dir
write_state "${MODEL_A}"
engine_start "${NAME}" "${PORT}" "${MODEL_A}" \
  -e VLM_EXTRA_ARGS="--middleware vif_auth.VifAuthMiddleware"
wait_ready "${NAME}" "${PORT}" || finish

expect_eq "GET /health, keyless"      "200" "$(http_status GET "${BASE}/health")"
expect_eq "GET /is_sleeping, keyless" "200" "$(http_status GET "${BASE}/is_sleeping")"
expect_eq "GET /v1/models, keyless"   "200" "$(http_status GET "${BASE}/v1/models")"

finish
