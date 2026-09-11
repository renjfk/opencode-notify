import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { createPushCoalescer } from "../lib/coalesce.js";
import { createTui } from "../index.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

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
  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
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

test("sends an ntfy push instead of desktop notification when the screen is locked", async () => {
  const fixture = await createFixture(
    {
      tabActive: true,
      ghosttyVisible: true,
      locked: true,
      ntfy: true,
      agentText: "Need a DB choice.",
    },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("question.asked", {
    properties: {
      id: "que_1",
      sessionID: "session-1",
      questions: [
        {
          question: "Which database?",
          header: "Database",
          options: [
            { label: "Postgres", description: "" },
            { label: "MySQL", description: "" },
          ],
        },
      ],
    },
  });

  assert.deepEqual(fixture.ntfy.calls, [
    {
      title: "Implement notifications",
      message:
        "Need a DB choice.\n" +
        "\n" +
        "**Which database?**\n" +
        "1) Postgres  2) MySQL\n" +
        "\n" +
        '_Tap the notification to reply by text: a number, a label, or your own text, or "skip" to dismiss._',
      priority: "high",
      tags: ["question"],
      markdown: true,
      // Answerable pushes open the per-instance reply topic's web view when
      // tapped, so they can be answered by text as well as buttons.
      click: "https://ntfy.sh/opencode-notify-abc123-a1b2c3d4",
      actions: [
        { label: "Postgres", body: "a1b2c3 1" },
        { label: "MySQL", body: "a1b2c3 2" },
      ],
    },
  ]);
  assert.equal(fixture.notifier.calls.length, 0);
  assert.equal(fixture.sound.playCount, 0);
  // Locked with the tab active: push only. The blink marker points to a
  // background tab; blinking the tab the session is on would just flicker.
  assert.equal(fixture.zellij.startCount, 0);

  // The request stays tracked for phone replies; settle the session so the
  // reply poll stops and the test process can exit.
  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
});

test("task completed pushes carry the agent's last message without reply buttons", async () => {
  const fixture = await createFixture(
    {
      tabActive: true,
      ghosttyVisible: true,
      locked: true,
      ntfy: true,
      agentText: "Deployed to staging.",
    },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
  await fixture.emit("session.idle", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.ntfy.calls[0].title, "Implement notifications");
  assert.equal(fixture.ntfy.calls[0].message, "Deployed to staging.");
  assert.equal(fixture.ntfy.calls[0].markdown, true);
  assert.ok(!fixture.ntfy.calls[0].actions);
  assert.equal(fixture.clientCalls.length, 0);
});

test("permission pushes get approve, always, and reject buttons", async () => {
  const fixture = await createFixture(
    { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("permission.asked", {
    properties: {
      id: "per_9",
      sessionID: "session-1",
      permission: "bash",
      patterns: ["rm -rf *"],
      always: ["bash:rm -rf *"],
    },
  });

  assert.deepEqual(fixture.ntfy.calls[0].actions, [
    { label: "Approve once", body: "a1b2c3 yes" },
    { label: "Always", body: "a1b2c3 always" },
    { label: "Reject", body: "a1b2c3 no" },
  ]);

  // Settle the session so the reply poll stops and the test process exits.
  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
});

test("answers a pushed question from an ntfy reply", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const fixture = await createFixture(
      { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true },
      { ntfy: { topic: "opencode-notify-abc123" } },
    );

    await fixture.emit("question.asked", {
      properties: {
        id: "que_2",
        sessionID: "session-1",
        questions: [
          {
            question: "Which database?",
            header: "Database",
            options: [
              { label: "Postgres", description: "" },
              { label: "MySQL", description: "" },
            ],
          },
        ],
      },
    });
    assert.equal(fixture.ntfy.calls.length, 1);

    // Reply with the exact body a notification button would POST: the tag
    // routes the answer back to this request.
    fixture.queueReply("a1b2c3 1");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(fixture.clientCalls, [
      ["question.reply", { requestID: "que_2", answers: [["Postgres"]] }],
    ]);
    const confirmation = fixture.ntfy.calls.at(-1);
    // Confirmations are titled with the session, like the push they answer.
    assert.equal(confirmation.title, "Implement notifications");
    assert.equal(confirmation.message, "Answered: Postgres");

    // The poll loop stopped once nothing is pending.
    await mock.timers.tick(10000);
    await flush();
    assert.equal(fixture.ntfy.calls.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("answers a pushed multi-question form from an ntfy reply", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const fixture = await createFixture(
      { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true },
      { ntfy: { topic: "opencode-notify-abc123" } },
    );

    await fixture.emit("question.asked", {
      properties: {
        id: "que_3",
        sessionID: "session-1",
        questions: [
          {
            question: "Which database?",
            header: "Database",
            options: [
              { label: "Postgres", description: "" },
              { label: "MySQL", description: "" },
            ],
          },
          {
            question: "Migrate data?",
            header: "Migration",
            multiple: true,
            options: [
              { label: "Schema only", description: "" },
              { label: "Everything", description: "" },
              { label: "Nothing", description: "" },
            ],
          },
        ],
      },
    });

    fixture.queueReply("1,1+3");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(fixture.clientCalls, [
      [
        "question.reply",
        {
          requestID: "que_3",
          answers: [["Postgres"], ["Schema only", "Nothing"]],
        },
      ],
    ]);
  } finally {
    mock.timers.reset();
  }
});

test("answers a pushed permission from an ntfy reply", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const fixture = await createFixture(
      { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true },
      { ntfy: { topic: "opencode-notify-abc123" } },
    );

    await fixture.emit("permission.asked", {
      properties: {
        id: "per_1",
        sessionID: "session-1",
        permission: "bash",
        patterns: ["git push"],
        always: ["git push"],
      },
    });
    assert.match(fixture.ntfy.calls[0].message, /\*\*Permission requested: bash\*\*/);
    assert.match(fixture.ntfy.calls[0].message, /`git push`/);

    fixture.queueReply("always");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(fixture.clientCalls, [
      ["permission.reply", { requestID: "per_1", reply: "always" }],
    ]);
    assert.equal(fixture.ntfy.calls.at(-1).message, "Approved bash (always).");
  } finally {
    mock.timers.reset();
  }
});

test("an unparseable reply gets help and keeps the request pending", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const fixture = await createFixture(
      { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true },
      { ntfy: { topic: "opencode-notify-abc123" } },
    );

    await fixture.emit("permission.asked", {
      properties: { id: "per_2", sessionID: "session-1", permission: "bash", patterns: ["rm -rf"] },
    });

    fixture.queueReply("maybe");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(fixture.clientCalls, []);
    assert.equal(
      fixture.ntfy.calls.at(-1).message,
      'Could not read that reply. Reply "yes", "always", or "no".',
    );

    // Still pending: a valid reply right after works.
    fixture.queueReply("no");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(fixture.clientCalls, [
      ["permission.reply", { requestID: "per_2", reply: "reject" }],
    ]);
    assert.equal(fixture.ntfy.calls.at(-1).message, "Rejected bash.");
  } finally {
    mock.timers.reset();
  }
});

