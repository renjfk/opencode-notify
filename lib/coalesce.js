// Coalescer for non-answerable ntfy pushes.
//
// Attention events can fire in bursts (a session cycling busy/idle, several
// sessions finishing together), which would spam the phone with repeated or
// near-identical notifications. Pushes routed through the coalescer are
// instead collapsed and stacked:
//
//   - a push identical (title + message) to one sent recently is dropped
//   - pushes arriving within the batch window are stacked into a single
//     notification, their messages joined with a separator; each message
//     gets an equal share of the byte budget so one long message cannot
//     push the others out, and the total is capped to the configured limit
//
// Answerable pushes (questions and permissions) bypass the coalescer
// entirely: they need their own notification with buttons, and the reply
// channel tracks their ids.

import { capBytes } from "./ntfy.js";

const BATCH_MS = 5000;
const DEDUP_MS = 60_000;
const SEPARATOR = "\n\n---\n\n";
const SEPARATOR_BYTES = Buffer.byteLength(SEPARATOR, "utf8");

// Ranks mirror ntfy's numeric priorities (1-5), so names and numbers can be
// compared directly.
const PRIORITY_RANK = { min: 1, low: 2, default: 3, high: 4, urgent: 5, max: 5 };

function priorityRank(priority) {
  if (typeof priority === "number" && Number.isFinite(priority)) {
    return Math.min(5, Math.max(1, Math.round(priority)));
  }
  return PRIORITY_RANK[String(priority)] ?? PRIORITY_RANK.default;
}

function keyOf(item) {
  return `${item.title ?? ""}\u0000${item.message ?? ""}`;
}

export function createPushCoalescer({
  send,
  onSent = () => {},
  batchMs = BATCH_MS,
  dedupeMs = DEDUP_MS,
  maxBytes = 3800,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const queued = [];
  const sent = [];
  let timer = null;
  let flushing = false;

  function pruneRecent() {
    const time = now();
    for (let i = sent.length - 1; i >= 0; i--) {
      if (time - sent[i].at > dedupeMs) sent.splice(i, 1);
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeoutFn(() => {
      timer = null;
      flush();
    }, batchMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function flush() {
    if (flushing || queued.length === 0) return;
    flushing = true;
    const items = queued.splice(0);
    try {
      const last = items.at(-1);
      const messages = [...new Set(items.map((item) => item.message))];
      // Split the byte budget evenly across the stacked messages (minus the
      // separators), then guard the total. Without this, one long message
      // would consume the whole cap and the rest would vanish entirely.
      const share = Math.max(
        1,
        Math.floor((maxBytes - (messages.length - 1) * SEPARATOR_BYTES) / messages.length),
      );
      const message = capBytes(
        messages.map((entry) => capBytes(entry, share)).join(SEPARATOR),
        maxBytes,
      );
      // The stacked notification carries the highest priority among the
      // queued items; a configured low or numeric priority survives instead
      // of being promoted to the default.
      const priority = items.reduce(
        (best, item) => (priorityRank(item.priority) > priorityRank(best) ? item.priority : best),
        items[0].priority,
      );
      const result = await send({
        title: last.title,
        message,
        priority,
        tags: last.tags,
        markdown: items.some((item) => item.markdown),
      });
      // Only remember successful sends: a failed one should be retried on
      // the next attention event rather than suppressed.
      if (result.ok) {
        const time = now();
        for (const item of items) sent.push({ key: keyOf(item), at: time });
        pruneRecent();
      }
      onSent(result);
    } finally {
      flushing = false;
    }
  }

  return {
    /**
     * Queue a push. An identical push sent or queued recently is collapsed
     * (dropped) instead of queued again.
     */
    push(item) {
      pruneRecent();
      const key = keyOf(item);
      if (sent.some((entry) => entry.key === key)) return;
      if (queued.some((entry) => keyOf(entry) === key)) return;
      queued.push(item);
      if (batchMs <= 0) flush();
      else schedule();
    },
    /** Send everything queued now (also used when batchMs is 0). */
    flush,
    /** Drop queued pushes and cancel the pending flush. */
    stop() {
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
      queued.length = 0;
    },
  };
}
