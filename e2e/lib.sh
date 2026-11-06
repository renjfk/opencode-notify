#!/usr/bin/env bash
# Shared helpers for opencode-notify e2e scenarios.
#
# A scenario is a bash script that sources this file and exits non-zero on
# failure. Scenarios run the real OpenCode V2 CLI with the plugin under test
# loaded, against a real OpenAI-compatible endpoint; nothing is mocked. Turns
# are steered with explicit prompts, and assertions check observable side
# effects: Zellij tab names (the blink marker), OpenCode's persisted state, and
# the plugin's shared instance registry.

set -uo pipefail

E2E_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_REPO="$(cd "$E2E_ROOT/.." && pwd)"
E2E_OPENCODE="${E2E_OPENCODE_BIN:-opencode}"
E2E_PLUGIN_DIR="${E2E_PLUGIN_DIR:-$E2E_REPO}"

# Endpoint and model are required and have no committed defaults, so the suite
# never hardcodes an internal host. Provide them via the environment, e.g.
#   export E2E_ENDPOINT=https://your-endpoint/v1
#   export E2E_MODEL=your-model
#   export E2E_API_KEY=...            # or set E2E_API_KEY_ENV to your var name
E2E_ENDPOINT="${E2E_ENDPOINT:-}"
E2E_MODEL="${E2E_MODEL:-}"
E2E_API_KEY_ENV="${E2E_API_KEY_ENV:-E2E_API_KEY}"
E2E_PROVIDER_PACKAGE="${E2E_PROVIDER_PACKAGE:-aisdk:@ai-sdk/openai-compatible}"

# Seconds: one model turn, and readiness waits.
E2E_TURN_TIMEOUT="${E2E_TURN_TIMEOUT:-120}"
E2E_TIMEOUT="${E2E_TIMEOUT:-60}"
E2E_KEEP="${E2E_KEEP:-0}"

# Point tui-test at the suite's config regardless of the current directory.
export TUI_TEST_CONFIG="$E2E_ROOT/tui-test.toml"

# --- logging -----------------------------------------------------------------
if [ -t 2 ] && [ "${E2E_COLOR:-auto}" != "0" ]; then
    C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_DIM=$'\033[2m'
else
    C_RESET=""; C_RED=""; C_GRN=""; C_YLW=""; C_DIM=""
fi

e2e_log()  { printf '%s\n' "$*" >&2; }
e2e_step() { printf "  ${C_DIM}- %s${C_RESET}\n" "$*" >&2; }
e2e_pass() { printf "  ${C_GRN}PASS${C_RESET} %s\n" "$*" >&2; }
e2e_skip() { printf "  ${C_YLW}SKIP${C_RESET} %s\n" "$*" >&2; exit 0; }
e2e_fail() {
    printf "  ${C_RED}FAIL${C_RESET} %s\n" "$*" >&2
    e2e_debug
    exit 1
}

e2e_debug() {
    [ "${E2E_DEBUG:-0}" = "1" ] || return 0
    [ -n "${E2E_HOME:-}" ] || return 0
    e2e_log "----- debug: ${E2E_HOME} -----"
    local state="$E2E_HOME/.local/state/opencode/latest/tui"
    for f in "$state/plugin.opencode-notify.instances.json" "$state/tabs.json"; do
        [ -f "$f" ] || continue
        e2e_log "== $(basename "$f") =="
        head -c 3000 "$f" >&2
        e2e_log ""
    done
    if [ -s "${E2E_BLINKS:-}" ]; then
        e2e_log "== tab name states (count, names) =="
        cut -d' ' -f2- "$E2E_BLINKS" | sort | uniq -c >&2
    fi
    if [ -f "$E2E_HOME/turn.out" ]; then
        e2e_log "== last turn output =="
        tail -c 2000 "$E2E_HOME/turn.out" >&2
        e2e_log ""
    fi
    if [ -n "${E2E_TT_SESSION:-}" ]; then
        e2e_log "== focused pane =="
        tui-test --session "$E2E_TT_SESSION" text --full 2>/dev/null | head -50 >&2 || true
    fi
}

