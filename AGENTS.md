# AGENTS.md - opencode-notify

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Architecture

Single TUI plugin exported from `index.js` with logic split into `lib/`.

## Key invariants

- Single TUI plugin via `Plugin.define` from `@opencode/plugin/tui`; `setup`
  returns a cleanup that detaches the data listeners and runs the disposers.
  No server-side plugin.
- Capabilities are optional and independently probed at startup. Missing
  dependencies never throw — the plugin skips that branch and continues.
- When Ghostty visibility is unknown, treat as "not visible" and notify.
- Uses `node:child_process` (`execFile` only). Never `sh -c` with
  user-controlled strings (the lone exception, `hasBinary`, passes
  hardcoded binary names).
- No dotfile I/O. All persistence goes through OpenCode's `storage.store`
  (`api.kv` and the instance registry).
- Routing between Zellij tabs uses the cross-instance registry in
  `lib/ownership.js`, read per event: each TUI publishes the session its route
  shows to a store shared by every instance, and exactly one instance owns a
  session (the one showing it, else the live one that showed it last, else one
  elected instance). Do not gate on the project directory or on
  `ui.tabs.list()` - several tabs commonly share one launch directory, and the
  session-tab strip is persisted per launch directory and shared by every
  instance there, so either fires all of them.
- Busy events record bookkeeping for every session but only settle signals
  under strict ownership (`{ claim: false }`): a brand-new session goes busy
  before its instance has published it.
- Permission prompts and questions wait `REQUEST_GRACE_MS` before signalling
  and are dropped if answered meanwhile: auto-accept (`--auto`) replies from
  the TUI client, so the server still emits every request and its reply.
- No build step. Plain ESM JavaScript, shipped as-is.
- Listen to V2 execution events, not the deprecated V1 `session.idle` (in V2 it
  has no producer): `session.execution.started` is busy,
  `session.execution.succeeded`/`interrupted` are completion, and
  `session.execution.failed` is the error path. See the built-in
  `opencode.notifications` plugin for the canonical event set.
- "Being viewed" requires BOTH the Zellij tab and, when session tabs are
  enabled and the session is an open tab, its OpenCode tab to be active; a
  background OpenCode tab inside the active Zellij tab must still signal.
- The built-in `opencode.notifications` plugin must be disabled (add
  `"-opencode.notifications"` to the `plugins` array in `cli.json`) or both
  plugins double-notify the same events.

## Testing

Tests are `node:test` files in `test/`, fully hermetic: capabilities and
the TUI accept injected dependencies (fetch, exec, timers, mock `api`)
instead of touching the network, the filesystem, or real timers.

The e2e suite (`e2e/`) runs real OpenCode V2 TUIs in real Zellij tabs on one
shared service against a real model, and asserts which tabs blink. Zellij
scenarios are container-only (`npm run e2e:docker`). Run it after changing
routing, ownership, or event handling; see `e2e/SKILL.md`. Machine-specific
settings that must not be committed (the e2e endpoint, model, and key) live
in `AGENTS.local.md` when present. Read it before running the e2e suite.

## Scripts

```bash
npm run check        # test + lint + fmt
npm test             # node:test unit tests
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
npm run e2e:docker   # e2e suite in the container (needs E2E_* env, see e2e/README.md)
npm run e2e          # e2e suite on the host (Zellij scenarios skip)
```

Verify changes: `npm run check` with zero errors.

CI runs on every PR and push to main (lint, test). See RELEASE_PROCESS.md for
release steps.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **No build step** - no TypeScript, no bundler
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint
