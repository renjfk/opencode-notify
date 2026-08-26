import assert from "node:assert/strict";
import test from "node:test";

import { createTui } from "../index.js";

test("does nothing when the tab and terminal are visible", async () => {
  const fixture = await createFixture({ tabActive: true, ghosttyVisible: true });

  await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.notifier.calls.length, 0);
  assert.equal(fixture.zellij.startCount, 0);
  assert.equal(fixture.sound.playCount, 0);
});

test("blinks and plays sound for an inactive tab in a visible terminal", async () => {
  const fixture = await createFixture({ tabActive: false, ghosttyVisible: true });

  await fixture.emit("permission.asked", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.zellij.startCount, 1);
  assert.equal(fixture.sound.playCount, 1);
  assert.equal(fixture.notifier.calls.length, 0);
});

test("blinks and notifies when the inactive tab is not visible", async () => {
  const fixture = await createFixture({ tabActive: false, ghosttyVisible: false });

  await fixture.emit("session.idle", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.zellij.startCount, 0);
  await fixture.emit("session.status", { properties: { status: { type: "busy" } } });
  await fixture.emit("session.idle", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.zellij.startCount, 1);
  assert.deepEqual(fixture.notifier.calls, [
    {
      title: "work",
      subtitle: "Implement notifications",
      message: "Task completed",
      sound: "Blow",
    },
  ]);
});

test("warns and does not subscribe when no capability is available", async () => {
  const fixture = await createFixture({ available: false });

  assert.equal(fixture.handlers.has("question.asked"), false);
  assert.match(fixture.toasts.at(-1).message, /no capabilities available/);
});

async function createFixture({ available = true, tabActive = true, ghosttyVisible = false } = {}) {
  const handlers = new Map();
  const toasts = [];
  const zellij = {
    available,
    reason: "unavailable",
    startCount: 0,
    stopCount: 0,
    async isTabActive() {
      return tabActive;
    },
    async startBlinking() {
      this.startCount += 1;
    },
    async stopBlinking() {
      this.stopCount += 1;
    },
    async getTabName() {
      return "work";
    },
  };
  const ghostty = { available, reason: "unavailable", isVisible: async () => ghosttyVisible };
  const notifier = {
    available,
    reason: "unavailable",
    calls: [],
    async send(notification) {
      this.calls.push(notification);
      return { code: 0 };
    },
    async clear() {},
  };
  const sound = {
    available,
    playCount: 0,
    async play() {
      this.playCount += 1;
    },
  };
  const tui = createTui({
    createZellij: async () => zellij,
    createGhostty: async () => ghostty,
    createNotifier: async () => notifier,
    createSound: async () => sound,
    getSessionTitle: async () => "Implement notifications",
  });
  await tui({
    client: {},
    event: { on: (type, handler) => handlers.set(type, handler) },
    ui: { toast: (toast) => toasts.push(toast) },
  });

  return {
    handlers,
    notifier,
    sound,
    toasts,
    zellij,
    emit: async (type, event) => handlers.get(type)(event),
  };
}
