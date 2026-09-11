import assert from "node:assert/strict";
import { mock, test } from "node:test";

import {
  createReplyBroker,
  formatIdleMessage,
  formatPermissionMessage,
  formatQuestionMessage,
  parsePermissionReply,
  parseQuestionReply,
  permissionActions,
  questionActions,
} from "../lib/replies.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

const single = [
  {
    question: "Which database?",
    header: "Database",
    options: [
      { label: "Postgres", description: "" },
      { label: "MySQL", description: "" },
    ],
  },
];

const form = [
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
];

test("permission replies accept words and reject feedback", () => {
  assert.deepEqual(parsePermissionReply("yes"), { reply: "once" });
  assert.deepEqual(parsePermissionReply("  Y "), { reply: "once" });
  assert.deepEqual(parsePermissionReply("always"), { reply: "always" });
  assert.deepEqual(parsePermissionReply("no"), { reply: "reject" });
  assert.deepEqual(parsePermissionReply("no: wrong branch"), {
    reply: "reject",
    message: "wrong branch",
  });
  assert.deepEqual(parsePermissionReply("maybe"), null);
  assert.deepEqual(parsePermissionReply(""), null);
});

test("question replies resolve numbers, labels, multi-select, and custom text", () => {
  assert.deepEqual(parseQuestionReply("2", single), { answers: [["MySQL"]] });
  assert.deepEqual(parseQuestionReply("postgres", single), { answers: [["Postgres"]] });
  assert.deepEqual(parseQuestionReply("use Redis", single), { answers: [["use Redis"]] });
  assert.deepEqual(parseQuestionReply("skip", single), { reject: true });

  const multi = [{ ...single[0], multiple: true }];
  assert.deepEqual(parseQuestionReply("1+2", multi), { answers: [["Postgres", "MySQL"]] });
  assert.deepEqual(parseQuestionReply("1+2", single), null);

  const noCustom = [{ ...single[0], custom: false }];
  assert.deepEqual(parseQuestionReply("use Redis", noCustom), null);
  assert.deepEqual(parseQuestionReply("1", noCustom), { answers: [["Postgres"]] });
});

test("form replies need one answer per question", () => {
  assert.deepEqual(parseQuestionReply("1,2+3", form), {
    answers: [["Postgres"], ["Everything", "Nothing"]],
  });
  assert.deepEqual(parseQuestionReply("1,skip", form), { answers: [["Postgres"], []] });
  assert.deepEqual(parseQuestionReply("1,", form), { answers: [["Postgres"], []] });
  assert.deepEqual(parseQuestionReply("1", form), null);
  assert.deepEqual(parseQuestionReply("1,9", form), null);
  assert.deepEqual(parseQuestionReply("1,2,3", form), null);
});

test("question and permission push bodies are compact markdown", () => {
  const message = formatQuestionMessage(single, "I need a choice before migrating.");
  assert.equal(
    message,
    "I need a choice before migrating.\n" +
      "\n" +
      "**Which database?**\n" +
      "1) Postgres  2) MySQL\n" +
      "\n" +
      '_Tap the notification to reply by text: a number, a label, or your own text, or "skip" to dismiss._',
  );

  const formMessage = formatQuestionMessage(form, "");
  assert.match(formMessage, /\*\*Q1: Which database\?\*\*/);
  assert.match(formMessage, /\*\*Q2: Migrate data\?\*\* \*\(multi\)\*/);
  assert.match(formMessage, /e\.g\. "1,2"/);

  const permissionMessage = formatPermissionMessage(
    { permission: "bash", patterns: ["git push", "git status"] },
    "Pushing the release branch.",
  );
  assert.equal(
    permissionMessage,
    "Pushing the release branch.\n" +
      "\n" +
      "**Permission requested: bash**\n" +
      "`git push`, `git status`\n" +
      "\n" +
      '_Tap the notification to reply by text: "yes" (once), "always", or "no" (optionally "no: reason")._',
  );
});

