import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { createGhostty } from "../lib/ghostty.js";
import { createLock } from "../lib/lock.js";
import { createNotifier } from "../lib/notifier.js";
import { createNtfy, fetchWithTimeout } from "../lib/ntfy.js";
import { createSound } from "../lib/sound.js";
import { createZellij } from "../lib/zellij.js";
import { hasBinary, run } from "../lib/exec.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("capabilities are safe no-ops when unavailable", async () => {
  const zellij = await createZellij({ paneId: null, binaryExists: async () => false });
  const ghostty = await createGhostty({ platform: "linux" });
  const lock = await createLock({ platform: "linux" });
  const notifier = await createNotifier({ platform: "linux" });
  const ntfy = await createNtfy({ config: {} });
  const sound = await createSound({ platform: "linux" });

  assert.equal(zellij.available, false);
  assert.equal(await zellij.isTabActive(), true);
  assert.equal(ghostty.available, false);
  assert.equal(await ghostty.isVisible(), null);
  assert.equal(lock.available, false);
  assert.equal(await lock.isLocked(), false);
  assert.equal(notifier.available, false);
  assert.deepEqual(await notifier.send(), { code: 0, skipped: true });
  await notifier.clear();
  assert.equal(ntfy.available, false);
  assert.equal(ntfy.configured, false);
  assert.deepEqual(await ntfy.send(), { ok: true, skipped: true });
  assert.equal(sound.available, false);
  await sound.play();
});

test("notifier builds terminal-notifier arguments", async () => {
  const calls = [];
  const notifier = await createNotifier({
    platform: "darwin",
    binaryExists: async () => true,
    execute: async (...args) => {
      calls.push(args);
      return { code: 0 };
    },
  });

  await notifier.send({ title: "Tab", subtitle: "Session", message: "Done", sound: "Ping" });
  await notifier.clear();

  assert.deepEqual(calls, [
    [
      "terminal-notifier",
      [
        "-title",
        "Tab",
        "-subtitle",
        "Session",
        "-message",
        "Done",
        "-sound",
        "Ping",
        "-group",
        "opencode",
      ],
    ],
    ["terminal-notifier", ["-remove", "opencode"]],
  ]);
});

test("notifier omits optional arguments when unset", async () => {
  const calls = [];
  const notifier = await createNotifier({
    platform: "darwin",
    binaryExists: async () => true,
    execute: async (...args) => {
      calls.push(args);
      return { code: 0 };
    },
  });

  await notifier.send({ message: "Done" });

  assert.deepEqual(calls, [
    ["terminal-notifier", ["-message", "Done", "-sound", "Blow", "-group", "opencode"]],
  ]);
});

test("Ghostty treats failed or invalid AppleScript output as unknown", async () => {
  const ghostty = await createGhostty({
    platform: "darwin",
    binaryExists: async () => true,
    execute: async () => ({ code: 0, stdout: "not a number" }),
  });
  assert.equal(await ghostty.isVisible(), null);
});

test("Ghostty reports unknown visibility when AppleScript exits non-zero", async () => {
  const ghostty = await createGhostty({
    platform: "darwin",
    binaryExists: async () => true,
    execute: async () => ({ code: 1, stdout: "" }),
  });
  assert.equal(await ghostty.isVisible(), null);
});

test("Ghostty counts windows to decide visibility", async () => {
  const make = (stdout) =>
    createGhostty({
      platform: "darwin",
      binaryExists: async () => true,
      execute: async () => ({ code: 0, stdout }),
    });
  assert.equal(await (await make("3")).isVisible(), true);
  assert.equal(await (await make("0")).isVisible(), false);
});

test("Zellij finds the current pane and uses its tab name", async () => {
  const calls = [];
  const zellij = await createZellij({
    paneId: "7",
    binaryExists: async () => true,
    execute: async (command, args) => {
      calls.push([command, args]);
      if (args[1] === "list-panes") {
        return { code: 0, stdout: JSON.stringify([{ id: 7, tab_id: 3, tab_name: "work" }]) };
      }
      return { code: 0, stdout: JSON.stringify({ tab_id: 3 }) };
    },
  });

  assert.equal(await zellij.getTabName(), "work");
  assert.equal(await zellij.isTabActive(), true);
  assert.deepEqual(calls, [
    ["zellij", ["action", "list-panes", "--json"]],
    ["zellij", ["action", "list-panes", "--json"]],
    ["zellij", ["action", "current-tab-info", "--json"]],
  ]);
});

test("Zellij falls back to neutral answers when output is unusable", async () => {
  const zellij = await createZellij({
    paneId: "7",
    binaryExists: async () => true,
    execute: async (command, args) => {
      if (args[1] === "list-panes") return { code: 1, stdout: "" };
      return { code: 0, stdout: JSON.stringify({ tab_id: 3 }) };
    },
  });

  // list-panes fails: no pane found, tab name falls back, tab counts as active.
  assert.equal(await zellij.getTabName(), "opencode");
  assert.equal(await zellij.isTabActive(), true);

  const zellijBadTabInfo = await createZellij({
    paneId: "7",
    binaryExists: async () => true,
    execute: async (command, args) => {
      if (args[1] === "list-panes") {
        return { code: 0, stdout: JSON.stringify([{ id: 7, tab_id: 3, tab_name: "work" }]) };
      }
      return { code: 0, stdout: "not json" };
    },
  });
  // current-tab-info emits garbage: treat the tab as active rather than guessing.
  assert.equal(await zellijBadTabInfo.isTabActive(), true);

  const zellijBadPanes = await createZellij({
    paneId: "7",
    binaryExists: async () => true,
    execute: async () => ({ code: 0, stdout: "not json" }),
  });
  // list-panes emits garbage: no pane found, fall back to neutral answers.
  assert.equal(await zellijBadPanes.getTabName(), "opencode");
  assert.equal(await zellijBadPanes.isTabActive(), true);
});

test("Zellij blinks the tab and stops when the tab becomes active", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let activeTabId = 99;
    const calls = [];
    const zellij = await createZellij({
      paneId: "7",
      binaryExists: async () => true,
      execute: async (command, args) => {
        calls.push([command, args]);
        if (args[1] === "list-panes") {
          return { code: 0, stdout: JSON.stringify([{ id: 7, tab_id: 3, tab_name: "work" }]) };
        }
        if (args[1] === "current-tab-info") {
          return { code: 0, stdout: JSON.stringify({ tab_id: activeTabId }) };
        }
        return { code: 0, stdout: "" };
      },
    });

    await zellij.startBlinking();

    await mock.timers.tick(600);
    await flush();
    activeTabId = 3;
    await mock.timers.tick(400);
    await flush();
    await mock.timers.tick(2000);
    await flush();

    const renames = calls
      .filter(([, args]) => args[1] === "rename-tab-by-id")
      .map(([, args]) => args[3]);
    assert.deepEqual(renames, ["● work", "work"]);
  } finally {
    mock.timers.reset();
  }
});

test("Zellij alternates the blink marker while the tab stays inactive", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const calls = [];
    const zellij = await createZellij({
      paneId: "7",
      binaryExists: async () => true,
      execute: async (command, args) => {
        calls.push([command, args]);
        if (args[1] === "list-panes") {
          return { code: 0, stdout: JSON.stringify([{ id: 7, tab_id: 3, tab_name: "work" }]) };
        }
        if (args[1] === "current-tab-info") {
          return { code: 0, stdout: JSON.stringify({ tab_id: 99 }) };
        }
        return { code: 0, stdout: "" };
      },
    });

    await zellij.startBlinking();

    await mock.timers.tick(600);
    await flush();
    await mock.timers.tick(600);
    await flush();
    await mock.timers.tick(600);
    await flush();
    await zellij.stopBlinking();
    await mock.timers.tick(2000);
    await flush();

    const renames = calls
      .filter(([, args]) => args[1] === "rename-tab-by-id")
      .map(([, args]) => args[3]);
    assert.deepEqual(renames, ["● work", "○ work", "● work", "work"]);
  } finally {
    mock.timers.reset();
  }
});

test("Zellij does not blink when the tab cannot be found", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const calls = [];
    const zellij = await createZellij({
      paneId: "7",
      binaryExists: async () => true,
      execute: async (command, args) => {
        calls.push([command, args]);
        return { code: 0, stdout: "[]" };
      },
    });

    await zellij.startBlinking();
    await mock.timers.tick(2000);
    await flush();
    await zellij.stopBlinking();

    assert.deepEqual(
      calls.filter(([, args]) => args[1] === "rename-tab-by-id"),
      [],
    );
  } finally {
    mock.timers.reset();
  }
});

