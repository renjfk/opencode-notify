import assert from "node:assert/strict";
import test from "node:test";

import { createGhostty } from "../lib/ghostty.js";
import { createNotifier } from "../lib/notifier.js";
import { createSound } from "../lib/sound.js";
import { createZellij } from "../lib/zellij.js";

test("capabilities are safe no-ops when unavailable", async () => {
  const zellij = await createZellij({ paneId: null, binaryExists: async () => false });
  const ghostty = await createGhostty({ platform: "linux" });
  const notifier = await createNotifier({ platform: "linux" });
  const sound = await createSound({ platform: "linux" });

  assert.equal(zellij.available, false);
  assert.equal(await zellij.isTabActive(), true);
  assert.equal(ghostty.available, false);
  assert.equal(await ghostty.isVisible(), null);
  assert.equal(notifier.available, false);
  assert.deepEqual(await notifier.send(), { code: 0, skipped: true });
  assert.equal(sound.available, false);
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

test("Ghostty treats failed or invalid AppleScript output as unknown", async () => {
  const ghostty = await createGhostty({
    platform: "darwin",
    binaryExists: async () => true,
    execute: async () => ({ code: 0, stdout: "not a number" }),
  });
  assert.equal(await ghostty.isVisible(), null);
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
});
