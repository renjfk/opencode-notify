// Push notifications via ntfy (https://ntfy.sh or any self-hosted instance).
//
// Optional capability: only active when the plugin is configured with an
// `ntfy` block containing a topic. Works with the public server (no auth)
// or an authenticated server via `tokenEnv` naming an environment variable
// that holds the access token (like the voice plugin's `apiKeyEnv`).

import { randomUUID } from "node:crypto";

const DEFAULT_SERVER = "https://ntfy.sh";
const PROBE_TIMEOUT_MS = 3000;
const SEND_TIMEOUT_MS = 5000;
const POLL_TIMEOUT_MS = 10000;
const TOPIC_PATTERN = /^[-_A-Za-z0-9]{1,64}$/;
// ntfy caps a message body at 4096 bytes (ntfy.sh and the self-hosted
// default; self-hosted servers can raise it via `message_size_limit`). Stay
// below it by default so multibyte text and the separator never overflow.
// Shared by the coalescer and the message formatters so every cap in the
// plugin agrees on the default and the configured override.
export const DEFAULT_MAX_MESSAGE_BYTES = 3800;

/** Resolve a configured `maxMessageBytes` value to a positive integer. */
export function normalizeMaxMessageBytes(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_MESSAGE_BYTES;
}

/**
 * Cap a string to `max` UTF-8 bytes, cutting at a word boundary if possible.
 * ntfy counts message size in bytes, so a char-based cap would overflow with
 * non-ASCII text.
 */
export function capBytes(text, max) {
  const value = String(text ?? "");
  if (Buffer.byteLength(value, "utf8") <= max) return value;
  const limit = Math.max(1, max - 3);
  const cut = Buffer.from(value, "utf8")
    .subarray(0, limit)
    .toString("utf8")
    .replace(/\ufffd+$/, "");
  const space = cut.lastIndexOf(" ");
  return `${space > limit * 0.6 ? cut.slice(0, space) : cut}…`;
}

function buildAuthorization(config = {}) {
  if (!config.tokenEnv) return null;
  const token = process.env[config.tokenEnv];
  return token ? `Bearer ${token}` : null;
}

/**
 * HTTP header values must be ASCII; Bun's fetch (and some other clients)
 * reject values containing e.g. arrows, emoji, or non-Latin scripts, which
 * session titles regularly do. ntfy understands RFC 2047 encoded words
 * (=?UTF-8?B?...?=), so use them for anything beyond ASCII.
 */
