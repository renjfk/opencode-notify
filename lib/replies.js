// Reply channel for ntfy pushes: answer questions and permission prompts
// from the phone by publishing a short message to the ntfy topic.
//
// The broker tracks requests that were pushed to ntfy, polls the topic for
// replies while any are pending, parses them, and forwards them to the
// opencode client. Everything is best effort: parse failures and unknown
// requests are answered with a short confirmation message on the topic so
// the phone gets feedback.
//
// Routing: every answerable push gets a short random tag, and its buttons
// post "tag reply" - so a button tap always answers the request it was
// built for, even when newer requests are pending (or that one was already
// settled, which gets an explicit notice). Typed replies carry no tag and
// apply to the most recently pushed pending request.
//
// Security: anyone who can publish to the topic can answer its requests. On
// the public ntfy.sh the topic name is the only secret; on self-hosted
// servers pair this with access control (see README).

import { capBytes, DEFAULT_MAX_MESSAGE_BYTES } from "./ntfy.js";

const POLL_INTERVAL_MS = 5000;
const PENDING_TTL_MS = 10 * 60 * 1000;
// Keep polling briefly after the last request settles so a reply from the
// phone still gets a "no pending request" notice instead of silence.
const STOP_GRACE_MS = 60 * 1000;
const AGENT_TEXT_MAX_BYTES = 400;

// A button body is "<tag> <reply>", the tag being six hex chars.
const REPLY_TAG_PATTERN = /^([0-9a-f]{6})\s+(\S[\s\S]*)$/;

/** Parse a permission reply: "yes"/"always"/"no" (case-insensitive). */
export function parsePermissionReply(text) {
  const trimmed = String(text ?? "").trim();
  const [head, ...rest] = trimmed.split(/\s*[:\s]\s*/);
  const word = head.toLowerCase();
  const feedback = rest.join(" ").trim();
  if (word === "no" || word === "n" || word === "reject" || word === "deny") {
    return feedback ? { reply: "reject", message: feedback } : { reply: "reject" };
  }
  if (word === "always" || word === "a" || word === "forever") return { reply: "always" };
  if (word === "yes" || word === "y" || word === "once" || word === "ok" || word === "allow") {
    return { reply: "once" };
  }
  return null;
}

function parseSelection(token, question) {
  const options = question.options ?? [];
  const index = Number(token);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1].label;
  }
  const label = options.find((option) => option.label.toLowerCase() === token.toLowerCase())?.label;
  return label ?? null;
}

function parsePart(part, question) {
  if (part === "") return [];
  const tokens = part.split("+").map((token) => token.trim());
  const labels = tokens.map((token) => parseSelection(token, question));
  if (labels.some((label) => label === null)) return null;
  if (labels.length > 1 && question.multiple !== true) return null;
  return labels;
}

/**
 * Parse a question reply against the request's questions (a request can hold
 * several questions - a form - and must be answered in one go).
 *
 * Accepted shapes:
 *   - "skip" / "reject" / "cancel" to dismiss the request
 *   - single question: option number ("2"), option label, several numbers
 *     joined with "+" when multi-select ("1+3"), or free text when the
 *     question allows custom answers
 *   - multiple questions: one answer per question, comma-separated in order
 *     ("1,2" or "1+3,skip"); an empty part leaves that question unanswered
 *
 * Returns { reject: true }, { answers: string[][] }, or null when unparseable.
 */
export function parseQuestionReply(text, questions) {
  const trimmed = String(text ?? "").trim();
  if (/^(skip|reject|cancel|dismiss)$/i.test(trimmed)) return { reject: true };
  if (questions.length === 1) {
    const part = parsePart(trimmed, questions[0]);
    if (part) return { answers: [part] };
    if (questions[0].custom !== false) {
      // A "+"-joined list of valid options on a single-select question looks
      // like an attempted multi-select: treat it as invalid rather than as a
      // literal custom answer.
      const tokens = trimmed.split("+").map((token) => token.trim());
      const looksLikeMulti =
        tokens.length > 1 && tokens.every((token) => parseSelection(token, questions[0]) !== null);
      if (!looksLikeMulti) return { answers: [[trimmed]] };
    }
    return null;
  }
  const parts = trimmed.split(",").map((part) => part.trim());
  if (parts.length !== questions.length) return null;
  const answers = parts.map((part, i) => {
    if (/^(skip|)$/i.test(part)) return [];
    return parsePart(part, questions[i]);
  });
  if (answers.some((answer) => answer === null)) return null;
  return { answers };
}

