# Skill: run and extend the opencode-notify e2e suite

Use this when you need to verify the plugin end-to-end, debug a failing
scenario, or add coverage for a behavior that spans TUI instances. The suite
runs the real OpenCode V2 CLI and real model turns; there is no mock, so
success means the whole loop works.

## TL;DR

```sh
npm run e2e:docker                 # build the image, run every scenario
npm run e2e:docker -- 10           # run one scenario by name substring
npm run e2e                        # host: only the scenarios that need no Zellij
```

Preconditions: Docker, and the endpoint config in the environment
(`E2E_ENDPOINT`, `E2E_MODEL`, and the key named by `E2E_API_KEY_ENV`, default
`E2E_API_KEY`). There are no committed endpoint defaults; scenarios skip until
these are set. Machine-specific values live in `AGENTS.local.md` when present.

## Mental model

Each scenario is a bash file that sources `e2e/lib.sh` and exits non-zero on
failure. It runs in a throwaway `HOME`, starts its own background service on a
random port, seeds sessions with `opencode run`, and opens one TUI per Zellij
tab, all in the same directory. `tui-test` attaches a real Zellij client so the
panes run and focus is tracked. Turns run through the shared service from
outside the TUIs; a watcher samples Zellij tab names, and a `●`/`○` prefix is
the plugin's blink.

## Interpreting failures

- `FAIL tab 'X' blinked but should not have`: a routing regression, an
  instance signalled a session it does not own. Re-run with `E2E_DEBUG=1` to
  dump the plugin registry (`plugin.opencode-notify.instances.json`), the
  shared tab strip (`tabs.json`), the observed tab-name states, and the
  focused pane.
- `tab one did not blink`: check the turn output in the debug dump first (the
  model may not have followed the prompt, or the endpoint failed).
- Setup failures (`TUIs did not open their sessions`, `did not switch`): read
  the focused pane in the debug dump. The tab strip order follows which TUI
  registered first, so never hardcode strip positions; use
  `e2e_strip_position`.

To debug interactively, keep a container running and mount the working tree:

```sh
docker run -d --name notify-e2e-dev -e "$E2E_API_KEY_ENV" \
  -v "$PWD:/plugin:ro" -v "$PWD/e2e:/e2e" --entrypoint sleep opencode-notify-e2e infinity
docker exec -e E2E_ENDPOINT -e E2E_MODEL -e E2E_API_KEY_ENV -e E2E_DEBUG=1 -e E2E_KEEP=1 \
  notify-e2e-dev /e2e/run.sh 10
```

## Adding a scenario

1. Copy the nearest existing scenario in `e2e/scenarios/`.
2. `source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"`.
3. Call `e2e_require_zellij` if it needs Zellij, then `e2e_setup` (optionally
   with a permissions JSON array), then `e2e_service_start`.
4. Seed with `e2e_seed`, open TUIs with `e2e_zellij_start`, act with
   `e2e_focus_tab`, `e2e_leader`, and `e2e_turn`, observe with
   `e2e_watch_start`/`e2e_watch_stop`.
5. Assert with `e2e_assert_blinked`/`e2e_assert_not_blinked` (optionally
   bounded by epoch-ms timestamps such as `E2E_TURN_START`/`E2E_TURN_END`),
   then `e2e_pass`.

## Guardrails

- Do not commit the API key or the endpoint; they come from the environment.
- Keep scenarios hermetic: use `e2e_setup`'s throwaway `HOME`; never touch the
  developer's real config, service, or Zellij session.
- Pair every negative assertion with a positive one (the right tab did blink),
  or a broken setup passes vacuously.