test("long agent text is truncated to leave room for the question", () => {
  const agentText = "x".repeat(2000);
  const message = formatQuestionMessage(single, agentText);
  assert.ok(message.length < 1000);
  // Truncation is byte-based: 400 bytes minus the 3-byte ellipsis.
  assert.match(message, /^x{397}…/);
  assert.match(message, /\*\*Which database\?\*\*/);
});

test("idle pushes carry the agent's last message", () => {
  assert.equal(formatIdleMessage("All tests pass."), "All tests pass.");
  assert.equal(formatIdleMessage(""), "");
  assert.equal(formatIdleMessage(null), "");
  assert.ok(formatIdleMessage("x".repeat(4000)).length <= 3800);
  // Non-ASCII text counts in bytes, not chars.
  assert.ok(Buffer.byteLength(formatIdleMessage("é".repeat(4000)), "utf8") <= 3800);
});

test("permission pushes get approve and reject buttons", () => {
  // Buttons carry the request's tag so a tap routes back to it; opencode
  // sends `always` as an array of patterns to persist, and "Always" is only
  // offered when it is non-empty.
  assert.deepEqual(permissionActions({ always: ["bash:git push:*"] }, "a1b2c3"), [
    { label: "Approve once", body: "a1b2c3 yes" },
    { label: "Always", body: "a1b2c3 always" },
    { label: "Reject", body: "a1b2c3 no" },
  ]);
  assert.deepEqual(permissionActions({ always: [] }, "a1b2c3"), [
    { label: "Approve once", body: "a1b2c3 yes" },
    { label: "Reject", body: "a1b2c3 no" },
  ]);
  assert.deepEqual(permissionActions({}, "a1b2c3"), [
    { label: "Approve once", body: "a1b2c3 yes" },
    { label: "Reject", body: "a1b2c3 no" },
  ]);
});

test("question pushes get one button per option, capped at three", () => {
  assert.deepEqual(questionActions(single, "a1b2c3"), [
    { label: "Postgres", body: "a1b2c3 1" },
    { label: "MySQL", body: "a1b2c3 2" },
  ]);
  // Forms and multi-select questions need a typed reply.
  assert.deepEqual(questionActions(form, "a1b2c3"), []);
  assert.deepEqual(questionActions([{ ...single[0], multiple: true }], "a1b2c3"), []);
  // ntfy allows at most three buttons; further options need a typed reply.
  const four = [
    {
      ...single[0],
      options: [1, 2, 3, 4].map((n) => ({ label: `Opt ${n}`, description: "" })),
    },
  ];
  assert.deepEqual(questionActions(four, "a1b2c3"), [
    { label: "Opt 1", body: "a1b2c3 1" },
    { label: "Opt 2", body: "a1b2c3 2" },
    { label: "Opt 3", body: "a1b2c3 3" },
  ]);
  const long = [{ ...single[0], options: [{ label: "a".repeat(30), description: "" }] }];
  assert.deepEqual(questionActions(long, "a1b2c3"), [
    { label: `${"a".repeat(24)}...`, body: "a1b2c3 1" },
  ]);
});

function createBrokerHarness() {
  const sent = [];
  const polls = [];
  const replies = [];
  const ntfy = {
    send: async (input) => {
      sent.push(input);
      return { ok: true };
    },
    poll: async () => {
      const messages = polls.splice(0);
      return { ok: true, messages, lastId: messages.at(-1)?.id ?? null };
    },
  };
  const broker = createReplyBroker({
    ntfy,
    replyPermission: async (input) => replies.push(["permission", input]),
    replyQuestion: async (input) => replies.push(["question", input]),
    rejectQuestion: async (input) => replies.push(["reject", input]),
    getSessionTitle: async (sessionID) => ({ s1: "Deploy fix", s2: "Review PR" })[sessionID] ?? "",
  });
  const deliver = (message) => polls.push({ id: `in_${Math.random()}`, event: "message", message });
  return { broker, deliver, polls, replies, sent };
}