# --- preconditions -----------------------------------------------------------
e2e_require_cmd() { command -v "$1" >/dev/null 2>&1 || e2e_fail "required command not found: $1"; }
e2e_require_env() {
    [ -n "${E2E_ENDPOINT:-}" ] || e2e_skip "E2E_ENDPOINT is not set"
    [ -n "${E2E_MODEL:-}" ] || e2e_skip "E2E_MODEL is not set"
    [ -n "${!E2E_API_KEY_ENV:-}" ] || e2e_skip "env $E2E_API_KEY_ENV is not set"
}

# Driving Zellij from a host that already runs a live session is unsafe, so
# Zellij scenarios run only inside a container that opts in (the Docker image
# sets E2E_ALLOW_ZELLIJ=1). Every Zellij command is also isolated via
# ZELLIJ_SOCKET_DIR, so it can never reach a host session.
e2e_require_zellij() {
    [ "${E2E_ALLOW_ZELLIJ:-0}" = "1" ] || e2e_skip "zellij scenarios are opt-in (set E2E_ALLOW_ZELLIJ=1)"
    { [ -f /.dockerenv ] || [ -f /run/.containerenv ]; } || e2e_skip "zellij scenarios are container-only"
    e2e_require_cmd zellij
    e2e_require_cmd tui-test
}

# --- isolated HOME -----------------------------------------------------------
# OpenCode resolves its config, data, and state (sessions, the background
# service registration, the TUI's persisted session tabs, and the plugin's
# shared store) from $HOME with the XDG variables unset, so a run never reads
# or writes the developer's real state.
#
# e2e_setup [permissions-json]
e2e_setup() {
    e2e_require_cmd "$E2E_OPENCODE"
    e2e_require_cmd jq
    e2e_require_env
    E2E_HOME="$(mktemp -d "${TMPDIR:-/tmp}/notify-e2e-XXXXXX")"
    export HOME="$E2E_HOME"
    unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
    unset ZELLIJ ZELLIJ_PANE_ID ZELLIJ_SESSION_NAME
    export ZELLIJ_SOCKET_DIR="$E2E_HOME/zellij"
    E2E_WORK="$E2E_HOME/work"
    E2E_STATE="$E2E_HOME/.local/state/opencode/latest/tui"
    E2E_TT_SESSION=""
    E2E_ZJ_SESSION=""
    E2E_WATCH_PID=""
    E2E_BLINKS=""
    mkdir -p "$E2E_HOME/.config/opencode" "$E2E_WORK" "$ZELLIJ_SOCKET_DIR"
    git -C "$E2E_WORK" init -q .
    e2e_write_config "${1:-[]}"
    trap e2e_cleanup EXIT
}

e2e_write_config() {
    jq -n \
        --arg model "e2e/$E2E_MODEL" \
        --arg id "$E2E_MODEL" \
        --arg package "$E2E_PROVIDER_PACKAGE" \
        --arg endpoint "$E2E_ENDPOINT" \
        --arg key "{env:$E2E_API_KEY_ENV}" \
        --argjson permissions "$1" \
        '{
            model: $model,
            formatter: false,
            lsp: false,
            websearch: false,
            update: "disable",
            permissions: $permissions,
            providers: {
                e2e: {
                    name: "E2E",
                    package: $package,
                    settings: { baseURL: $endpoint, apiKey: $key },
                    models: { ($id): {} }
                }
            }
        }' > "$HOME/.config/opencode/opencode.json"
    # The plugin under test, loaded from the working tree; the built-in
    # notifications plugin is disabled exactly as the README instructs.
    jq -n --arg plugin "file://$E2E_PLUGIN_DIR" \
        '{ plugins: [{ package: $plugin }, "-opencode.notifications"] }' \
        > "$HOME/.config/opencode/cli.json"
}