test("Zellij stops blinking when renaming starts to fail", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let renames = 0;
    const zellij = await createZellij({
      paneId: "7",
      binaryExists: async () => true,
      execute: async (command, args) => {
        if (args[1] === "rename-tab-by-id") {
          renames += 1;
          throw new Error("zellij gone");
        }
        if (args[1] === "list-panes") {
          return { code: 0, stdout: JSON.stringify([{ id: 7, tab_id: 3, tab_name: "work" }]) };
        }
        return { code: 0, stdout: JSON.stringify({ tab_id: 99 }) };
      },
    });

    await zellij.startBlinking();
    await mock.timers.tick(600);
    await flush();
    await mock.timers.tick(2000);
    await flush();

    // One blink attempt, one restore attempt (also fails), then blinking
    // stops for good instead of retrying against a dead Zellij forever.
    assert.equal(renames, 2);
  } finally {
    mock.timers.reset();
  }
});

test("Zellij strips leftover blink markers so cycles never stack dots", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let tabName = "● ● work";
    const calls = [];
    const zellij = await createZellij({
      paneId: "7",
      binaryExists: async () => true,
      execute: async (command, args) => {
        calls.push(args);
        if (args[1] === "list-panes") {
          return { code: 0, stdout: JSON.stringify([{ id: 7, tab_id: 3, tab_name: tabName }]) };
        }
        if (args[1] === "rename-tab-by-id") {
          tabName = args[3];
          return { code: 0, stdout: "" };
        }
        return { code: 0, stdout: JSON.stringify({ tab_id: 99 }) };
      },
    });

    // Pollution from a previous cycle (crash, lost race, exited session).
    assert.equal(await zellij.getTabName(), "work");

    await zellij.startBlinking();
    await mock.timers.tick(600);
    await flush();
    await zellij.stopBlinking();

    const renames = calls.filter((args) => args[1] === "rename-tab-by-id").map((args) => args[3]);
    assert.deepEqual(renames, ["● work", "work"]);
    assert.equal(tabName, "work");
  } finally {
    mock.timers.reset();
  }
});

test("Zellij drops queued blink renames on stop so the restore lands last", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const renames = [];
    const gated = [];
    const zellij = await createZellij({
      paneId: "7",
      binaryExists: async () => true,
      execute: async (command, args) => {
        if (args[1] === "rename-tab-by-id") {
          renames.push(args[3]);
          return new Promise((resolve) => gated.push(() => resolve({ code: 0, stdout: "" })));
        }
        if (args[1] === "list-panes") {
          return { code: 0, stdout: JSON.stringify([{ id: 7, tab_id: 3, tab_name: "work" }]) };
        }
        return { code: 0, stdout: JSON.stringify({ tab_id: 99 }) };
      },
    });

    await zellij.startBlinking();
    // First blink rename starts but is held in flight; the next tick queues a
    // second blink rename behind it.
    await mock.timers.tick(600);
    await flush();
    await mock.timers.tick(600);
    await flush();
    assert.equal(renames.length, 1);

    const stopped = zellij.stopBlinking();
    gated[0]();
    await flush();
    gated[1]();
    await stopped;
    await flush();

    assert.deepEqual(renames, ["● work", "work"]);
  } finally {
    mock.timers.reset();
  }
});

test("a failed rename from an old cycle does not cancel a restarted cycle", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const renames = [];
    const gated = [];
    let failHeldRename = true;
    const zellij = await createZellij({
      paneId: "7",
      binaryExists: async () => true,
      execute: async (command, args) => {
        if (args[1] === "rename-tab-by-id") {
          renames.push(args[3]);
          if (failHeldRename) {
            failHeldRename = false;
            return new Promise((resolve) => gated.push(() => resolve({ code: 1, stdout: "" })));
          }
          return { code: 0, stdout: "" };
        }
        if (args[1] === "list-panes") {
          return { code: 0, stdout: JSON.stringify([{ id: 7, tab_id: 3, tab_name: "work" }]) };
        }
        return { code: 0, stdout: JSON.stringify({ tab_id: 99 }) };
      },
    });

    await zellij.startBlinking();
    // The old cycle's first rename is held in flight, then fails.
    await mock.timers.tick(600);
    await flush();

    // Stop the old cycle (restore queued behind the held rename) and start a
    // new one before the failure resolves.
    const stopped = zellij.stopBlinking();
    await zellij.startBlinking();
    gated[0]();
    await stopped;
    await flush();

    // The new cycle must keep blinking despite the old cycle's failure.
    await mock.timers.tick(600);
    await flush();
    await mock.timers.tick(600);
    await flush();
    await zellij.stopBlinking();

    assert.deepEqual(renames, ["● work", "work", "● work", "○ work", "work"]);
  } finally {
    mock.timers.reset();
  }
});