test("broker treats every message on the reply topic as a reply", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const harness = createBrokerHarness();
    // A question without custom answers, so free text cannot be parsed.
    const noCustom = [{ ...single[0], custom: false }];
    harness.broker.track(
      { kind: "question", requestID: "que_1", questions: noCustom },
      { published: true },
    );

    // The reply topic only receives button taps and typed replies; the
    // plugin's own pushes publish to the base topic, so no filtering is
    // needed - even a stray text simply produces a usage confirmation.
    harness.deliver("launch the missiles");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(harness.replies, []);
    assert.equal(harness.sent.at(-1).message, singleHint());
  } finally {
    mock.timers.reset();
  }
});

function singleHint() {
  return '_Tap the notification to reply by text: a number or a label, or "skip" to dismiss._';
}

test("broker expires stale pending requests", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let time = 0;
    const sent = [];
    const replies = [];
    const polls = [];
    const broker = createReplyBroker({
      ntfy: {
        send: async (input) => {
          sent.push(input);
          return { ok: true };
        },
        poll: async () => {
          const messages = polls.splice(0);
          return { ok: true, messages, lastId: messages.at(-1)?.id ?? null };
        },
      },
      replyQuestion: async (input) => replies.push(["question", input]),
      replyPermission: async (input) => replies.push(["permission", input]),
      rejectQuestion: async (input) => replies.push(["reject", input]),
      now: () => time,
    });

    broker.track(
      { kind: "question", requestID: "que_old", questions: single },
      { published: true },
    );
    // Ten minutes pass: the request expires and a late reply gets a notice.
    time = 11 * 60 * 1000;
    polls.push({ id: "in_1", event: "message", message: "1" });

    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(replies, []);
    assert.equal(
      sent.at(-1).message,
      "No pending request to answer (already answered, or expired).",
    );
  } finally {
    mock.timers.reset();
  }
});

test("broker resolve and clearSession drop pending requests", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const harness = createBrokerHarness();
    harness.broker.track(
      { kind: "permission", requestID: "per_1", sessionID: "s1" },
      { published: true },
    );
    harness.broker.track(
      { kind: "permission", requestID: "per_2", sessionID: "s2" },
      { published: true },
    );

    harness.broker.resolve("per_1");
    harness.broker.clearSession("s2");

    harness.deliver("yes");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(harness.replies, []);
    assert.equal(
      harness.sent.at(-1).message,
      "No pending request to answer (already answered, or expired).",
    );
  } finally {
    mock.timers.reset();
  }
});

test("broker dismisses a question on skip", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const harness = createBrokerHarness();
    harness.broker.track(
      { kind: "question", requestID: "que_1", questions: single },
      { published: true },
    );

    harness.deliver("skip");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(harness.replies, [["reject", { requestID: "que_1" }]]);
    assert.equal(harness.sent.at(-1).message, "Question dismissed.");
  } finally {
    mock.timers.reset();
  }
});

test("broker replies with usage help for an unanswerable form reply", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const harness = createBrokerHarness();
    harness.broker.track(
      { kind: "question", requestID: "que_1", questions: form },
      { published: true },
    );

    harness.deliver("yes");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(harness.replies, []);
    assert.match(harness.sent.at(-1).message, /one answer per question/);
  } finally {
    mock.timers.reset();
  }
});