e2e_cleanup() {
    [ -n "${E2E_HOME:-}" ] || return 0
    [ -n "${E2E_WATCH_PID:-}" ] && kill "$E2E_WATCH_PID" >/dev/null 2>&1
    [ -n "${E2E_TT_SESSION:-}" ] && tui-test --session "$E2E_TT_SESSION" close >/dev/null 2>&1
    # Isolated socket dir: only this scenario's session is visible.
    [ -n "${E2E_ZJ_SESSION:-}" ] && zellij kill-session "$E2E_ZJ_SESSION" >/dev/null 2>&1
    "$E2E_OPENCODE" service stop </dev/null >/dev/null 2>&1
    if [ "${E2E_KEEP:-0}" = "1" ]; then
        e2e_log "kept HOME: $E2E_HOME"
    else
        rm -rf "$E2E_HOME"
    fi
}

e2e_now() { date +%s%3N; }

# --- OpenCode ----------------------------------------------------------------
# Starts the background service every TUI shares, on a scenario-specific port
# so it never collides with another service.
e2e_service_start() {
    "$E2E_OPENCODE" service set port "$((40000 + RANDOM % 9000))" </dev/null >/dev/null 2>&1 \
        || e2e_fail "could not configure the service port"
    "$E2E_OPENCODE" service start </dev/null >"$E2E_HOME/service.out" 2>&1 \
        || e2e_fail "could not start the background service: $(tail -3 "$E2E_HOME/service.out")"
}

# Runs one turn in a session through the shared service, outside any TUI.
# e2e_turn <session> <message> [opencode run flags...]
# Sets E2E_TURN_EXIT and E2E_TURN_START/E2E_TURN_END (epoch ms).
e2e_turn() {
    local session="$1" message="$2"
    shift 2
    E2E_TURN_START="$(e2e_now)"
    (cd "$E2E_WORK" && timeout "$E2E_TURN_TIMEOUT" "$E2E_OPENCODE" run -s "$session" "$@" "$message" \
        </dev/null >"$E2E_HOME/turn.out" 2>&1)
    E2E_TURN_EXIT=$?
    E2E_TURN_END="$(e2e_now)"
}

# Creates sessions with a fixed title and a first turn whose prompt carries a
# marker, so a TUI showing one can be told apart on screen.
# e2e_seed <session> <title> <marker>
e2e_seed() {
    e2e_turn "$1" "Reply with exactly: $3" --title "$2"
    [ "$E2E_TURN_EXIT" -eq 0 ] || e2e_fail "could not seed $1: $(tail -3 "$E2E_HOME/turn.out")"
}

# --- Zellij ------------------------------------------------------------------
E2E_TAB_NAMES=(one two three four five)

e2e_zj() { zellij --session "$E2E_ZJ_SESSION" "$@"; }

# Starts a Zellij session with one tab per given session id, each running a
# TUI on that session, all launched in the same directory (the case where a
# directory or the shared session-tab strip cannot tell instances apart).
# tui-test attaches a real client, so Zellij runs the panes and tracks focus.
# e2e_zellij_start <session>...
e2e_zellij_start() {
    E2E_ZJ_SESSION="notify-e2e-$RANDOM$RANDOM"
    E2E_TT_SESSION="notify-e2e-$RANDOM$RANDOM"
    local layout="$E2E_HOME/layout.kdl" index=0 session
    {
        printf 'layout {\n'
        for session in "$@"; do
            printf '    tab name="%s"%s {\n' "${E2E_TAB_NAMES[$index]}" "$([ "$index" -eq 0 ] && echo ' focus=true')"
            printf '        pane command="%s" cwd="%s" { args "-s" "%s"; }\n' "$E2E_OPENCODE" "$E2E_WORK" "$session"
            printf '    }\n'
            index=$((index + 1))
        done
        printf '}\n'
    } > "$layout"
    tui-test --session "$E2E_TT_SESSION" run --no-wait-ready --cols 160 --rows 45 \
        --env "HOME=$E2E_HOME" --env "ZELLIJ_SOCKET_DIR=$ZELLIJ_SOCKET_DIR" \
        -- zellij --new-session-with-layout "$layout" --session "$E2E_ZJ_SESSION" >/dev/null 2>&1 \
        || e2e_fail "could not start zellij"
    # Every TUI registers its session in OpenCode's tab strip (shared by all
    # of them, persisted per launch directory) once it shows it.
    e2e_wait_until "$E2E_TIMEOUT" e2e_strip_has "$@" || e2e_fail "TUIs did not open their sessions"
    # Let the plugin instances publish the session each one shows.
    sleep 3
}

