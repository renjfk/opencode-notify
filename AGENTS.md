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
- Uses `node:child_process` (`execFile`/`spawn`). Never `sh -c` with
  user-controlled strings.
- No dotfile I/O. All persistence goes through `api.kv`.
- No build step. Plain ESM JavaScript, shipped as-is.

## Scripts

```bash
npm run check        # lint + fmt
npm run lint         # oxlint .
npm run fmt          # oxfmt --check .
npm run fmt:fix      # oxfmt --write .
```

Verify changes: `npm run check` with zero errors.

CI runs on every PR and push to main (lint, build). See RELEASE_PROCESS.md for
release steps.

## Code style

- **ESM only** - `import`/`export`, `"type": "module"` in package.json
- **No build step** - no TypeScript, no bundler
- **Formatting** - enforced by oxfmt
- **Linting** - enforced by oxlint