test("broker surfaces reply failures on the phone and desktop and keeps the request pending", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const toasts = [];
    const polls = [];
    const sent = [];
    // Fails once (e.g. the server briefly rejected the call), then works.
    let failNext = true;
    const replyQuestion = async () => {
      if (failNext) {
        failNext = false;
        throw new Error("connection lost");
      }
      return { data: {} };
    };
    const broker = createReplyBroker({
      ntfy: {
        send: async (input) => {
          sent.push(input);
          return { ok: true };
        },
        poll: async () => {
          const messages = polls.splice(0);
          return { ok: true, messages, lastId: messages.at(-1)?.id ?? null };
        },
      },
      replyQuestion,
      replyPermission: async () => {},
      rejectQuestion: async () => {},
      onToast: (message, variant) => toasts.push([message, variant]),
    });

    broker.track(
      { kind: "question", requestID: "que_1", questions: single, tag: "a1b2c3" },
      { published: true },
    );
    polls.push({ id: "in_1", event: "message", message: "1" });

    await mock.timers.tick(5000);
    await flush();
    await flush();

    // The desktop gets the error toast...
    assert.deepEqual(toasts, [["Notify: reply failed (connection lost)", "error"]]);
    // ...the phone is told the answer did not land...
    assert.match(sent.at(-1).message, /Could not deliver the answer \(connection lost\)/);
    assert.match(sent.at(-1).message, /still pending/);

    // ...and the request is still pending, so a retry after recovery works.
    polls.push({ id: "in_2", event: "message", message: "1" });
    await mock.timers.tick(5000);
    await flush();
    await flush();
    assert.match(sent.at(-1).message, /Answered: Postgres/);
  } finally {
    mock.timers.reset();
  }
});

test("broker routes a button tap to the request it was built for", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const harness = createBrokerHarness();
    harness.broker.track(
      { kind: "question", requestID: "que_old", questions: single, tag: "111111" },
      { published: true },
    );
    harness.broker.track(
      { kind: "question", requestID: "que_new", questions: single, tag: "222222" },
      { published: true },
    );

    // The older request's button answers the older request, not the newest.
    harness.deliver("111111 2");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(harness.replies, [
      ["question", { requestID: "que_old", answers: [["MySQL"]] }],
    ]);
    assert.equal(harness.sent.at(-1).message, "Answered: MySQL");

    // The newest one is still pending and answerable by text.
    harness.deliver("1");
    await mock.timers.tick(5000);
    await flush();
    await flush();
    assert.deepEqual(harness.replies.at(-1), [
      "question",
      { requestID: "que_new", answers: [["Postgres"]] },
    ]);
  } finally {
    mock.timers.reset();
  }
});

test("request confirmations carry the session title, generic notices do not", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const harness = createBrokerHarness();
    harness.broker.track(
      { kind: "permission", requestID: "per_1", permission: "bash", sessionID: "s1" },
      { published: true },
    );

    // Approving from the phone settles the request; the confirmation push
    // is titled with the session, like the push it answers, and tagged as
    // reply-channel feedback.
    harness.deliver("yes");
    await mock.timers.tick(5000);
    await flush();
    await flush();
    assert.equal(harness.sent.at(-1).message, "Approved bash (once).");
    assert.equal(harness.sent.at(-1).title, "Deploy fix");
    assert.deepEqual(harness.sent.at(-1).tags, ["speech_balloon"]);

    // A reply with no request in scope has no session to name.
    harness.deliver("launch the missiles");
    await mock.timers.tick(5000);
    await flush();
    await flush();
    assert.equal(
      harness.sent.at(-1).message,
      "No pending request to answer (already answered, or expired).",
    );
    assert.equal(harness.sent.at(-1).title, "opencode");

    // A session whose title cannot be resolved keeps the generic title.
    harness.broker.track(
      { kind: "permission", requestID: "per_2", permission: "bash", sessionID: "s_unknown" },
      { published: true },
    );
    harness.deliver("no");
    await mock.timers.tick(5000);
    await flush();
    await flush();
    assert.equal(harness.sent.at(-1).message, "Rejected bash.");
    assert.equal(harness.sent.at(-1).title, "opencode");
  } finally {
    mock.timers.reset();
  }
});

