#!/usr/bin/env bash
# An auto-accepted permission must not signal. Auto-accept runs in the client,
# so the server still emits the request and its reply milliseconds apart. The
# turn runs a shell command that needs permission (shell is set to "ask") and
# then sleeps, with the request approved by `opencode run --auto`: tab one
# must stay quiet while the command runs and blink only once the turn ends.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

e2e_require_zellij
e2e_setup '[{ "action": "shell", "resource": "*", "effect": "ask" }]'
e2e_service_start

e2e_step "seeding three sessions"
e2e_seed ses_e2eone alpha SEED-ONE
e2e_seed ses_e2etwo bravo SEED-TWO
e2e_seed ses_e2ethree charlie SEED-THREE

e2e_step "starting three TUIs in one directory"
e2e_zellij_start ses_e2eone ses_e2etwo ses_e2ethree

e2e_focus_tab 2
e2e_watch_start
e2e_step "running an auto-accepted shell command in tab one's session"
e2e_turn ses_e2eone \
    "Use the shell tool to run exactly this command: sleep 8 && echo E2E-SLEPT . After it finishes, reply with exactly: E2E-DONE" \
    --auto
[ "$E2E_TURN_EXIT" -eq 0 ] || e2e_fail "turn failed: $(tail -3 "$E2E_HOME/turn.out")"
# The command ran, so the permission was asked and auto-accepted.
grep -qF "E2E-SLEPT" "$E2E_HOME/turn.out" || e2e_fail "the shell command did not run"
[ "$((E2E_TURN_END - E2E_TURN_START))" -ge 8000 ] || e2e_fail "the turn ended before the command could have run"

e2e_wait_until 15 e2e_blinked one || e2e_fail "tab one did not blink when the turn finished"
sleep 3
e2e_watch_stop

# The request was asked at least 8s before the turn ended; nothing may blink
# until the turn itself completes.
e2e_assert_not_blinked one "$E2E_TURN_START" "$((E2E_TURN_END - 1000))"
e2e_assert_not_blinked two
e2e_assert_not_blinked three
e2e_pass "the auto-accepted permission stayed quiet, the finished turn blinked tab one"