function questionHint(questions) {
  if (questions.length === 1) {
    const multi = questions[0].multiple === true ? ' (join multi-select with "+")' : "";
    const custom = questions[0].custom !== false ? ", a label, or your own text" : " or a label";
    return `_Tap the notification to reply by text: a number${custom}${multi}, or "skip" to dismiss._`;
  }
  return '_Tap the notification to reply by text: one answer per question, comma-separated (e.g. "1,2"), "+" joins multi-select, empty or "skip" skips a question._';
}

function optionLine(question) {
  return (question.options ?? []).map((option, i) => `${i + 1}) ${option.label}`).join("  ");
}

/**
 * Build the markdown push body for a question request (a form or a single
 * question). `maxBytes` caps the body (ntfy counts bytes, not chars).
 */
export function formatQuestionMessage(questions, agentText, maxBytes = DEFAULT_MAX_MESSAGE_BYTES) {
  const lines = [];
  if (agentText) lines.push(capBytes(agentText, AGENT_TEXT_MAX_BYTES), "");
  if (questions.length === 1) {
    lines.push(`**${questions[0].question}**`, optionLine(questions[0]));
  } else {
    questions.forEach((question, i) => {
      const multi = question.multiple === true ? " *(multi)*" : "";
      lines.push(`**Q${i + 1}: ${question.question}**${multi}`, optionLine(question));
    });
  }
  lines.push("", questionHint(questions));
  return capBytes(lines.join("\n"), maxBytes);
}

/** Build the markdown push body for a permission request. */
export function formatPermissionMessage(request, agentText, maxBytes = DEFAULT_MAX_MESSAGE_BYTES) {
  const lines = [];
  if (agentText) lines.push(capBytes(agentText, AGENT_TEXT_MAX_BYTES), "");
  const patterns = (request.patterns ?? []).map((pattern) => `\`${pattern}\``).join(", ");
  lines.push(`**Permission requested: ${request.permission}**`);
  if (patterns) lines.push(patterns);
  lines.push(
    "",
    '_Tap the notification to reply by text: "yes" (once), "always", or "no" (optionally "no: reason")._',
  );
  return capBytes(lines.join("\n"), maxBytes);
}

/** Build the push body for a completed task: the agent's last message. */
export function formatIdleMessage(agentText, maxBytes = DEFAULT_MAX_MESSAGE_BYTES) {
  const text = String(agentText ?? "").trim();
  return text ? capBytes(text, maxBytes) : "";
}

const ACTION_LABEL_MAX_CHARS = 24;

function actionLabel(text) {
  const value = String(text ?? "").trim();
  if (value.length <= ACTION_LABEL_MAX_CHARS) return value;
  return `${value.slice(0, ACTION_LABEL_MAX_CHARS)}...`;
}

/**
 * Notification action buttons for a permission request: tapping one POSTs
 * "tag reply" to the topic, so the answer is routed back to this exact
 * request. "Always" is only offered when the request lists patterns to
 * persist (opencode sends `always` as an array of patterns, empty when
 * remembering the decision is not applicable).
 */
export function permissionActions(request, tag) {
  const actions = [{ label: "Approve once", body: `${tag} yes` }];
  if (Array.isArray(request?.always) && request.always.length > 0) {
    actions.push({ label: "Always", body: `${tag} always` });
  }
  actions.push({ label: "Reject", body: `${tag} no` });
  return actions;
}

/**
 * Notification action buttons for a question: one button per option, posting
 * "tag number" so the answer is routed back to this exact request. Only
 * single questions get buttons (forms and multi-select need a typed reply),
 * and ntfy allows at most three buttons, so with more options the first
 * three become buttons and the rest need a typed reply.
 */