test("sound starts afplay without awaiting playback", async () => {
  const calls = [];
  const sound = await createSound({
    platform: "darwin",
    binaryExists: async () => true,
    execute: (...args) => {
      calls.push(args);
      return Promise.resolve();
    },
  });

  await sound.play("/tmp/alert.aiff");
  assert.deepEqual(calls, [["afplay", ["/tmp/alert.aiff"], { timeout: 10000 }]]);

  await sound.play();
  assert.deepEqual(calls.at(-1), [
    "afplay",
    ["/System/Library/Sounds/Blow.aiff"],
    { timeout: 10000 },
  ]);
});

test("run executes real commands and reports results without rejecting", async () => {
  const ok = await run("/bin/echo", ["hello"]);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, "hello\n");
  assert.equal(ok.error, null);

  const piped = await run("/bin/cat", [], { input: "hi" });
  assert.equal(piped.code, 0);
  assert.equal(piped.stdout, "hi");

  const failed = await run("/usr/bin/false");
  assert.equal(failed.code, 1);

  const missing = await run("/no/such/binary");
  assert.equal(missing.code, "ENOENT");
});

test("hasBinary detects binaries on PATH", async () => {
  assert.equal(await hasBinary("sh"), true);
  assert.equal(await hasBinary("definitely-not-a-real-binary-xyz"), false);
});

function fakeFetch(responses = []) {
  const requests = [];
  const respond = async (url, options) => {
    requests.push({ url, options });
    const response = responses.length > 1 ? responses.shift() : responses[0];
    if (response instanceof Error) throw response;
    return response;
  };
  return { requests, fetch: respond };
}

const ok = {
  ok: true,
  status: 200,
  text: async () => '{"id":"msg_ok","time":1700000000,"event":"message","topic":"t"}',
};

test("ntfy is inactive without a topic even when other config is present", async () => {
  const { fetch } = fakeFetch();
  const ntfy = await createNtfy({
    config: { server: "https://ntfy.example.com" },
    fetchImpl: fetch,
  });

  assert.equal(ntfy.available, false);
  assert.equal(ntfy.configured, false);
  assert.deepEqual(await ntfy.send(), { ok: true, skipped: true });
});