test("a reply after the request was answered in the TUI gets a notice", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const fixture = await createFixture(
      { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true },
      { ntfy: { topic: "opencode-notify-abc123" } },
    );

    await fixture.emit("permission.asked", {
      properties: { id: "per_3", sessionID: "session-1", permission: "bash", patterns: ["ls"] },
    });

    await fixture.emit("permission.replied", {
      properties: { requestID: "per_3", sessionID: "session-1" },
    });

    fixture.queueReply("yes");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(fixture.clientCalls, []);
    assert.equal(
      fixture.ntfy.calls.at(-1).message,
      "No pending request to answer (already answered, or expired).",
    );
  } finally {
    mock.timers.reset();
  }
});

test("the reply channel can be disabled with ntfy.replies: false", async () => {
  const fixture = await createFixture(
    { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true },
    { ntfy: { topic: "opencode-notify-abc123", replies: false } },
  );

  await fixture.emit("question.asked", {
    properties: {
      id: "que_4",
      sessionID: "session-1",
      questions: [
        {
          question: "Which database?",
          header: "Database",
          options: [{ label: "Postgres", description: "" }],
        },
      ],
    },
  });

  assert.equal(fixture.ntfy.calls[0].message, "Question needs your answer");
  assert.ok(!fixture.ntfy.calls[0].markdown);
});

test("minimal detail keeps pushes generic like desktop notifications, with no reply channel", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const fixture = await createFixture(
      { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true, agentText: "Need a DB." },
      { ntfy: { topic: "opencode-notify-abc123", detail: "minimal" } },
    );

    await fixture.emit("question.asked", {
      properties: {
        id: "que_5",
        sessionID: "session-1",
        questions: [
          {
            question: "Which database?",
            header: "Database",
            options: [
              { label: "Postgres", description: "" },
              { label: "MySQL", description: "" },
            ],
          },
        ],
      },
    });

    assert.equal(fixture.ntfy.calls[0].title, "Implement notifications");
    assert.equal(fixture.ntfy.calls[0].message, "Question needs your answer");
    assert.ok(!fixture.ntfy.calls[0].markdown);

    // Nothing is tracked, so a reply on the topic does nothing at all.
    fixture.queueReply("1");
    await mock.timers.tick(5000);
    await flush();
    await flush();
    assert.deepEqual(fixture.clientCalls, []);
    assert.equal(fixture.ntfy.calls.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("push mode still blinks a background tab when locked", async () => {
  const fixture = await createFixture(
    { tabActive: false, locked: true, ntfy: true },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
  await fixture.emit("session.idle", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.ntfy.calls.length, 1);
  assert.equal(fixture.zellij.startCount, 1);
});

test("always-on mode stays quiet while the session is watched", async () => {
  const fixture = await createFixture(
    { tabActive: true, ghosttyVisible: true, locked: false, ntfy: true, pushMode: "on" },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
  await fixture.emit("session.idle", { properties: { sessionID: "session-1" } });

  // The push replaces the desktop notification: while the user is watching
  // the session there is nothing to signal - no push, no blink, no toast.
  assert.equal(fixture.ntfy.calls.length, 0);
  assert.equal(fixture.notifier.calls.length, 0);
  assert.equal(fixture.zellij.startCount, 0);
});

test("always-on mode keeps the in-terminal signals on a visible background tab", async () => {
  const fixture = await createFixture(
    { tabActive: false, ghosttyVisible: true, locked: false, ntfy: true, pushMode: "on" },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
  await fixture.emit("session.idle", { properties: { sessionID: "session-1" } });

  // Mirrors the desktop path: blink + sound, no push (the terminal is up).
  assert.equal(fixture.ntfy.calls.length, 0);
  assert.equal(fixture.notifier.calls.length, 0);
  assert.equal(fixture.zellij.startCount, 1);
  assert.equal(fixture.sound.playCount, 1);
});

test("always-on mode pushes when the terminal is not visible", async () => {
  const fixture = await createFixture(
    { tabActive: true, ghosttyVisible: false, locked: false, ntfy: true, pushMode: "on" },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.ntfy.calls.length, 1);
  assert.equal(fixture.notifier.calls.length, 0);

  // Settle the session so the tracked request stops the reply poll.
  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
});

test("off mode suppresses pushes even when the screen is locked", async () => {
  const fixture = await createFixture(
    { tabActive: false, ghosttyVisible: false, locked: true, ntfy: true, pushMode: "off" },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.ntfy.calls.length, 0);
  assert.equal(fixture.notifier.calls.length, 1);
});

test("off mode still queues a desktop notification when locked with everything visible", async () => {
  const fixture = await createFixture(
    { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true, pushMode: "off" },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.ntfy.calls.length, 0);
  assert.equal(fixture.notifier.calls.length, 1);

  // The visibility poll started; go busy again so its timer is stopped.
  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
});

test("visibility poll does not clear the notification while the screen stays locked", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const fixture = await createFixture({ tabActive: true, ghosttyVisible: false, locked: true });

    await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });
    assert.equal(fixture.notifier.calls.length, 1);

    // Ghostty reports windows behind the lock screen; the notification must
    // survive while the screen is locked.
    fixture.setGhosttyVisible(true);
    await mock.timers.tick(1000);
    await flush();
    assert.equal(fixture.notifier.clearCount, 0);

    // After unlock with the terminal visible, the notification is cleared.
    fixture.setLocked(false);
    await mock.timers.tick(1000);
    await flush();
    assert.equal(fixture.notifier.clearCount, 1);
  } finally {
    mock.timers.reset();
  }
});

test("mode commands persist the choice, toast, and take effect immediately", async () => {
  const fixture = await createFixture(
    { tabActive: true, ghosttyVisible: false, locked: false, ntfy: true },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  const names = fixture.commands.map((command) => command.name);
  assert.deepEqual(names, ["notify.push.auto", "notify.push.on", "notify.push.off"]);

  fixture.commands.find((command) => command.name === "notify.push.on").run();
  assert.equal(fixture.kv.get("notify.pushMode"), "on");
  assert.match(fixture.toasts.at(-1).message, /always on/);

  await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });
  assert.equal(fixture.ntfy.calls.length, 1);
});

test("auto mode command warns when lock detection is unavailable", async () => {
  const fixture = await createFixture(
    { tabActive: true, ghosttyVisible: false, ntfy: true, lockAvailable: false },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  fixture.commands.find((command) => command.name === "notify.push.auto").run();
  assert.equal(fixture.kv.get("notify.pushMode"), "auto");
  assert.match(fixture.toasts.at(-1).message, /lock detection unavailable/);
});

test("mode commands are not registered when ntfy is not configured", async () => {
  const fixture = await createFixture({ tabActive: true, ghosttyVisible: false });

  assert.deepEqual(fixture.commands, []);
});

test("toasts when the desktop notification fails", async () => {
  const fixture = await createFixture({
    tabActive: false,
    ghosttyVisible: false,
    notifierResult: { code: 1 },
  });

  await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.notifier.calls.length, 1);
  assert.match(fixture.toasts.at(-1).message, /desktop notification failed \(exit 1\)/);
});

test("toasts when the ntfy push fails", async () => {
  const fixture = await createFixture(
    {
      tabActive: true,
      ghosttyVisible: true,
      locked: true,
      ntfy: true,
      ntfyResult: { ok: false, error: "HTTP 429" },
    },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.ntfy.calls.length, 1);
  assert.match(fixture.toasts.at(-1).message, /ntfy push failed \(HTTP 429\)/);
});

test("toasts when handling an event throws", async () => {
  const fixture = await createFixture({ throwOnTabActive: true });

  await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });

  assert.match(fixture.toasts.at(-1).message, /Notify error: boom/);
});

test("stops the visibility poll and clears the notification when Ghostty becomes visible", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const fixture = await createFixture({ tabActive: true, ghosttyVisible: false });

    await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });
    assert.equal(fixture.notifier.clearCount, 0);

    fixture.setGhosttyVisible(true);
    await mock.timers.tick(1000);
    await flush();
    assert.equal(fixture.notifier.clearCount, 1);

    await mock.timers.tick(2000);
    await flush();
    assert.equal(fixture.notifier.clearCount, 1);
  } finally {
    mock.timers.reset();
  }
});

test("reads the persisted push mode once the kv store loads", async () => {
  const fixture = await createFixture(
    {
      tabActive: true,
      ghosttyVisible: false,
      locked: false,
      ntfy: true,
      pushMode: "on",
      kvReadyDelay: 40,
    },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.ntfy.calls.length, 1);
});

test("warns when ntfy is configured but the server is unusable", async () => {
  const fixture = await createFixture(
    { tabActive: true, ghosttyVisible: false, ntfyBroken: true },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  assert.match(fixture.toasts.at(-1).message, /ntfy push disabled \(ntfy server unreachable/);
});

test("keeps the desktop notification alongside ntfy when configured with desktop keep", async () => {
  const fixture = await createFixture(
    { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true },
    { ntfy: { topic: "opencode-notify-abc123", desktop: "keep" } },
  );

  await fixture.emit("permission.asked", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.ntfy.calls.length, 1);
  assert.deepEqual(fixture.notifier.calls, [
    {
      title: "work",
      subtitle: "Implement notifications",
      message: "Permission requested",
      sound: "Blow",
    },
  ]);
});

test("lets a configured priority override the per-event default", async () => {
  const fixture = await createFixture(
    { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true },
    { ntfy: { topic: "opencode-notify-abc123", priority: "urgent" } },
  );

  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
  await fixture.emit("session.idle", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.ntfy.calls[0].priority, "urgent");
  assert.equal(fixture.ntfy.calls[0].message, "Task completed");
});

test("does not push to ntfy when the screen is not locked", async () => {
  const fixture = await createFixture(
    { tabActive: false, ghosttyVisible: false, locked: false, ntfy: true },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.ntfy.calls.length, 0);
  assert.equal(fixture.notifier.calls.length, 1);
});

test("falls back to a desktop notification when locked without ntfy", async () => {
  const fixture = await createFixture({ tabActive: true, ghosttyVisible: true, locked: true });

  await fixture.emit("question.asked", { properties: { sessionID: "session-1" } });

  assert.equal(fixture.ntfy.calls.length, 0);
  assert.equal(fixture.notifier.calls.length, 1);
  assert.equal(fixture.zellij.startCount, 0);

  // Locked counts as not visible, which starts the visibility poll. Go busy
  // again so the poll timer is stopped and the test process can exit.
  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
});

test("a push that lands after the session goes busy does not restart blinking", async () => {
  const fixture = await createFixture(
    { tabActive: false, ghosttyVisible: false, locked: true, ntfy: true, holdNtfySend: true },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  const attention = fixture.emit("question.asked", { properties: { sessionID: "session-1" } });
  await flush();
  assert.equal(fixture.ntfy.calls.length, 1);

  // The user answers while the push is still in flight; the busy handler
  // stops blinking and clears notifications.
  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
  assert.equal(fixture.zellij.stopCount, 1);

  fixture.releaseNtfySend();
  await attention;

  // The stale attention handler must not start blinking again.
  assert.equal(fixture.ntfy.calls.length, 1);
  assert.equal(fixture.zellij.startCount, 0);
});

test("another session going busy does not cancel an in-flight push", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const fixture = await createFixture(
      { tabActive: false, ghosttyVisible: false, locked: true, ntfy: true, holdNtfySend: true },
      { ntfy: { topic: "opencode-notify-abc123" } },
    );

    const attention = fixture.emit("question.asked", {
      properties: {
        id: "que_5",
        sessionID: "session-1",
        questions: [
          {
            question: "Which database?",
            header: "Database",
            options: [
              { label: "Postgres", description: "" },
              { label: "MySQL", description: "" },
            ],
          },
        ],
      },
    });
    await flush();

    // A different session becomes active while session-1's push is in
    // flight: only that session's attention work is stale, not session-1's.
    await fixture.emit("session.status", {
      properties: { status: { type: "busy" }, sessionID: "session-2" },
    });

    fixture.releaseNtfySend();
    await attention;

    assert.equal(fixture.ntfy.calls.length, 1);
    // The background tab still gets its blink marker, and the request is
    // still tracked: its button body answers it.
    assert.equal(fixture.zellij.startCount, 1);
    fixture.queueReply("a1b2c3 1");
    await mock.timers.tick(5000);
    await flush();
    await flush();
    assert.deepEqual(fixture.clientCalls, [
      ["question.reply", { requestID: "que_5", answers: [["Postgres"]] }],
    ]);
  } finally {
    mock.timers.reset();
  }
});

test("a reply posted while the push response is still in flight is answered", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const fixture = await createFixture(
      { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true, holdNtfySend: true },
      { ntfy: { topic: "opencode-notify-abc123" } },
    );

    const attention = fixture.emit("question.asked", {
      properties: {
        id: "que_6",
        sessionID: "session-1",
        questions: [
          {
            question: "Which database?",
            header: "Database",
            options: [
              { label: "Postgres", description: "" },
              { label: "MySQL", description: "" },
            ],
          },
        ],
      },
    });
    await flush();
    assert.equal(fixture.ntfy.calls.length, 1);

    // The push reached the phone and was answered before the publish
    // response returned here. The request was registered before publishing,
    // so the reply is picked up instead of being lost to the poll cursor.
    fixture.queueReply("a1b2c3 2");
    await mock.timers.tick(5000);
    await flush();
    await flush();
    assert.deepEqual(fixture.clientCalls, [
      ["question.reply", { requestID: "que_6", answers: [["MySQL"]] }],
    ]);

    fixture.releaseNtfySend();
    await attention;
  } finally {
    mock.timers.reset();
  }
});

test("a push that lands after disposal does not restart the reply channel", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const fixture = await createFixture(
      { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true, holdNtfySend: true },
      { ntfy: { topic: "opencode-notify-abc123" } },
    );

    const attention = fixture.emit("permission.asked", {
      properties: { id: "per_d", sessionID: "session-1", permission: "bash", patterns: ["rm -rf"] },
    });
    await flush();

    // The plugin is disposed (config reload, shutdown) while its push is
    // in flight: the completing handler must not re-arm the reply channel.
    fixture.stop();
    fixture.releaseNtfySend();
    await attention;

    fixture.queueReply("a1b2c3 yes");
    await mock.timers.tick(5000);
    await flush();
    await flush();
    assert.deepEqual(fixture.clientCalls, []);
  } finally {
    mock.timers.reset();
  }
});

test("switching pushes off cancels notifications queued in the batch window", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const fixture = await createFixture(
      { tabActive: true, ghosttyVisible: false, locked: true, ntfy: true, batchMs: 5000 },
      { ntfy: { topic: "opencode-notify-abc123" } },
    );

    await fixture.emit("session.status", {
      properties: { status: { type: "busy" }, sessionID: "session-1" },
    });
    await fixture.emit("session.idle", { properties: { sessionID: "session-1" } });

    // The task-completed push sits in the batch queue, not yet sent...
    assert.equal(fixture.ntfy.calls.length, 0);

    // ...and turning pushes off must cancel it, not just future pushes.
    fixture.commands.find((command) => command.name === "notify.push.off").run();
    await mock.timers.tick(6000);
    await flush();
    await flush();
    assert.equal(fixture.ntfy.calls.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("turning pushes off while content is still loading cancels the push", async () => {
  const fixture = await createFixture(
    { tabActive: true, ghosttyVisible: true, locked: true, ntfy: true, holdAgentText: true },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  await fixture.emit("session.status", {
    properties: { status: { type: "busy" }, sessionID: "session-1" },
  });
  const attention = fixture.emit("session.idle", { properties: { sessionID: "session-1" } });
  await flush();

  // The agent text lookup is still in flight when the user turns pushes
  // off: the completing handler must not publish what it was loading.
  fixture.commands.find((command) => command.name === "notify.push.off").run();
  fixture.releaseAgentText();
  await attention;

  assert.equal(fixture.ntfy.calls.length, 0);
});

test("warns when ntfy is configured but lock detection is unavailable", async () => {
  const fixture = await createFixture(
    { tabActive: true, ghosttyVisible: false, ntfy: true, lockAvailable: false },
    { ntfy: { topic: "opencode-notify-abc123" } },
  );

  assert.match(fixture.toasts.at(-1).message, /lock detection unavailable/);
});

test("warns and does not subscribe when no capability is available", async () => {
  const fixture = await createFixture({ available: false });

  assert.equal(fixture.handlers.has("question.asked"), false);
  assert.match(fixture.toasts.at(-1).message, /no capabilities available/);
});

async function createFixture(
  {
    available = true,
    tabActive = true,
    ghosttyVisible = false,
    locked = false,
    lockAvailable = true,
    ntfy = false,
    ntfyBroken = false,
    ntfyResult = { ok: true },
    notifierResult = { code: 0 },
    holdNtfySend = false,
    holdAgentText = false,
    batchMs = 0,
    agentText = "",
    pushMode,
    kvReadyDelay = 0,
    throwOnTabActive = false,
  } = {},
  options,
) {
  const handlers = new Map();
  const toasts = [];
  const commands = [];
  const disposers = [];
  const kvStore = {};
  const clientCalls = [];
  const client = {
    permission: {
      reply: async (input) => {
        clientCalls.push(["permission.reply", input]);
        return { data: {} };
      },
    },
    question: {
      reply: async (input) => {
        clientCalls.push(["question.reply", input]);
        return { data: {} };
      },
      reject: async (input) => {
        clientCalls.push(["question.reject", input]);
        return { data: {} };
      },
    },
  };
  const incoming = [];
  let incomingSeq = 0;
  const kvReadyAt = kvReadyDelay ? Date.now() + kvReadyDelay : 0;
  const kv = {
    get ready() {
      return Date.now() >= kvReadyAt;
    },
    get: (key, fallback) => (key in kvStore ? kvStore[key] : fallback),
    set: (key, value) => {
      kvStore[key] = value;
    },
  };
  if (pushMode) kv.set("notify.pushMode", pushMode);
  let releaseHeldNtfySend = null;
  let releaseHeldAgentText = null;
  let agentTextHeld = false;
  let currentGhosttyVisible = ghosttyVisible;
  const zellij = {
    available,
    reason: "unavailable",
    startCount: 0,
    stopCount: 0,
    async isTabActive() {
      if (throwOnTabActive) throw new Error("boom");
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
  const ghostty = {
    available,
    reason: "unavailable",
    isVisible: async () => currentGhosttyVisible,
  };
  let lockState = locked;
  const lock = {
    available: lockAvailable,
    reason: "not macOS",
    isLocked: async () => lockState,
  };
  const notifier = {
    available,
    reason: "unavailable",
    calls: [],
    clearCount: 0,
    async send(notification) {
      this.calls.push(notification);
      return notifierResult;
    },
    async clear() {
      this.clearCount += 1;
    },
  };
  const ntfyCapability = {
    available: ntfyBroken ? false : ntfy,
    configured: ntfy || ntfyBroken,
    reason: ntfyBroken
      ? "ntfy server unreachable (ECONNREFUSED)"
      : ntfy
        ? null
        : "no topic configured",
    calls: [],
    replyUrl: "https://ntfy.sh/opencode-notify-abc123-a1b2c3d4",
    async send(notification) {
      this.calls.push(notification);
      // Hold only the first send (the push itself): later sends, like the
      // reply confirmation published while the push is still in flight,
      // must go through.
      if (holdNtfySend && this.calls.length === 1) {
        await new Promise((resolve) => (releaseHeldNtfySend = resolve));
      }
      return ntfyResult;
    },
    async poll() {
      const messages = incoming.splice(0);
      return { ok: true, messages, lastId: messages.at(-1)?.id ?? null };
    },
  };
  const sound = {
    available,
    playCount: 0,
    async play() {
      this.playCount += 1;
    },
  };
  // Deterministic reply tags: the first answerable push gets a1b2c3, the
  // next d4e5f6, and so on, so action bodies can be asserted exactly.
  const replyTags = ["a1b2c3", "d4e5f6", "0f1e2d"];
  const tui = createTui({
    createZellij: async () => zellij,
    createGhostty: async () => ghostty,
    createLock: async () => lock,
    createNotifier: async () => notifier,
    createNtfy: async () => ntfyCapability,
    createSound: async () => sound,
    // No batch window by default: queued pushes flush immediately so tests
    // can assert without fake timers. Tests that need a real queue pass a
    // window. Dedupe stays active.
    createPushCoalescer: (args) => createPushCoalescer({ ...args, batchMs }),
    getSessionTitle: async () => "Implement notifications",
    // Holds its first lookup when asked, so tests can change state while
    // content is still loading.
    getLastAgentText: async () => {
      if (holdAgentText && !agentTextHeld) {
        agentTextHeld = true;
        await new Promise((resolve) => (releaseHeldAgentText = resolve));
      }
      return agentText;
    },
    generateReplyTag: () => replyTags.shift() ?? "abcdef",
  });
  await tui(
    {
      client,
      event: { on: (type, handler) => handlers.set(type, handler) },
      keymap: {
        registerLayer: (layer) => {
          commands.push(...layer.commands);
        },
      },
      kv,
      lifecycle: { onDispose: (fn) => disposers.push(fn) },
      ui: { toast: (toast) => toasts.push(toast) },
    },
    options,
  );

  return {
    clientCalls,
    commands,
    handlers,
    kv,
    notifier,
    ntfy: ntfyCapability,
    queueReply: (message) =>
      incoming.push({ id: `in_${++incomingSeq}`, event: "message", message }),
    releaseNtfySend: () => releaseHeldNtfySend?.(),
    releaseAgentText: () => releaseHeldAgentText?.(),
    setGhosttyVisible: (value) => {
      currentGhosttyVisible = value;
    },
    setLocked: (value) => {
      lockState = value;
    },
    sound,
    stop: () => disposers.forEach((dispose) => dispose()),
    toasts,
    zellij,
    emit: async (type, event) => {
      await handlers.get(type)(event);
      // Let the push coalescer's immediate flush land before assertions.
      await flush();
      await flush();
    },
  };
}
