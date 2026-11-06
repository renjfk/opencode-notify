#!/usr/bin/env bash
# Runs the opencode-notify e2e suite against a real OpenAI-compatible endpoint.
#
# Usage:
#   e2e/run.sh                 # run every scenario
#   e2e/run.sh 10 12           # run scenarios whose name contains any argument
#   E2E_KEEP=1 e2e/run.sh 10   # keep the throwaway HOME for inspection
#   E2E_DEBUG=1 e2e/run.sh 10  # dump registry/tab strip/tab names on failure
#
# Requires the API key named by $E2E_API_KEY_ENV to be present in the
# environment. The Zellij scenarios run only in the container (npm run e2e:docker).

set -uo pipefail

if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
    echo "e2e/run.sh requires bash 4+ (found ${BASH_VERSION:-unknown}); use the container (npm run e2e:docker) or a newer bash" >&2
    exit 2
fi

E2E_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIO_DIR="$E2E_ROOT/scenarios"

if [ -t 1 ]; then
    C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_BLD=$'\033[1m'; C_DIM=$'\033[2m'
else
    C_RESET=""; C_RED=""; C_GRN=""; C_YLW=""; C_BLD=""; C_DIM=""
fi

E2E_API_KEY_ENV="${E2E_API_KEY_ENV:-E2E_API_KEY}"
missing=""
[ -n "${E2E_ENDPOINT:-}" ] || missing="E2E_ENDPOINT"
[ -n "${E2E_MODEL:-}" ] || missing="${missing:+$missing, }E2E_MODEL"
[ -n "${!E2E_API_KEY_ENV:-}" ] || missing="${missing:+$missing, }$E2E_API_KEY_ENV"
if [ -n "$missing" ]; then
    printf '%s\n' "${C_YLW}warning:${C_RESET} not set: $missing; scenarios will be skipped" >&2
fi

ALL_SCENARIOS=()
while IFS= read -r f; do
    ALL_SCENARIOS+=("$f")
done < <(find "$SCENARIO_DIR" -maxdepth 1 -name '*.sh' | sort)
[ "${#ALL_SCENARIOS[@]}" -gt 0 ] || { echo "no scenarios found in $SCENARIO_DIR" >&2; exit 1; }

SELECTED=()
if [ "$#" -gt 0 ]; then
    for s in "${ALL_SCENARIOS[@]}"; do
        for filter in "$@"; do
            case "$s" in *"$filter"*) SELECTED+=("$s"); break ;; esac
        done
    done
else
    SELECTED=("${ALL_SCENARIOS[@]}")
fi

pass=0; fail=0; skip=0
failed_names=()

for scenario in "${SELECTED[@]}"; do
    name="$(basename "$scenario")"
    printf '%s\n' "${C_BLD}▶ $name${C_RESET}" >&2
    log="$(mktemp)"
    start=$(date +%s)
    if bash "$scenario" >"$log" 2>&1; then
        # A scenario exits 0 for both PASS and SKIP; distinguish via output.
        if grep -q 'SKIP' "$log"; then
            skip=$((skip + 1))
        else
            pass=$((pass + 1))
        fi
        perl -pe 's/^/  /' "$log" >&2
    else
        fail=$((fail + 1))
        failed_names+=("$name")
        printf '%s\n' "${C_RED}  scenario failed${C_RESET}" >&2
        perl -pe 's/^/  /' "$log" >&2
    fi
    rm -f "$log"
    printf '%s\n\n' "${C_DIM}  ($(( $(date +%s) - start ))s)${C_RESET:-}" >&2
done

printf '%s\n' "${C_BLD}summary:${C_RESET} ${C_GRN}$pass passed${C_RESET}, ${C_RED}$fail failed${C_RESET}, ${C_YLW}$skip skipped${C_RESET}" >&2
if [ "$fail" -gt 0 ]; then
    printf 'failed: %s\n' "${failed_names[*]}" >&2
    exit 1
fi
exit 0
