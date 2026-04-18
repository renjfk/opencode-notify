# AGENTS.md - opencode-notify

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Project overview

**opencode-notify** is an OpenCode TUI plugin that surfaces attention events
(session idle, permission asked, question asked) by blinking the host Zellij
tab, playing a system sound, and posting macOS desktop notifications via
`terminal-notifier`. Behavior adapts to whether the Zellij tab is active and
whether a Ghostty window is visible.

## Architecture

Single TUI plugin exported from `index.js`, with logic split into modules
under `lib/`.

- `index.js` - entry point, wires the plugin together, registers event handlers
- `lib/zellij.js` - Zellij tab discovery, rename/blink, tab active detection
- `lib/ghostty.js` - Ghostty window visibility detection via AppleScript
- `lib/notifier.js` - `terminal-notifier` invocation and notification clearing
- `lib/session.js` - shared helper for reading OpenCode session titles

### Key invariants

- Single default export: `{ id, tui }`. OpenCode's TUI loader requires this shape.
- No server-side plugin. The `server` property must never be added.
- **Capabilities are optional and independently probed at startup.** Each
  capability module (`zellij`, `ghostty`, `notifier`, `sound`) exposes an
  `available` flag. Missing dependencies never throw: the plugin simply skips
  that branch of behavior and continues with whatever is available. This makes
  the plugin useful outside Zellij, outside Ghostty, and on non-macOS systems
  where some capabilities do not apply.
- When Ghostty visibility cannot be determined (not macOS, AppleScript fails),
  treat it as "unknown" and fall back to the safe default: notify.
- All shell invocations use `node:child_process` (`execFile`/`spawn`). Never
  shell out via `sh -c` with user-controlled strings.
- Missing optional dependencies surface via `api.ui.toast` as warnings on
  startup but do not throw.
- No dotfile I/O for config. All persistence (if any) goes through `api.kv`.
- No build step. Plain ESM JavaScript, shipped as-is.

## Scripts

```bash
npm run check        # lint + fmt
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` with zero errors.

CI runs on every PR and push to main (lint, build). Releases are manual
dispatch via `gh workflow run release.yml`.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **No dependencies** - only peer dep on `@opencode-ai/plugin`
- **No build step** - no TypeScript, no bundler
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint
