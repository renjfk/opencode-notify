import assert from "node:assert/strict";
import test from "node:test";

import { createPushCoalescer } from "../lib/coalesce.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createHarness({ batchMs = 10, dedupeMs = 60_000, maxBytes = 3800, now } = {}) {
  const sent = [];
  const results = [];
  const timers = [];
  let time = 1_000;
  const coalescer = createPushCoalescer({
    send: async (item) => {
      sent.push(item);
      return results.length ? results.shift() : { ok: true };
    },
    onSent: (result) => onSentResults.push(result),
    batchMs,
    dedupeMs,
    maxBytes,
    now: now ?? (() => time),
    setTimeoutFn: (callback, delay) => {
      timers.push({ callback, delay });
      return { unref: () => {} };
    },
    clearTimeoutFn: () => {},
  });
  const onSentResults = [];
  return {
    coalescer,
    fireTimer: () => {
      const timer = timers.shift();
      assert.ok(timer, "no pending flush timer");
      time += batchMs;
      timer.callback();
    },
    onSentResults,
    sent,
    advance: (ms) => {
      time += ms;
    },
  };
}

test("identical pushes within the dedupe window are collapsed", async () => {
  const harness = createHarness();
  harness.coalescer.push({ title: "Work", message: "Task completed" });
  harness.coalescer.push({ title: "Work", message: "Task completed" });
  harness.fireTimer();
  await flush();
  await flush();

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].message, "Task completed");
});

test("identical pushes are sent again after the dedupe window passes", async () => {
  const harness = createHarness({ dedupeMs: 60_000 });
  harness.coalescer.push({ title: "Work", message: "Task completed" });
  harness.fireTimer();
  await flush();
  await flush();

  harness.advance(61_000);
  harness.coalescer.push({ title: "Work", message: "Task completed" });
  harness.fireTimer();
  await flush();
  await flush();

  assert.equal(harness.sent.length, 2);
});

test("distinct pushes within the batch window stack into one notification", async () => {
  const harness = createHarness();
  harness.coalescer.push({
    title: "Session A",
    message: "All tests pass.",
    priority: "default",
    tags: ["white_check_mark"],
    markdown: true,
  });
  harness.coalescer.push({
    title: "Session B",
    message: "Deployed to staging.",
    priority: "high",
    tags: ["white_check_mark"],
    markdown: false,
  });
  harness.fireTimer();
  await flush();
  await flush();

  assert.equal(harness.sent.length, 1);
  assert.deepEqual(harness.sent[0], {
    title: "Session B",
    message: "All tests pass.\n\n---\n\nDeployed to staging.",
    priority: "high",
    tags: ["white_check_mark"],
    markdown: true,
  });
  assert.deepEqual(harness.onSentResults, [{ ok: true }]);
});

test("stacked duplicates collapse to a single line and the body is capped in bytes", async () => {
  const harness = createHarness({ maxBytes: 100 });
  harness.coalescer.push({ title: "A", message: "Task completed" });
  harness.coalescer.push({ title: "B", message: "Task completed" });
  harness.coalescer.push({ title: "B", message: `${"x".repeat(200)}` });
  harness.fireTimer();
  await flush();
  await flush();

  assert.equal(harness.sent.length, 1);
  assert.ok(Buffer.byteLength(harness.sent[0].message, "utf8") <= 100);
  assert.match(harness.sent[0].message, /Task completed\n\n---\n\nx+…/);
});

test("stacked messages share the byte budget evenly", async () => {
  const harness = createHarness({ maxBytes: 200 });
  harness.coalescer.push({ title: "A", message: "a".repeat(500) });
  harness.coalescer.push({ title: "B", message: "b".repeat(500) });
  harness.fireTimer();
  await flush();
  await flush();

  const message = harness.sent[0].message;
  const parts = message.split("\n\n---\n\n");
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^a+…$/);
  assert.match(parts[1], /^b+…$/);
  assert.ok(Buffer.byteLength(message, "utf8") <= 200);
  assert.ok(Math.abs(Buffer.byteLength(parts[0]) - Buffer.byteLength(parts[1])) <= 1);
});

test("failed sends are not remembered, so the next push retries", async () => {
  const results = [{ ok: false, error: "socket hang up" }];
  const sent = [];
  const coalescer = createPushCoalescer({
    send: async (item) => {
      sent.push(item);
      return results.length ? results.shift() : { ok: true };
    },
    batchMs: 10,
    dedupeMs: 60_000,
    maxBytes: 3800,
    now: () => 1_000,
    setTimeoutFn: (callback) => {
      queueMicrotask(callback);
      return { unref: () => {} };
    },
    clearTimeoutFn: () => {},
  });

  coalescer.push({ title: "Work", message: "Task completed" });
  await flush();
  await flush();
  assert.equal(sent.length, 1);

  coalescer.push({ title: "Work", message: "Task completed" });
  await flush();
  await flush();
  assert.equal(sent.length, 2);
});

test("batchMs 0 flushes immediately without a timer", async () => {
  const harness = createHarness({ batchMs: 0 });
  harness.coalescer.push({ title: "Work", message: "Task completed" });
  await flush();
  await flush();

  assert.equal(harness.sent.length, 1);
});

test("a configured low priority is preserved instead of promoted", async () => {
  const harness = createHarness();
  harness.coalescer.push({ title: "Work", message: "Task completed", priority: "low" });
  harness.fireTimer();
  await flush();
  await flush();

  assert.equal(harness.sent[0].priority, "low");
});

test("numeric priorities are preserved and the highest stacked priority wins", async () => {
  const harness = createHarness();
  harness.coalescer.push({ title: "A", message: "Task completed", priority: 5 });
  harness.fireTimer();
  await flush();
  await flush();
  assert.equal(harness.sent[0].priority, 5);

  harness.coalescer.push({ title: "B", message: "Deployed.", priority: "low" });
  harness.coalescer.push({ title: "C", message: "All tests pass.", priority: 4 });
  harness.coalescer.push({ title: "D", message: "Permission requested", priority: "default" });
  harness.fireTimer();
  await flush();
  await flush();
  assert.equal(harness.sent[1].priority, 4);
});

test("stop drops queued pushes and cancels the flush", async () => {
  const harness = createHarness();
  harness.coalescer.push({ title: "Work", message: "Task completed" });
  harness.coalescer.stop();
  await flush();
  await flush();

  assert.equal(harness.sent.length, 0);
});