function encodeHeaderValue(value) {
  const text = String(value);
  // \P{ASCII} matches any non-ASCII character (the unicode property escape
  // avoids a control-character range in the pattern).
  if (!/\P{ASCII}/u.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function quoteActionValue(value) {
  const text = String(value).replace(/"/g, "");
  return /[,;]/.test(text) ? `"${text}"` : text;
}

/**
 * Fetch with a timeout that covers the whole request: headers AND body. A
 * plain `fetch()` only resolves once headers arrive; clearing the timer
 * then would let a server that stalls mid-body hang the caller forever
 * (and, for the reply poll, block all later polls). The fetch and the body
 * read are raced against the abort promise from the outset, so a stall at
 * any point is cut off - even if the body stream ignores the signal.
 */
export async function fetchWithTimeout(
  url,
  options,
  timeoutMs,
  fetchImpl,
  read = async (response) => response,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Never keep the process alive just for an in-flight request.
  if (typeof timer.unref === "function") timer.unref();
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("request timed out")));
  });
  try {
    const work = (async () => {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      return await read(response);
    })();
    return await Promise.race([work, aborted]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read and discard a response body, then return the response. The outcome
 * is already settled by the status code, so a body that fails to drain must
 * not turn it into an error - but draining must happen inside the timeout
 * window, or a server that stalls mid-body is left holding the connection
 * open past the deadline instead of being aborted.
 */
async function drainBody(response) {
  try {
    await response.text();
  } catch {}
  return response;
}

export async function createNtfy({ config = {}, replyTopic, fetchImpl = fetch } = {}) {
  if (!config.topic) {
    return {
      available: false,
      configured: false,
      reason: "no topic configured",
      send: async () => ({ ok: true, skipped: true }),
      poll: async () => ({ ok: true, skipped: true, messages: [] }),
    };
  }

  const unavailable = (reason) => ({
    available: false,
    configured: true,
    reason,
    send: async () => ({ ok: true, skipped: true }),
    poll: async () => ({ ok: true, skipped: true, messages: [] }),
  });

  const server = String(config.server || DEFAULT_SERVER).replace(/\/+$/, "");
  const topic = String(config.topic);
  // A configured tokenEnv whose variable is missing is reported explicitly
  // instead of surfacing as a confusing 401 from the server probe.
  if (config.tokenEnv && !process.env[config.tokenEnv]) {
    return unavailable(`environment variable ${config.tokenEnv} (ntfy token) is not set`);
  }
  const authorization = buildAuthorization(config);
  // Buttons embed credentials so a tap can publish to the reply topic.
  // `actionsTokenEnv` optionally names a separate, restricted token for
  // them (e.g. write-only on the reply topics) so the publishing token is
  // not handed to every subscriber that renders the buttons.
  if (config.actionsTokenEnv && !process.env[config.actionsTokenEnv]) {
    return unavailable(
      `environment variable ${config.actionsTokenEnv} (ntfy actions token) is not set`,
    );
  }
  const actionsAuthorization = config.actionsTokenEnv
    ? `Bearer ${process.env[config.actionsTokenEnv]}`
    : authorization;
  const maxMessageBytes = normalizeMaxMessageBytes(config.maxMessageBytes);

  if (!/^https?:\/\/.+/.test(server)) {
    return unavailable(`invalid ntfy server URL: ${config.server}`);
  }
  if (!TOPIC_PATTERN.test(topic)) {
    return unavailable(`invalid ntfy topic name: ${topic}`);
  }

  // Replies (button taps and typed messages) are routed to a per-instance
  // reply topic - the configured topic plus a random suffix - so multiple
  // opencode processes sharing the base topic never consume each other's
  // pushes or answers. Notifications still publish to the base topic, the
  // only one a client needs to subscribe to. The reply topic must stay a
  // valid topic name (ntfy caps them at 64 chars): an unusable one is
  // replaced by a truncated base plus a fresh suffix - never the base topic
  // itself, which would feed the plugin's own pushes into the reply poll.
  const replyTarget =
    replyTopic != null && TOPIC_PATTERN.test(String(replyTopic))
      ? String(replyTopic)
      : `${topic.slice(0, 64 - 9)}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  // Probe the server at startup so a typo or an unreachable host is reported
  // immediately instead of failing silently on every attention event.
  try {
    const probeHeaders = {};
    if (authorization) probeHeaders.Authorization = authorization;
    const response = await fetchWithTimeout(
      `${server}/v1/health`,
      { headers: probeHeaders },
      PROBE_TIMEOUT_MS,
      fetchImpl,
      // Drain the body inside the timeout window (see send): a response
      // that stalls mid-body must be cut off, not left open past the
      // deadline.
      drainBody,
    );
    if (response.status === 401 || response.status === 403) {
      return unavailable(`ntfy server rejected credentials (HTTP ${response.status})`);
    }
  } catch (err) {
    return unavailable(`ntfy server unreachable (${err.message})`);
  }

  /**
   * Serialize action buttons for the Actions header: up to three actions
   * separated by ";", their parameters by ",". Each button POSTs its body to
   * the reply topic when tapped (the reply broker picks it up like a typed
   * reply), and clears the notification on success. Values containing the
   * separators are quoted, per the ntfy docs.
   */
  function buildActionsHeader(actions) {
    return actions
      .map((action) => {
        const parts = [
          "http",
          quoteActionValue(action.label),
          `${server}/${replyTarget}`,
          `body=${quoteActionValue(action.body)}`,
          "clear=true",
        ];
        if (actionsAuthorization) parts.push(`headers.Authorization=${actionsAuthorization}`);
        return parts.join(", ");
      })
      .join("; ");
  }

  async function send({ title, message, priority, tags, markdown, actions, click } = {}) {
    const headers = {};
    if (title) headers.Title = encodeHeaderValue(title);
    if (priority) headers.Priority = String(priority);
    if (tags?.length) headers.Tags = tags.join(",");
    if (markdown) headers.Markdown = "yes";
    if (actions?.length) headers.Actions = encodeHeaderValue(buildActionsHeader(actions));
    // Tapping the notification opens this URL (the reply topic's web view,
    // which has a publish box for typed replies).
    if (click) headers.Click = encodeHeaderValue(click);
    if (authorization) headers.Authorization = authorization;
    try {
      // The body is read inside the timeout window, and capped to the
      // configured limit: ntfy (and ntfy.sh in particular) rejects oversized
      // messages instead of truncating them.
      return await fetchWithTimeout(
        `${server}/${topic}`,
        { method: "POST", headers, body: capBytes(message ?? "", maxMessageBytes) },
        SEND_TIMEOUT_MS,
        fetchImpl,
        async (response) => {
          if (!response.ok) {
            return { ok: false, error: `HTTP ${response.status}` };
          }
          // The publish is confirmed by the status; drain the body so the
          // timeout still covers the whole transfer.
          await drainBody(response);
          return { ok: true };
        },
      );
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Fetch messages published to the reply topic after `since` (a message id
   * or a unix timestamp) and return them in publish order. Never throws; on
   * failure returns ok: false and the caller keeps its previous cursor.
   */
  async function poll({ since } = {}) {
    const headers = {};
    if (authorization) headers.Authorization = authorization;
    const query = since != null ? `?poll=1&since=${encodeURIComponent(String(since))}` : "?poll=1";
    try {
      return await fetchWithTimeout(
        `${server}/${replyTarget}/json${query}`,
        { headers },
        POLL_TIMEOUT_MS,
        fetchImpl,
        async (response) => {
          if (!response.ok) {
            return { ok: false, error: `HTTP ${response.status}` };
          }
          const messages = [];
          let lastId = null;
          for (const line of (await response.text()).split("\n")) {
            if (!line.trim()) continue;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (event.id) lastId = event.id;
            if (event.event === "message") messages.push(event);
          }
          return { ok: true, messages, lastId };
        },
      );
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return {
    available: true,
    configured: true,
    reason: null,
    /** Web view of the reply topic (used as the notification Click URL). */
    replyUrl: `${server}/${replyTarget}`,
    send,
    poll,
  };
}