e2e_strip_has() {
    local file="$E2E_STATE/tabs.json" session
    [ -f "$file" ] || return 1
    for session in "$@"; do
        jq -e --arg cwd "$E2E_WORK" --arg id "$session" \
            '.cwd[$cwd].tabs | any(.sessionID == $id)' "$file" >/dev/null 2>&1 || return 1
    done
}

# 1-based position of a session in the shared tab strip. The order follows
# which TUI registered first, so it differs between runs.
e2e_strip_position() {
    jq -r --arg cwd "$E2E_WORK" --arg id "$1" \
        '.cwd[$cwd].tabs | map(.sessionID) | index($id) // empty | . + 1' "$E2E_STATE/tabs.json"
}

e2e_focus_tab() { e2e_zj action go-to-tab "$1" >/dev/null 2>&1 || e2e_fail "could not focus tab $1"; sleep 1; }

# Sends the OpenCode leader key (ctrl+x) followed by a key to the focused TUI.
e2e_leader() {
    e2e_zj action write 24 >/dev/null 2>&1 || e2e_fail "could not send the leader key"
    e2e_zj action write-chars "$1" >/dev/null 2>&1 || e2e_fail "could not send '$1'"
}

e2e_screen() { tui-test --session "$E2E_TT_SESSION" text --full 2>/dev/null || true; }
e2e_screen_has() { e2e_screen | grep -qF -- "$1"; }

# --- blink watcher -----------------------------------------------------------
# Samples Zellij's tab names every 200ms with an epoch-ms timestamp. The plugin
# blinks a tab by renaming it between "● name" and "○ name", so a marker on a
# sampled name is a blink, and the timestamp says when it happened.
e2e_watch_start() {
    E2E_BLINKS="$E2E_HOME/blinks.log"
    : > "$E2E_BLINKS"
    (
        while :; do
            printf '%s %s\n' "$(e2e_now)" "$(e2e_zj action query-tab-names 2>/dev/null | tr '\n' '|')" >> "$E2E_BLINKS"
            sleep 0.2
        done
    ) &
    E2E_WATCH_PID=$!
}

e2e_watch_stop() {
    [ -n "$E2E_WATCH_PID" ] && kill "$E2E_WATCH_PID" >/dev/null 2>&1
    wait "$E2E_WATCH_PID" 2>/dev/null
    E2E_WATCH_PID=""
}

# e2e_blinked <tab> [from-ms] [to-ms]: a sample in the window shows the marker.
e2e_blinked() {
    awk -v tab="$1" -v from="${2:-0}" -v to="${3:-99999999999999}" '
        $1 < from || $1 > to { next }
        {
            n = split(substr($0, length($1) + 2), names, "|")
            for (i = 1; i <= n; i++) if (names[i] ~ ("^(● |○ )+" tab "$")) found = 1
        }
        END { exit found ? 0 : 1 }' "$E2E_BLINKS"
}

e2e_assert_blinked() {
    e2e_blinked "$@" || e2e_fail "expected tab '$1' to blink${2:+ (from $2${3:+ to $3})}"
}

e2e_assert_not_blinked() {
    e2e_blinked "$@" && e2e_fail "tab '$1' blinked but should not have${2:+ (from $2${3:+ to $3})}"
    return 0
}

# --- polling -----------------------------------------------------------------
# e2e_wait_until <seconds> <cmd...> ; succeeds as soon as cmd exits 0.
e2e_wait_until() {
    local secs="$1"; shift
    local i=0
    while [ "$i" -lt "$((secs * 5))" ]; do
        if "$@" >/dev/null 2>&1; then return 0; fi
        sleep 0.2
        i=$((i + 1))
    done
    return 1
}
