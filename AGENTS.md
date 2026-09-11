# AGENTS.md - opencode-notify

Guidelines for AI agents working in this repository. Keep this file concise -
only document constraints and rules an agent would get wrong without being told.

## Architecture

Single TUI plugin exported from `index.js` with logic split into `lib/`.

## Key invariants

- Single default export: `{ id, tui }`. No server-side plugin.
- Capabilities are optional and independently probed at startup. Missing
  dependencies never throw — the plugin skips that branch and continues.
- When Ghostty visibility is unknown, treat as "not visible" and notify.
- Uses `node:child_process` (`execFile` only). Never `sh -c` with
  user-controlled strings (the lone exception, `hasBinary`, passes
  hardcoded binary names).
- No dotfile I/O. All persistence goes through `api.kv`.
- No build step. Plain ESM JavaScript, shipped as-is.

## Testing

Tests are `node:test` files in `test/`, fully hermetic: capabilities and
the TUI accept injected dependencies (fetch, exec, timers, mock `api`)
instead of touching the network, the filesystem, or real timers.

## Scripts

```bash
npm run check        # test + lint + fmt
npm test             # node:test unit tests
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` with zero errors.

CI runs on every PR and push to main (lint, test). See RELEASE_PROCESS.md for
release steps.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **No build step** - no TypeScript, no bundler
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint
