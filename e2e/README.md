# opencode-notify end-to-end tests

Black-box tests that run the real OpenCode V2 CLI with the plugin loaded from
the working tree, several TUIs in real Zellij tabs on one shared background
service, and a real OpenAI-compatible endpoint. Nothing is mocked: scenarios
steer the model with explicit prompts and assert on observable side effects,
mainly which Zellij tabs the plugin blinks.

## Why real TUIs and a real endpoint

The routing bugs this suite guards against only exist across processes: every
TUI on the V2 shared server receives every event, and OpenCode shares the
session-tab strip between every TUI launched in one directory. Unit tests
model each instance separately and cannot reproduce that. Turns run on a
real model so the server emits the real event sequence (execution started,
permission asked and replied, execution succeeded).

## Prerequisites

- Docker, for the Zellij scenarios (container-only, see below)
- `E2E_ENDPOINT`, `E2E_MODEL`, and an API key. There are no committed endpoint
  defaults, so scenarios skip until these are set:
  ```sh
  export E2E_ENDPOINT=https://your-endpoint/v1
  export E2E_MODEL=your-model
  export E2E_API_KEY=...        # or set E2E_API_KEY_ENV to your var's name
  ```
- On the host only: `opencode` (V2), `jq`, and bash 4+

## Running

```sh
# container (reproducible: OpenCode V2 + Zellij + tui-test + the plugin)
npm run e2e:docker
npm run e2e:docker -- 10 12      # only scenarios whose name contains "10" or "12"

# host (Zellij scenarios skip)
npm run e2e
E2E_KEEP=1 ./e2e/run.sh 10       # keep the throwaway HOME for inspection
E2E_DEBUG=1 ./e2e/run.sh 10      # dump registry/tab strip/tab names on failure
```

Environment:

| Variable               | Default                           | Purpose                                         |
| ---------------------- | --------------------------------- | ----------------------------------------------- |
| `E2E_ENDPOINT`         | _(required)_                      | OpenAI-compatible base URL                      |
| `E2E_MODEL`            | _(required)_                      | Deployment/model name                           |
| `E2E_API_KEY_ENV`      | `E2E_API_KEY`                     | Name of the env var holding the key             |
| `E2E_PROVIDER_PACKAGE` | `aisdk:@ai-sdk/openai-compatible` | OpenCode provider package for the endpoint      |
| `E2E_PLUGIN_DIR`       | repository root                   | Plugin under test (the image uses `/plugin`)    |
| `E2E_OPENCODE_BIN`     | `opencode`                        | OpenCode CLI under test                         |
| `E2E_TURN_TIMEOUT`     | `120`                             | Seconds one model turn may take                 |
| `E2E_TIMEOUT`          | `60`                              | Seconds to wait for the TUIs to open            |
| `E2E_ALLOW_ZELLIJ`     | _(unset)_                         | Enables the Zellij scenarios (set by the image) |

## Scenarios

| Scenario                | Covers                                                                 |
| ----------------------- | ---------------------------------------------------------------------- |
| `00-version`            | the CLI is V2 and the plugin exposes its `./tui` entry                 |
| `10-shared-directory`   | three TUIs in one directory: a finished turn blinks only its own tab   |
| `11-background-session` | a session nobody shows signals in the tab that showed it last          |
| `12-auto-accept`        | an auto-accepted permission stays quiet; only the finished turn blinks |

`10` to `12` are **container-only**: they drive a real Zellij session, which is
unsafe from a host that already runs one. They run only when
`E2E_ALLOW_ZELLIJ=1` (set by the image) **and** a container is detected
(`/.dockerenv` or `/run/.containerenv`), and they isolate Zellij via
`ZELLIJ_SOCKET_DIR` so they can never reach a host session.

## How isolation works

Each scenario runs in a throwaway `HOME` with the `XDG_*` variables unset, so
OpenCode's config, sessions, background service registration, persisted
session tabs, and the plugin's shared store all live there. The background
service gets a random port, so it never collides with another service.
`cli.json` loads the plugin from `E2E_PLUGIN_DIR` and disables the built-in
`opencode.notifications` plugin, exactly as the README instructs.

## How a scenario works

1. Seed sessions with `opencode run -s <id> --title <title>`, so each TUI can
   open a known session and the tab strip shows titles without the markers
   the prompts carry.
2. Start Zellij from a generated layout (one tab per session, each running
   `opencode -s <id>` in the same directory) with a real client attached via
   `tui-test`, so Zellij runs the panes and tracks the focused tab.
3. Wait until OpenCode's persisted tab strip lists every session.
4. Focus another tab, start the blink watcher (samples Zellij tab names every
   200ms with a timestamp), and run a turn through the shared service with
   `opencode run`, outside any TUI.
5. Assert which tabs gained a `●`/`○` marker, and when.

## Checking that a scenario catches a regression

Point `E2E_PLUGIN_DIR` at an older checkout to watch the scenarios fail, for
example with the location-gated plugin:

```sh
git worktree add /tmp/notify-old <old-commit>
docker run --rm -v /tmp/notify-old:/plugin-old -e E2E_PLUGIN_DIR=/plugin-old \
  -e E2E_ENDPOINT -e E2E_MODEL -e E2E_API_KEY_ENV -e "$E2E_API_KEY_ENV" opencode-notify-e2e 10
```

## Adding a scenario

Create `e2e/scenarios/NN-name.sh`, `source` `../lib.sh`, call
`e2e_require_zellij` when it needs Zellij, then `e2e_setup`, and end with
`e2e_pass "<what passed>"`. Failures go through `e2e_fail` (which dumps state
when `E2E_DEBUG=1`).