test("ntfy probes the server and publishes with bearer token auth", async () => {
  process.env.TEST_NTFY_TOKEN = "tk_secret";
  try {
    const { requests, fetch } = fakeFetch([ok]);
    const ntfy = await createNtfy({
      config: {
        server: "https://ntfy.example.com/",
        topic: "opencode-notify-abc123",
        tokenEnv: "TEST_NTFY_TOKEN",
      },
      fetchImpl: fetch,
    });

    assert.equal(ntfy.available, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://ntfy.example.com/v1/health");
    assert.equal(requests[0].options.headers.Authorization, "Bearer tk_secret");

    const result = await ntfy.send({
      title: "Implement notifications",
      message: "Question needs your answer",
      priority: "high",
      tags: ["question"],
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "https://ntfy.example.com/opencode-notify-abc123");
    assert.equal(requests[1].options.method, "POST");
    assert.equal(requests[1].options.body, "Question needs your answer");
    assert.deepEqual(requests[1].options.headers, {
      Title: "Implement notifications",
      Priority: "high",
      Tags: "question",
      Authorization: "Bearer tk_secret",
    });
  } finally {
    delete process.env.TEST_NTFY_TOKEN;
  }
});

test("ntfy defaults to the public server and sends no auth without tokenEnv", async () => {
  const { requests, fetch } = fakeFetch([ok, ok]);
  const ntfy = await createNtfy({ config: { topic: "mytopic" }, fetchImpl: fetch });

  assert.equal(ntfy.available, true);
  assert.equal(requests[0].options.headers.Authorization, undefined);

  await ntfy.send({ message: "hi" });
  assert.equal(requests[1].url, "https://ntfy.sh/mytopic");
  assert.equal(requests[1].options.headers.Authorization, undefined);
});

test("ntfy RFC 2047 encodes non-ASCII titles and passes ASCII through", async () => {
  const { requests, fetch } = fakeFetch([ok]);
  const ntfy = await createNtfy({ config: { topic: "mytopic" }, fetchImpl: fetch });

  const unicodeTitle = "Fix → notification 😀";
  await ntfy.send({ title: unicodeTitle, message: "hi" });
  const encoded = `=?UTF-8?B?${Buffer.from(unicodeTitle, "utf8").toString("base64")}?=`;
  assert.equal(requests[1].options.headers.Title, encoded);
  assert.equal(requests[1].options.body, "hi");

  await ntfy.send({ title: "Plain ASCII title", message: "hi" });
  assert.equal(requests[2].options.headers.Title, "Plain ASCII title");
});

test("ntfy reports send failures without throwing", async () => {
  const { fetch } = fakeFetch([{ ok: false, status: 429 }]);
  const ntfy = await createNtfy({ config: { topic: "mytopic" }, fetchImpl: fetch });

  const result = await ntfy.send({ message: "hi" });
  assert.deepEqual(result, { ok: false, error: "HTTP 429" });
});

test("ntfy reports network errors during send without throwing", async () => {
  const { fetch } = fakeFetch([ok, new Error("socket hang up")]);
  const ntfy = await createNtfy({ config: { topic: "mytopic" }, fetchImpl: fetch });

  const result = await ntfy.send({ message: "hi" });
  assert.deepEqual(result, { ok: false, error: "socket hang up" });
});

test("ntfy send drains the publish response body inside the timeout window", async () => {
  // A send that returns on headers alone would leave a stalled body
  // transfer open past the deadline; the body must be read (and thus
  // covered by the abort race) before the result is reported.
  const drained = [];
  const { fetch } = fakeFetch([
    ok,
    {
      ok: true,
      status: 200,
      text: async () => {
        drained.push(true);
      },
    },
  ]);
  const ntfy = await createNtfy({ config: { topic: "mytopic" }, fetchImpl: fetch });

  const result = await ntfy.send({ message: "hi" });
  assert.deepEqual(result, { ok: true });
  assert.equal(drained.length, 1);
});

test("ntfy can mark a message as markdown", async () => {
  const { requests, fetch } = fakeFetch([ok]);
  const ntfy = await createNtfy({ config: { topic: "mytopic" }, fetchImpl: fetch });

  await ntfy.send({ message: "**Which database?**", markdown: true });
  assert.equal(requests[1].options.headers.Markdown, "yes");

  await ntfy.send({ message: "plain" });
  assert.equal(requests[2].options.headers.Markdown, undefined);
});

test("ntfy send serializes action buttons into the Actions header", async () => {
  const { requests, fetch } = fakeFetch([ok, ok, ok, ok, ok]);
  const plain = await createNtfy({
    config: { topic: "mytopic" },
    // Buttons and polls target the reply topic; the caller picks it, here
    // the base topic itself.
    replyTopic: "mytopic",
    fetchImpl: fetch,
  });

  await plain.send({
    message: "Permission requested",
    actions: [
      { label: "Approve once", body: "yes" },
      { label: "Reject, for now", body: "no" },
    ],
  });
  assert.equal(
    requests[1].options.headers.Actions,
    "http, Approve once, https://ntfy.sh/mytopic, body=yes, clear=true; " +
      'http, "Reject, for now", https://ntfy.sh/mytopic, body=no, clear=true',
  );

  // Authenticated servers forward the Authorization header to the buttons
  // so tapping one can still publish to the reply topic.
  process.env.TEST_NTFY_TOKEN = "tk_secret";
  try {
    const authed = await createNtfy({
      config: {
        topic: "mytopic",
        server: "https://ntfy.example.com",
        tokenEnv: "TEST_NTFY_TOKEN",
      },
      replyTopic: "mytopic",
      fetchImpl: fetch,
    });
    await authed.send({ message: "hi", actions: [{ label: "Reject", body: "no" }] });
    assert.equal(
      requests[3].options.headers.Actions,
      "http, Reject, https://ntfy.example.com/mytopic, body=no, clear=true, " +
        "headers.Authorization=Bearer tk_secret",
    );
  } finally {
    delete process.env.TEST_NTFY_TOKEN;
  }

  // Non-ASCII button labels get RFC 2047 encoded like any other header.
  await plain.send({ message: "hi", actions: [{ label: "Onayla ✅", body: "yes" }] });
  const expected = "http, Onayla ✅, https://ntfy.sh/mytopic, body=yes, clear=true";
  assert.equal(
    requests[4].options.headers.Actions,
    `=?UTF-8?B?${Buffer.from(expected, "utf8").toString("base64")}?=`,
  );
});

test("ntfy caps the message body to the configured byte limit", async () => {
  const { requests, fetch } = fakeFetch([ok, ok, ok, ok]);
  const ntfy = await createNtfy({ config: { topic: "mytopic" }, fetchImpl: fetch });

  // Default: below ntfy's 4096-byte cap, even for multibyte text.
  await ntfy.send({ message: "é".repeat(5000) });
  assert.ok(Buffer.byteLength(requests[1].options.body, "utf8") <= 3800);

  // Self-hosted servers can raise message_size_limit; the cap follows.
  const bigger = await createNtfy({
    config: { topic: "mytopic", maxMessageBytes: 100 },
    fetchImpl: fetch,
  });
  await bigger.send({ message: "x".repeat(500) });
  assert.ok(Buffer.byteLength(requests[3].options.body, "utf8") <= 100);
});

test("ntfy polls the topic for messages since a cursor", async () => {
  const body = [
    JSON.stringify({ id: "a1", time: 1, event: "open", topic: "mytopic" }),
    JSON.stringify({ id: "m1", time: 2, event: "message", topic: "mytopic", message: "1" }),
    "",
    "not json",
    JSON.stringify({ id: "m2", time: 3, event: "message", topic: "mytopic", message: "yes" }),
  ].join("\n");
  const { requests, fetch } = fakeFetch([{ ok: true, status: 200, text: async () => body }]);
  const ntfy = await createNtfy({
    config: { topic: "mytopic" },
    replyTopic: "mytopic",
    fetchImpl: fetch,
  });

  const result = await ntfy.poll({ since: 1700000000 });
  assert.equal(requests[1].url, "https://ntfy.sh/mytopic/json?poll=1&since=1700000000");
  assert.equal(requests[1].options.method, undefined);
  assert.deepEqual(result, {
    ok: true,
    lastId: "m2",
    messages: [
      { id: "m1", time: 2, event: "message", topic: "mytopic", message: "1" },
      { id: "m2", time: 3, event: "message", topic: "mytopic", message: "yes" },
    ],
  });
});

test("ntfy routes replies to a per-instance reply topic while publishing to the base topic", async () => {
  const { requests, fetch } = fakeFetch([ok, ok, ok]);
  const ntfy = await createNtfy({
    config: { topic: "opencode-notify", server: "https://ntfy.example.com" },
    replyTopic: "opencode-notify-a1b2c3d4",
    fetchImpl: fetch,
  });

  assert.equal(ntfy.replyUrl, "https://ntfy.example.com/opencode-notify-a1b2c3d4");

  // Notifications still publish to the configured topic...
  await ntfy.send({
    message: "Question needs your answer",
    actions: [{ label: "Approve once", body: "yes" }],
    click: ntfy.replyUrl,
  });
  assert.equal(requests[1].url, "https://ntfy.example.com/opencode-notify");
  // ...but buttons POST to the reply topic, and tapping opens its web view.
  assert.equal(
    requests[1].options.headers.Actions,
    "http, Approve once, https://ntfy.example.com/opencode-notify-a1b2c3d4, body=yes, clear=true",
  );
  assert.equal(
    requests[1].options.headers.Click,
    "https://ntfy.example.com/opencode-notify-a1b2c3d4",
  );

  // The poll loop only ever reads the reply topic.
  await ntfy.poll({ since: 1700000000 });
  assert.equal(
    requests[2].url,
    "https://ntfy.example.com/opencode-notify-a1b2c3d4/json?poll=1&since=1700000000",
  );
});

test("ntfy derives a valid reply topic when the base topic is too long", async () => {
  // A 64-char base topic leaves no room for the instance suffix; the reply
  // topic must still be valid AND not the base topic itself, or the broker
  // would poll the notification topic and consume its own pushes.
  const longTopic = "t".repeat(64);
  const { requests, fetch } = fakeFetch([ok, ok, ok, ok]);
  const ntfy = await createNtfy({
    config: { topic: longTopic },
    replyTopic: `${longTopic}-a1b2c3d4`,
    fetchImpl: fetch,
  });

  assert.match(ntfy.replyUrl, new RegExp(`https://ntfy\\.sh/${"t".repeat(55)}-[0-9a-f]{8}$`));
  assert.notEqual(ntfy.replyUrl, `https://ntfy.sh/${longTopic}`);

  await ntfy.send({
    message: "Question needs your answer",
    actions: [{ label: "Approve once", body: "yes" }],
    click: ntfy.replyUrl,
  });
  // The push itself still lands on the full base topic.
  assert.equal(requests[1].url, `https://ntfy.sh/${longTopic}`);
  // Buttons and the Click URL point at the derived reply topic.
  assert.match(requests[1].options.headers.Actions, /, https:\/\/ntfy\.sh\/t{55}-[0-9a-f]{8},/);
  assert.match(requests[1].options.headers.Click, /t{55}-[0-9a-f]{8}$/);

  await ntfy.poll();
  assert.match(requests[2].url, /\/t{55}-[0-9a-f]{8}\/json\?poll=1$/);

  // Two instances derive different reply topics, never the base topic.
  const second = await createNtfy({ config: { topic: longTopic }, fetchImpl: fetch });
  assert.notEqual(second.replyUrl, ntfy.replyUrl);
  assert.notEqual(second.replyUrl, `https://ntfy.sh/${longTopic}`);
});

test("ntfy can use a separate token for action buttons", async () => {
  process.env.TEST_NTFY_TOKEN = "tk_publish";
  process.env.TEST_NTFY_ACTIONS_TOKEN = "tk_actions";
  try {
    const { requests, fetch } = fakeFetch([ok, ok]);
    const ntfy = await createNtfy({
      config: {
        topic: "mytopic",
        tokenEnv: "TEST_NTFY_TOKEN",
        actionsTokenEnv: "TEST_NTFY_ACTIONS_TOKEN",
      },
      replyTopic: "mytopic",
      fetchImpl: fetch,
    });

    await ntfy.send({ message: "hi", actions: [{ label: "Reject", body: "no" }] });
    // Publishing uses the main token...
    assert.equal(requests[1].options.headers.Authorization, "Bearer tk_publish");
    // ...while the buttons handed to subscribers carry the restricted one.
    assert.equal(
      requests[1].options.headers.Actions,
      "http, Reject, https://ntfy.sh/mytopic, body=no, clear=true, " +
        "headers.Authorization=Bearer tk_actions",
    );
  } finally {
    delete process.env.TEST_NTFY_TOKEN;
    delete process.env.TEST_NTFY_ACTIONS_TOKEN;
  }

  // A missing actions token is reported explicitly, like a missing token.
  process.env.TEST_NTFY_TOKEN = "tk_publish";
  try {
    const { fetch } = fakeFetch([ok]);
    const missing = await createNtfy({
      config: {
        topic: "mytopic",
        tokenEnv: "TEST_NTFY_TOKEN",
        actionsTokenEnv: "TEST_NTFY_ACTIONS_TOKEN",
      },
      fetchImpl: fetch,
    });
    assert.equal(missing.available, false);
    assert.equal(
      missing.reason,
      "environment variable TEST_NTFY_ACTIONS_TOKEN (ntfy actions token) is not set",
    );
  } finally {
    delete process.env.TEST_NTFY_TOKEN;
  }
});

test("fetchWithTimeout aborts a response that stalls mid-body", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    // Headers arrived, but the body never finishes - and it ignores the
    // abort signal, like a server that stalls mid-stream.
    text: () => new Promise(() => {}),
  });

  await assert.rejects(
    fetchWithTimeout("https://ntfy.sh/x", {}, 50, fetchImpl, (response) => response.text()),
    /request timed out/,
  );
});