test("an untagged typed reply targets only published requests", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const harness = createBrokerHarness();
    // per_a is on the phone; per_b is registered while its publish is
    // still in flight (its notification has not been seen by anyone).
    harness.broker.track(
      { kind: "permission", requestID: "per_a", permission: "bash" },
      { published: true },
    );
    harness.broker.track(
      { kind: "permission", requestID: "per_b", permission: "bash" },
      { published: false },
    );

    // A typed "yes" must not approve the unseen per_b: it answers per_a.
    harness.deliver("yes");
    await mock.timers.tick(5000);
    await flush();
    await flush();
    assert.deepEqual(harness.replies, [["permission", { requestID: "per_a", reply: "once" }]]);

    // per_b's publish is confirmed; typed replies can now target it too.
    harness.broker.markPublished("per_b");
    harness.deliver("no");
    await mock.timers.tick(5000);
    await flush();
    await flush();
    assert.deepEqual(harness.replies.at(-1), [
      "permission",
      { requestID: "per_b", reply: "reject" },
    ]);

    // Its button would have worked even before the confirmation: a tag
    // match is legitimate as soon as the push could have reached a phone.
  } finally {
    mock.timers.reset();
  }
});

test("typed replies follow publication order, not registration order", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const harness = createBrokerHarness();
    // per_a registers first but its publish is slow; per_b registers and
    // publishes immediately; then per_a's publish finally confirms. The
    // newest notification on the phone is per_a, so a typed reply must
    // target it - not per_b, which published earlier.
    harness.broker.track(
      { kind: "permission", requestID: "per_a", permission: "bash" },
      { published: false },
    );
    harness.broker.track(
      { kind: "permission", requestID: "per_b", permission: "bash" },
      { published: true },
    );
    harness.broker.markPublished("per_a");

    harness.deliver("yes");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(harness.replies, [["permission", { requestID: "per_a", reply: "once" }]]);
  } finally {
    mock.timers.reset();
  }
});

test("a poll landing after stop does not publish confirmations", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const sent = [];
    let releasePoll = null;
    const broker = createReplyBroker({
      ntfy: {
        send: async (input) => {
          sent.push(input);
          return { ok: true };
        },
        poll: () =>
          new Promise((resolve) => {
            releasePoll = resolve;
          }),
      },
      replyQuestion: async () => {},
      replyPermission: async () => {},
      rejectQuestion: async () => {},
    });

    broker.track(
      { kind: "question", requestID: "que_1", questions: single, tag: "111111" },
      { published: true },
    );
    // A poll is in flight when the plugin is disposed...
    await mock.timers.tick(5000);
    broker.stop();

    // ...and it returns two replies afterwards: neither may be dispatched
    // or answered with a "no pending request" publication.
    releasePoll({
      ok: true,
      lastId: "in_2",
      messages: [
        { id: "in_1", event: "message", message: "1" },
        { id: "in_2", event: "message", message: "2" },
      ],
    });
    await flush();
    await flush();

    assert.deepEqual(sent, []);
  } finally {
    mock.timers.reset();
  }
});

test("broker rejects a button tap whose request is already settled", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const harness = createBrokerHarness();
    harness.broker.track(
      { kind: "question", requestID: "que_1", questions: single, tag: "111111" },
      { published: true },
    );
    harness.broker.track(
      { kind: "question", requestID: "que_2", questions: single, tag: "222222" },
      { published: true },
    );

    // The first request is answered in the TUI; its notification is still
    // on the phone. Tapping its old button must NOT answer the newer one.
    harness.broker.resolve("que_1");
    harness.deliver("111111 1");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(harness.replies, []);
    assert.equal(
      harness.sent.at(-1).message,
      "No pending request matching that button (already answered, or expired).",
    );
  } finally {
    mock.timers.reset();
  }
});

