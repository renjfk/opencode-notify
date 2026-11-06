#!/usr/bin/env bash
# Three TUIs in three Zellij tabs, launched in the same directory and sharing
# the background service, so every instance receives every event and all of
# them share one OpenCode session-tab strip. A turn finishing in the session
# tab one shows must blink tab one only: tab two (focused) and tab three stay
# quiet. Gating on the directory or on the tab strip blinks all of them.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

e2e_require_zellij
e2e_setup
e2e_service_start

e2e_step "seeding three sessions"
e2e_seed ses_e2eone alpha SEED-ONE
e2e_seed ses_e2etwo bravo SEED-TWO
e2e_seed ses_e2ethree charlie SEED-THREE

e2e_step "starting three TUIs in one directory"
e2e_zellij_start ses_e2eone ses_e2etwo ses_e2ethree

e2e_focus_tab 2
e2e_watch_start
e2e_step "finishing a turn in tab one's session while tab two is focused"
e2e_turn ses_e2eone "Reply with exactly: E2E-DONE"
[ "$E2E_TURN_EXIT" -eq 0 ] || e2e_fail "turn failed: $(tail -3 "$E2E_HOME/turn.out")"

e2e_wait_until 15 e2e_blinked one || e2e_fail "tab one did not blink after its session finished"
# Give a wrongly routed instance time to blink its own tab too.
sleep 3
e2e_watch_stop

e2e_assert_not_blinked two
e2e_assert_not_blinked three
e2e_pass "only the tab showing the session blinked"
