#!/usr/bin/env bash
#
# Runs every gated check in order and reports which ones failed. Each check
# cleans up its own containers; they share the state directory, so they run one
# at a time.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

CHECKS=(
  01-supervisor-exit-code.sh
  02-load-lock-serialization.sh
  03-self-sleep-matrix.sh
  04-lock-timeout-recovery.sh
  05-auth-middleware-matrix.sh
)

FAILED=()
for check in "${CHECKS[@]}"; do
  printf '\n===== %s =====\n' "${check}"
  if ! bash "${check}"; then
    FAILED+=("${check}")
  fi
done

printf '\n===== summary =====\n'
if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "all ${#CHECKS[@]} checks passed"
  exit 0
fi
printf 'failed: %s\n' "${FAILED[*]}"
exit 1