test("broker expires an unanswered request without ever receiving a reply", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let time = 0;
    let pollCount = 0;
    const broker = createReplyBroker({
      ntfy: {
        send: async () => ({ ok: true }),
        poll: async () => {
          pollCount += 1;
          return { ok: true, messages: [], lastId: null };
        },
      },
      replyQuestion: async () => {},
      replyPermission: async () => {},
      rejectQuestion: async () => {},
      now: () => time,
    });

    broker.track(
      { kind: "question", requestID: "que_1", questions: single, tag: "111111" },
      { published: true },
    );

    // The TTL passes with no reply and no resolution event: the request
    // must expire on its own and the poll loop must stop.
    time = 11 * 60 * 1000;
    await mock.timers.tick(5000);
    await flush();
    time = 12 * 60 * 1000;
    await mock.timers.tick(5000);
    await flush();
    const pollsAtStop = pollCount;
    time = 14 * 60 * 1000;
    await mock.timers.tick(5000);
    await mock.timers.tick(5000);
    await flush();

    assert.ok(pollsAtStop > 0);
    assert.equal(pollCount, pollsAtStop);
  } finally {
    mock.timers.reset();
  }
});

test("broker stops polling even when every poll fails", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let time = 0;
    let pollCount = 0;
    const broker = createReplyBroker({
      ntfy: {
        send: async () => ({ ok: true }),
        // A persistently failing inbox (e.g. revoked credentials): no poll
        // ever succeeds, so only the expiry path can stop the loop.
        poll: async () => {
          pollCount += 1;
          return { ok: false, error: "HTTP 403" };
        },
      },
      replyQuestion: async () => {},
      replyPermission: async () => {},
      rejectQuestion: async () => {},
      now: () => time,
    });

    broker.track(
      { kind: "question", requestID: "que_1", questions: single, tag: "111111" },
      { published: true },
    );

    time = 11 * 60 * 1000;
    await mock.timers.tick(5000);
    await flush();
    time = 12 * 60 * 1000;
    await mock.timers.tick(5000);
    await flush();
    const pollsAtStop = pollCount;

    time = 14 * 60 * 1000;
    await mock.timers.tick(5000);
    await mock.timers.tick(5000);
    await flush();

    assert.ok(pollsAtStop > 0);
    assert.equal(pollCount, pollsAtStop);
  } finally {
    mock.timers.reset();
  }
});

test("broker tracks using the current time as the initial poll cursor", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const harness = createBrokerHarness();
    harness.broker.track(
      { kind: "question", requestID: "que_1", questions: single },
      { published: true },
    );

    harness.deliver("1");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(harness.replies, [
      ["question", { requestID: "que_1", answers: [["Postgres"]] }],
    ]);
  } finally {
    mock.timers.reset();
  }
});

test("broker keeps polling through the grace period, then stops", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let time = 1000;
    const polls = [];
    const broker = createReplyBroker({
      ntfy: {
        send: async () => ({ ok: true }),
        poll: async () => {
          polls.push(time);
          return { ok: true, messages: [], lastId: null };
        },
      },
      replyQuestion: async () => {},
      replyPermission: async () => {},
      rejectQuestion: async () => {},
      now: () => time,
    });

    broker.track({ kind: "question", requestID: "que_1", questions: single }, { published: true });
    broker.resolve("que_1");

    // Inside the grace window the loop keeps watching for late replies.
    time += 30_000;
    await mock.timers.tick(5000);
    await flush();
    assert.equal(polls.length, 1);

    // Past the window it stops for good.
    time += 31_000;
    await mock.timers.tick(5000);
    await flush();
    await mock.timers.tick(5000);
    await flush();
    assert.equal(polls.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("broker stop halts the poll loop immediately", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const harness = createBrokerHarness();
    harness.broker.track(
      { kind: "question", requestID: "que_1", questions: single },
      { published: true },
    );
    harness.broker.stop();

    harness.deliver("1");
    await mock.timers.tick(5000);
    await flush();
    await flush();

    assert.deepEqual(harness.replies, []);
    assert.deepEqual(harness.sent, []);
  } finally {
    mock.timers.reset();
  }
});
