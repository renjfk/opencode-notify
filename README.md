[![CI](https://github.com/renjfk/opencode-notify/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/renjfk/opencode-notify/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@renjfk/opencode-notify)](https://www.npmjs.com/package/@renjfk/opencode-notify)
[![Downloads](https://img.shields.io/npm/dm/@renjfk/opencode-notify)](https://www.npmjs.com/package/@renjfk/opencode-notify)

# opencode-notify

Attention notifications plugin for [OpenCode](https://opencode.ai/).

Blinks the Zellij tab, plays a sound, and posts a macOS desktop notification
when a session needs your attention (idle after work, permission request,
question asked). The plugin adapts to whether your terminal window is visible
and whether the Zellij tab is active, so you only get pinged when you would
actually miss the event.

## Behavior

When OpenCode needs attention:

| Tab active | Ghostty visible | Action                           |
| ---------- | --------------- | -------------------------------- |
| Yes        | Yes             | Do nothing (user can see it)     |
| Yes        | No              | Desktop notification             |
| No         | Yes             | Blink tab + sound                |
| No         | No              | Blink tab + desktop notification |

The tab blinking stops when:

- You switch to the tab (detected via polling)
- OpenCode goes busy again (you responded)

## Install

Add to your `tui.json` (create at `~/.config/opencode/tui.json` if it doesn't exist):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@renjfk/opencode-notify"]
}
```

## Prerequisites

All integrations are **optional** and probed independently at startup. The
plugin degrades gracefully: anything missing is skipped, and a warning toast is
shown so you know what was disabled.

| Dependency                                                                 | Enables                                                 | Without it                                                          |
| -------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| [Zellij](https://zellij.dev/) (`zellij`) + running inside a Zellij pane    | Tab blinking when OpenCode needs attention              | Tab blinking is skipped; desktop notifications and sound still work |
| macOS + [Ghostty](https://ghostty.org/)                                    | Window-visibility aware behavior (no spam when visible) | Ghostty is treated as "not visible"; falls back to always notifying |
| [terminal-notifier](https://github.com/julienXX/terminal-notifier) + macOS | Desktop notifications                                   | Desktop notifications are skipped                                   |
| macOS (`afplay`)                                                           | Attention sound                                         | Sound is skipped                                                    |

### Recommended setup (full experience)

For the behavior matrix above to work end-to-end, install all of the following
on macOS:

```bash
brew install zellij terminal-notifier
```

Use [Ghostty](https://ghostty.org/) as your terminal and run OpenCode inside a
Zellij session. This gives you:

- **Tab blinking** so you can spot attention events at a glance across panes
- **Audible cue** when Ghostty is visible but the OpenCode tab is in the background
- **Desktop notifications** when Ghostty is hidden, so you get pinged even when
  you've tabbed away
- **Silence** when the tab is active and Ghostty is visible - the plugin stays
  out of your way when you can already see what's happening

If you don't use Zellij, Ghostty, or macOS, the plugin still does something
useful: it falls back to desktop notifications and/or sound wherever those are
available, and no-ops otherwise.

## How it works

1. On every attention event (`session.idle` after busy, `permission.asked`,
   `question.asked`), the plugin checks:
   - Is the Zellij tab hosting OpenCode active?
   - Is a Ghostty window visible on screen?
2. If the tab is inactive, the plugin renames it to blink between `●` and `○`
   prefixes until the tab becomes active again or the session goes busy.
3. If Ghostty is not visible, a `terminal-notifier` message is posted with the
   tab name as the title and the session title as the subtitle.
4. If Ghostty is visible but the tab is inactive, only an audible cue (Blow
   system sound) is played - no desktop notification.

Notifications are debounced to 2 seconds to avoid duplicates.

## Contributing

opencode-notify is open to contributions and ideas!

### Issue conventions

**Format:** `type: brief description`

- `feat:` new features or functionality
- `fix:` bug fixes
- `enhance:` improvements to existing features
- `chore:` maintenance tasks, dependencies, cleanup
- `docs:` documentation updates
- `build:` build system, CI/CD changes

### Development

```bash
npm run check        # lint + fmt
npm run lint         # oxlint
npm run fmt          # oxfmt --check
npm run fmt:fix      # oxfmt --write
```

### Release process

Manual releases via opencode; see [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

## License

This project is licensed under the [MIT License](LICENSE).
