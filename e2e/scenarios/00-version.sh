#!/usr/bin/env bash
# The OpenCode CLI under test is V2, and the plugin under test exposes the
# `./tui` entry V2 loads.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

e2e_require_cmd "$E2E_OPENCODE"
e2e_require_cmd jq

out="$("$E2E_OPENCODE" --version 2>&1)"
case "$out" in
    *v2.*) ;;
    *) e2e_fail "expected an OpenCode V2 CLI, got: $out" ;;
esac

entry="$(jq -r '.exports["./tui"].import // empty' "$E2E_PLUGIN_DIR/package.json")"
[ -n "$entry" ] && [ -f "$E2E_PLUGIN_DIR/$entry" ] || e2e_fail "plugin has no ./tui entry in $E2E_PLUGIN_DIR"

e2e_pass "$out, plugin $E2E_PLUGIN_DIR/${entry#./}"