test("fetchWithTimeout aborts a request whose headers never arrive", async () => {
  // The fetch itself hangs: the timeout must reject without leaving an
  // unhandled abort rejection behind (which could crash the host).
  const fetchImpl = () => new Promise(() => {});

  await assert.rejects(
    fetchWithTimeout("https://ntfy.sh/x", {}, 50, fetchImpl),
    /request timed out/,
  );
});

test("ntfy reads the token from the environment variable named by tokenEnv", async () => {
  process.env.TEST_NTFY_TOKEN = "tk_from_env";
  try {
    const { requests, fetch } = fakeFetch([ok]);
    const ntfy = await createNtfy({
      config: { topic: "mytopic", tokenEnv: "TEST_NTFY_TOKEN" },
      fetchImpl: fetch,
    });

    assert.equal(ntfy.available, true);
    assert.equal(requests[0].options.headers.Authorization, "Bearer tk_from_env");
  } finally {
    delete process.env.TEST_NTFY_TOKEN;
  }

  // A missing environment variable is reported explicitly instead of
  // surfacing as a confusing 401 from the server probe.
  const { fetch } = fakeFetch([ok]);
  const missing = await createNtfy({
    config: { topic: "mytopic", tokenEnv: "TEST_NTFY_TOKEN" },
    fetchImpl: fetch,
  });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, "environment variable TEST_NTFY_TOKEN (ntfy token) is not set");
});

