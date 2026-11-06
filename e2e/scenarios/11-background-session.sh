#!/usr/bin/env bash
# A background session belongs to the tab that showed it last. Tab one's TUI
# switches to another OpenCode session tab, so no instance shows its first
# session any more; when that session finishes, tab one (where the user last
# saw it) blinks, and tabs two and three stay quiet.
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

e2e_step "switching tab one's TUI to the third session's tab"
position="$(e2e_strip_position ses_e2ethree)"
[ -n "$position" ] || e2e_fail "the third session is not in the tab strip"
e2e_focus_tab 1
e2e_leader "$position"
e2e_wait_until 10 e2e_screen_has "SEED-THREE" || e2e_fail "tab one did not switch to the third session"
sleep 2

e2e_focus_tab 2
e2e_watch_start
e2e_step "finishing a turn in the session tab one showed last"
e2e_turn ses_e2eone "Reply with exactly: E2E-DONE"
[ "$E2E_TURN_EXIT" -eq 0 ] || e2e_fail "turn failed: $(tail -3 "$E2E_HOME/turn.out")"

e2e_wait_until 15 e2e_blinked one || e2e_fail "tab one did not blink for the session it showed last"
sleep 3
e2e_watch_stop

e2e_assert_not_blinked two
e2e_assert_not_blinked three
e2e_pass "the background session signalled in the tab that showed it last"