export function questionActions(questions, tag) {
  if (questions.length !== 1) return [];
  const question = questions[0];
  if (question.multiple === true) return [];
  const options = question.options ?? [];
  if (options.length === 0) return [];
  return options
    .slice(0, 3)
    .map((option, i) => ({ label: actionLabel(option.label), body: `${tag} ${i + 1}` }));
}

function answerSummary(questions, answers) {
  return questions.map((question, i) => answers[i]?.join(", ") || "(skipped)").join(" | ");
}

/**
 * The broker manages pending pushed requests and the reply poll loop. It
 * polls only the per-instance reply topic, so anything that arrives there is
 * a reply (buttons POST to it, and tapping the push opens its web view for
 * typed messages); the plugin's own pushes go to the base topic and are
 * never seen here. `replyPermission`/`replyQuestion`/`rejectQuestion` are
 * injected so tests can capture calls; a failing call may throw - the
 * request then stays pending so it can be retried, and the failure is
 * reported on both the phone and the desktop.
 */
export function createReplyBroker({
  ntfy,
  replyPermission,
  replyQuestion,
  rejectQuestion,
  onToast = () => {},
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  // Resolves the title of a session for confirmation pushes; best effort.
  getSessionTitle = async () => "",
}) {
  const pending = [];
  let since = null;
  let timer = null;
  let polling = false;
  let emptySince = null;
  // Increasing sequence of confirmed publishes; the highest one is the
  // newest notification on the phone.
  let publishSeq = 0;
  // Terminal after stop(): a request tracked by an attention handler that
  // was already in flight when the plugin was disposed must not restart
  // the poll loop.
  let stopped = false;

  function pruneExpired() {
    const time = now();
    for (let i = pending.length - 1; i >= 0; i--) {
      if (time - pending[i].trackedAt > PENDING_TTL_MS) pending.splice(i, 1);
    }
  }

  function newestPending() {
    pruneExpired();
    // Untagged typed replies target the most recently PUBLISHED request -
    // publication order, not registration order: concurrent publishes can
    // confirm out of order, and the newest notification on the phone is
    // whichever was published last. Requests registered before their
    // publish is confirmed stay addressable by their tag (a button cannot
    // exist before the push landed) but must not receive a typed answer
    // meant for an earlier prompt.
    let best = null;
    for (const entry of pending) {
      if (!entry.published) continue;
      if (best == null || entry.publishedSeq > best.publishedSeq) best = entry;
    }
    return best;
  }

  function removeRequest(request) {
    const index = pending.indexOf(request);
    if (index !== -1) pending.splice(index, 1);
    maybeStop();
  }

  function stopTimer() {
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  function maybeStop() {
    // Prune on every poll tick as well: an unanswered request must expire
    // on its own, or the poll loop would run forever.
    pruneExpired();
    if (pending.length > 0) {
      emptySince = null;
      return;
    }
    if (emptySince == null) emptySince = now();
    if (now() - emptySince >= STOP_GRACE_MS) {
      stopTimer();
      since = null;
      emptySince = null;
    }
  }

  async function confirm(message, sessionID) {
    // Never publish after stop(): a poll that was already in flight when
    // the plugin was disposed must not send "no pending request" notes.
    if (stopped) return;
    // Request-scoped confirmations carry the session title (like the pushes
    // they answer); notices without a request context keep the generic one.
    // The speech balloon marks every confirmation as reply-channel feedback
    // so it reads as an echo, not as a new attention push.
    const title = (sessionID ? await getSessionTitle(sessionID) : "") || "opencode";
    await ntfy.send({ title, message, tags: ["speech_balloon"] });
  }

  /**
   * Deliver a reply to the opencode client. On failure the request stays
   * pending (so it can be retried), the phone is told, and the error is
   * rethrown for the poll loop's desktop toast.
   */
  async function deliver(call, request, failure) {
    try {
      await call();
    } catch (err) {
      await confirm(
        `${failure} (${err.message}). The request is still pending; try again or answer in the TUI.`,
        request.sessionID,
      );
      throw err;
    }
    removeRequest(request);
  }

  async function dispatch(message) {
    pruneExpired();
    const text = String(message.message ?? "").trim();
    const match = REPLY_TAG_PATTERN.exec(text);
    let request;
    let body = text;
    if (match) {
      // A button tap: route to the request the button was built for, even
      // when newer requests are pending.
      request = pending.findLast((entry) => entry.tag === match[1]) ?? null;
      if (!request) {
        await confirm("No pending request matching that button (already answered, or expired).");
        return;
      }
      body = match[2].trim();
    } else {
      // A typed reply carries no tag and applies to the newest request.
      request = newestPending();
      if (!request) {
        await confirm("No pending request to answer (already answered, or expired).");
        return;
      }
    }

    if (request.kind === "permission") {
      const parsed = parsePermissionReply(body);
      if (!parsed) {
        await confirm(
          'Could not read that reply. Reply "yes", "always", or "no".',
          request.sessionID,
        );
        return;
      }
      await deliver(
        () => replyPermission({ requestID: request.requestID, ...parsed }),
        request,
        "Could not deliver the answer",
      );
      await confirm(
        parsed.reply === "reject"
          ? `Rejected ${request.permission}.`
          : `Approved ${request.permission} (${parsed.reply}).`,
        request.sessionID,
      );
      return;
    }

    const parsed = parseQuestionReply(body, request.questions);
    if (parsed?.reject) {
      await deliver(
        () => rejectQuestion({ requestID: request.requestID }),
        request,
        "Could not dismiss the question",
      );
      await confirm("Question dismissed.", request.sessionID);
      return;
    }
    if (!parsed) {
      await confirm(questionHint(request.questions), request.sessionID);
      return;
    }
    await deliver(
      () => replyQuestion({ requestID: request.requestID, answers: parsed.answers }),
      request,
      "Could not deliver the answer",
    );
    await confirm(
      `Answered: ${answerSummary(request.questions, parsed.answers)}`,
      request.sessionID,
    );
  }

  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      const result = await ntfy.poll({ since });
      // The poll may have completed after stop() (the plugin was disposed
      // mid-poll): nothing must be dispatched or confirmed anymore.
      if (stopped) return;
      if (result.ok) {
        if (result.lastId) since = result.lastId;
        for (const message of result.messages) {
          try {
            await dispatch(message);
          } catch (err) {
            onToast(`Notify: reply failed (${err.message})`, "error");
          }
        }
      }
      // Expiry and the stop decision run whether or not the poll succeeded:
      // a persistently failing inbox must not keep the loop alive forever.
      maybeStop();
    } finally {
      polling = false;
    }
  }

  function startPolling() {
    if (timer) return;
    timer = setIntervalFn(() => {
      pollOnce().catch(() => {});
    }, POLL_INTERVAL_MS);
    // Never keep the process alive just for the reply poll.
    if (typeof timer.unref === "function") timer.unref();
  }

  return {
    /**
     * Register a request. Callers register BEFORE publishing, passing
     * `{ published: false }`: the push can reach the phone (and be answered
     * by button) before the publish response returns, and the poll cursor
     * starts just before "now" so replies posted in that window are still
     * picked up. Until `markPublished` confirms the publish, the request is
     * addressable only by its tag, not by untagged typed replies. Ignored
     * after stop().
     */
    track(request, { published } = {}) {
      if (stopped) return;
      if (since == null) since = Math.floor(now() / 1000) - 1;
      pending.push({
        ...request,
        trackedAt: now(),
        published,
        publishedSeq: published ? ++publishSeq : 0,
      });
      startPolling();
    },
    /** Confirm a pre-registered request's publish succeeded: typed replies may now target it. */
    markPublished(requestID) {
      const entry = pending.find((request) => request.requestID === requestID);
      if (entry && !entry.published) {
        entry.published = true;
        entry.publishedSeq = ++publishSeq;
      }
    },
    /** Drop a request that was answered or dismissed elsewhere (e.g. in the TUI). */
    resolve(requestID) {
      const index = pending.findIndex((request) => request.requestID === requestID);
      if (index !== -1) pending.splice(index, 1);
      maybeStop();
    },
    /** Drop all requests of a session (it went busy, so they are settled). */
    clearSession(sessionID) {
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].sessionID === sessionID) pending.splice(i, 1);
      }
      maybeStop();
    },
    stop() {
      stopped = true;
      pending.length = 0;
      stopTimer();
      since = null;
      emptySince = null;
    },
  };
}