test("ntfy reports poll failures without throwing and keeps the cursor with the caller", async () => {
  const { fetch } = fakeFetch([ok, { ok: false, status: 500 }]);
  const ntfy = await createNtfy({ config: { topic: "mytopic" }, fetchImpl: fetch });

  const result = await ntfy.poll();
  assert.deepEqual(result, { ok: false, error: "HTTP 500" });
});

test("ntfy reports network errors during poll without throwing", async () => {
  const { fetch } = fakeFetch([ok, new Error("poll hang up")]);
  const ntfy = await createNtfy({ config: { topic: "mytopic" }, fetchImpl: fetch });

  const result = await ntfy.poll();
  assert.deepEqual(result, { ok: false, error: "poll hang up" });
});

test("ntfy is unavailable when the server cannot be reached", async () => {
  const { fetch } = fakeFetch([new Error("ECONNREFUSED")]);
  const ntfy = await createNtfy({ config: { topic: "mytopic" }, fetchImpl: fetch });

  assert.equal(ntfy.available, false);
  assert.equal(ntfy.configured, true);
  assert.match(ntfy.reason, /unreachable/);
});

test("ntfy is unavailable when the server rejects the credentials", async () => {
  process.env.TEST_NTFY_TOKEN = "tk_bad";
  try {
    const { fetch } = fakeFetch([{ ok: false, status: 401 }]);
    const ntfy = await createNtfy({
      config: { topic: "mytopic", tokenEnv: "TEST_NTFY_TOKEN" },
      fetchImpl: fetch,
    });

    assert.equal(ntfy.available, false);
    assert.match(ntfy.reason, /rejected credentials/);
  } finally {
    delete process.env.TEST_NTFY_TOKEN;
  }
});

test("ntfy rejects invalid server URLs and topic names", async () => {
  const { fetch } = fakeFetch([ok]);
  const badServer = await createNtfy({
    config: { server: "ntfy.example.com", topic: "t" },
    fetchImpl: fetch,
  });
  assert.equal(badServer.available, false);
  assert.match(badServer.reason, /invalid ntfy server URL/);
  assert.deepEqual(await badServer.send(), { ok: true, skipped: true });

  const badTopic = await createNtfy({ config: { topic: "has spaces" }, fetchImpl: fetch });
  assert.equal(badTopic.available, false);
  assert.match(badTopic.reason, /invalid ntfy topic name/);
});

test("lock detection reads the session lock state from the IORegistry", async () => {
  const calls = [];
  const locked = await createLock({
    platform: "darwin",
    binaryExists: async () => true,
    execute: async (...args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: `<key>IOConsoleUsers</key><array><dict><key>CGSSessionScreenIsLocked</key>\n\t\t<true/></dict></array>`,
      };
    },
  });

  assert.equal(locked.available, true);
  assert.equal(await locked.isLocked(), true);
  assert.deepEqual(calls, [["ioreg", ["-n", "Root", "-d1", "-a"]]]);
});

test("lock detection reports unlocked when the registry key is absent", async () => {
  const lock = await createLock({
    platform: "darwin",
    binaryExists: async () => true,
    execute: async () => ({ code: 0, stdout: "<key>IOConsoleUsers</key><array><dict/></array>" }),
  });

  assert.equal(await lock.isLocked(), false);
});

test("lock detection reports unlocked when the registry read fails", async () => {
  const lock = await createLock({
    platform: "darwin",
    binaryExists: async () => true,
    execute: async () => ({ code: 1, stdout: "" }),
  });

  assert.equal(await lock.isLocked(), false);
});

test("lock detection is unavailable without ioreg on macOS", async () => {
  const lock = await createLock({ platform: "darwin", binaryExists: async () => false });
  assert.equal(lock.available, false);
  assert.equal(await lock.isLocked(), false);
});
