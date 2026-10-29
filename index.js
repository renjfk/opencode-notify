// opencode-notify: attention notifications for OpenCode.
//
// On attention events (a task finishing or failing, permission asked,
// question asked), the plugin decides what to do based on which capabilities
// are available and whether the user is likely to miss the event:
//
// "Tab active" means the session is actually being viewed: the Zellij tab is
// active and, when OpenCode session tabs are enabled and the session is an
// open tab, its OpenCode tab is the active one.
//
//   Tab active | Ghostty visible | Screen locked | Action
//   -----------|-----------------|---------------|----------------------------------------
//   Yes        | Yes             | No            | Do nothing (user can see it)
//   Yes        | No              | No            | Desktop notification
//   No         | Yes             | No            | Blink tab + sound
//   No         | No              | No            | Blink tab + desktop notification
//   Any        | Any             | Yes           | ntfy push + blink tab when inactive (if
//   Any        | Any             | Yes           |  configured, desktop notification optionally kept)
//
// When the screen is locked, the terminal counts as not visible (macOS still
// reports windows while the screen saver covers them), so without ntfy the
// desktop notification is still queued and shown at unlock.
//
// Pushes can also be controlled at runtime via commands in the command
// palette: "automatic" (push when the screen locks, the default), "always on"
// (the push replaces the desktop notification: it fires whenever the terminal
// is not visible or the screen is locked, and stays quiet while the terminal
// is visible - useful when lock detection is unavailable or when stepping
// away without locking), and "off" (silence). The choice is persisted via
// api.kv and survives restarts.
//
// Every capability (Zellij, Ghostty, terminal-notifier, afplay, lock
// detection, ntfy) is optional and probed at startup. Missing capabilities
// are skipped gracefully and the plugin continues with whatever is available.
//
// With the V2 shared server every TUI instance receives every event, so each
// instance signals only events whose location (project directory) matches its
// own TUI: attention owed in another Zellij tab is that tab's instance's job.
// Events without a location, or when the instance's own directory is unknown,
// fall through unchanged. Two instances in the same directory both signal -
// location cannot disambiguate them, and dropping the event would risk
// nobody signalling at all.

import { randomUUID } from "node:crypto";
import { createPushCoalescer } from "./lib/coalesce.js";
import { createZellij } from "./lib/zellij.js";
import { createGhostty } from "./lib/ghostty.js";
import { createLock } from "./lib/lock.js";
import { createNotifier } from "./lib/notifier.js";
import { createNtfy, normalizeMaxMessageBytes } from "./lib/ntfy.js";
import { createSound } from "./lib/sound.js";
import { getLastAgentText, getSessionTitle } from "./lib/session.js";
import {
  createReplyBroker,
  formatIdleMessage,
  formatPermissionMessage,
  formatQuestionMessage,
  permissionActions,
  questionActions,
} from "./lib/replies.js";

const DEBOUNCE_MS = 2000;
const POLL_INTERVAL_MS = 1000;

// The V2 TUI runtime injects `@opencode/plugin/tui`. Fall back to the identity
// contract when the module is unavailable (plain `node --test` without the
// runtime), so the definition stays loadable either way.
let Plugin = { define: (definition) => definition };
try {
  ({ Plugin } = await import("@opencode/plugin/tui"));
} catch {}

// V2 execution events carry the completion and failure signals V1 delivered
// as `session.idle` - which in V2 is deprecated and has no producer, so
// relying on it silently dropped every finished task. Each entry maps the live
// V2 event onto the logical attention kind the decision matrix is built
// around; `session.execution.succeeded`/`interrupted` take the old
// `session.idle` path unchanged.
const ATTENTION_EVENTS = new Map([
  ["session.execution.succeeded", "session.idle"],
  ["session.execution.interrupted", "session.idle"],
  ["session.execution.failed", "session.execution.failed"],
  ["permission.asked", "permission.asked"],
  ["question.asked", "question.asked"],
]);

const ATTENTION_META = {
  "permission.asked": { message: "Permission requested", priority: "high", tags: ["warning"] },
  "question.asked": { message: "Question needs your answer", priority: "high", tags: ["question"] },
  "session.idle": { message: "Task completed", priority: "default", tags: ["white_check_mark"] },
  "session.execution.failed": { message: "Session failed", priority: "high", tags: ["x"] },
};

const PUSH_MODES = ["auto", "on", "off"];
const KV_PUSH_MODE = "notify.pushMode";

const PUSH_MODE_META = {
  auto: {
    label: "automatic (when the screen locks)",
    title: "Push notifications: automatic",
    menuTitle: "Automatic",
  },
  on: { label: "always on", title: "Push notifications: always on", menuTitle: "Always on" },
  off: { label: "off", title: "Push notifications: off", menuTitle: "Off" },
};

/**
 * Wait for the kv store to finish loading from disk, bounded by a timeout.
 * Returns early once ready; never rejects.
 */
async function waitForKv(kv, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!kv.ready) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function createTui(dependencies = {}) {
  const {
    createZellij: makeZellij = createZellij,
    createGhostty: makeGhostty = createGhostty,
    createLock: makeLock = createLock,
    createNotifier: makeNotifier = createNotifier,
    createNtfy: makeNtfy = createNtfy,
    createSound: makeSound = createSound,
    createPushCoalescer: makeCoalescer = createPushCoalescer,
    getSessionTitle: getTitle = getSessionTitle,
    getLastAgentText: getAgentText = getLastAgentText,
    generateReplyTag = () => randomUUID().replace(/-/g, "").slice(0, 6),
    // A subagent session reports back to its parent; a finished subagent is
    // not a task the user is waiting on, so it never signals on its own.
    isSubagent = () => false,
    // OpenCode session-tab state for the event's session. Returns true when
    // the session's tab is the active tab, false when it is an open but
    // background tab, and undefined when tabs are disabled or the session is
    // not an open tab (so the caller falls back to the Zellij check alone).
    isSessionTabActive = () => undefined,
    // True while a direct child session (a background subagent) of the given
    // session is still running. A child's completion re-wakes the parent, so
    // the parent's own completion is not the end of the turn yet.
    hasRunningChild = () => false,
    // Directory of the location this TUI instance runs in, when known: a
    // string or a function returning one (read per event, because the TUI's
    // location changes when a session from another directory is opened or
    // moved). The V2 shared server broadcasts every event to every connected
    // TUI, so events carrying a different directory belong to another
    // instance (another Zellij tab, another project) and are ignored.
    // Undefined, or an event without a location, falls through: single-instance
    // setups and tests keep the previous behavior.
    locationDirectory = undefined,
  } = dependencies;

  return async (api, options) => {
    const client = api.client;
    const ntfyConfig = options?.ntfy;

    function toast(message, variant = "info") {
      api.ui.toast({ message, variant, duration: 4000 });
    }

    const zellij = await makeZellij();
    const ghostty = await makeGhostty();
    const lock = await makeLock();
    const notifier = await makeNotifier();
    // Replies are routed to a per-instance reply topic (base topic + random
    // suffix): every opencode process gets its own inbox, so multiple
    // instances sharing the base topic never consume each other's pushes or
    // answers. Only the base topic needs to be subscribed to.
    const replyTopic = ntfyConfig?.topic
      ? `${ntfyConfig.topic}-${randomUUID().replace(/-/g, "").slice(0, 8)}`
      : undefined;
    const ntfy = await makeNtfy({ config: ntfyConfig || {}, replyTopic });
    const sound = await makeSound();

    // Reply channel: questions and permission prompts pushed to ntfy carry
    // their content and can be answered from the phone via the per-instance
    // reply topic (buttons post there directly; tapping the push opens its
    // web view for typed replies). Anyone who can publish to the topic can
    // answer, so it can be disabled with `ntfy.replies: false`. With
    // `ntfy.detail: "minimal"` pushes stay generic (like desktop
    // notifications) and the reply channel is off entirely.
    const repliesEnabled =
      ntfy.available && ntfyConfig?.replies !== false && ntfyConfig?.detail !== "minimal";
    let broker = null;
    if (repliesEnabled) {
      broker = createReplyBroker({
        ntfy,
        // Confirmation pushes carry the session title, like the pushes
        // they answer.
        getSessionTitle: (sessionID) => getTitle(client, sessionID),
        // throwOnError: the SDK otherwise returns { error } instead of
        // throwing, and a failed reply would be reported as success.
        replyPermission: (input) => client.permission.reply(input, { throwOnError: true }),
        replyQuestion: (input) => client.question.reply(input, { throwOnError: true }),
        rejectQuestion: (input) => client.question.reject(input, { throwOnError: true }),
        onToast: toast,
      });
    }

    // Non-answerable pushes go through a coalescer: identical consecutive
    // pushes collapse and bursts stack into one notification, capped to the
    // configured byte limit (ntfy.sh allows 4096; self-hosted servers can
    // raise it via message_size_limit, so the cap is configurable).
    const maxBytes = normalizeMaxMessageBytes(ntfyConfig?.maxMessageBytes);
    const pushes = makeCoalescer({
      send: (item) => ntfy.send(item),
      maxBytes,
      onSent: (result) => {
        if (!result.ok && !result.skipped) {
          toast(`Notify: ntfy push failed (${result.error})`, "error");
        }
      },
    });

    // Runtime push mode, persisted in kv so it survives restarts.
    // Read only when ntfy is configured; defaults to "auto".
    let pushMode = "auto";
    if (ntfy.configured) {
      await waitForKv(api.kv);
      const stored = api.kv.get(KV_PUSH_MODE);
      if (PUSH_MODES.includes(stored)) pushMode = stored;
    }

    function setPushMode(mode) {
      pushMode = mode;
      api.kv.set(KV_PUSH_MODE, mode);
      // Queued (batched) pushes were admitted under the previous mode;
      // turning pushes off must also cancel what is still waiting.
      if (mode === "off") pushes.stop();
      const suffix =
        mode === "auto" && !lock.available
          ? " (lock detection unavailable, pushes will not trigger)"
          : "";
      toast(`Notify: push notifications ${PUSH_MODE_META[mode].label}${suffix}`, "info");
    }

    // Startup warnings - never throw, just inform the user what is disabled.
    if (!zellij.available) {
      toast(`Notify: tab blinking disabled (${zellij.reason})`, "warning");
    }
    if (!notifier.available) {
      toast(`Notify: desktop notifications disabled (${notifier.reason})`, "warning");
    }
    if (ntfy.configured && !ntfy.available) {
      toast(`Notify: ntfy push disabled (${ntfy.reason})`, "warning");
    } else if (ntfy.available && !lock.available && pushMode === "auto") {
      toast(`Notify: ntfy push disabled (lock detection unavailable: ${lock.reason})`, "warning");
    }

    // Runtime mode switch via the command palette (only when ntfy is used).
    // One palette entry opens the sliding select menu - the same component
    // opencode's system settings use - instead of one palette entry per mode.
    if (ntfy.configured && api.keymap?.registerLayer) {
      api.keymap.registerLayer({
        commands: [
          {
            namespace: "palette",
            name: "notify.push",
            title: "Push notifications",
            desc: "opencode-notify: choose when attention pushes go to ntfy",
            category: "Notify",
            run: async () => {
              const mode = await api.ui.select({
                title: "Push notifications",
                current: pushMode,
                options: PUSH_MODES.map((value) => ({
                  value,
                  title: PUSH_MODE_META[value].menuTitle,
                  description: PUSH_MODE_META[value].label,
                })),
              });
              // An explicit choice always re-applies (persisting it and
              // surfacing capability warnings); dismissing changes nothing.
              if (mode && PUSH_MODES.includes(mode)) setPushMode(mode);
            },
          },
        ],
      });
    }

    // If nothing useful is available, log once and return without subscribing.
    if (!zellij.available && !notifier.available && !sound.available && !ntfy.available) {
      toast("Notify: no capabilities available on this system", "warning");
      return;
    }

    let lastNotifyTime = 0;
    let ghosttyPollTimer = null;
    // Bumped per session whenever it goes busy. Attention handling captures
    // the epoch of its own session and aborts if that session went busy
    // again while awaiting slow work (an ntfy push can take seconds), so it
    // never re-signals a session the user has already returned to - but an
    // unrelated session going busy must not cancel another session's
    // notification. The busy handler does the cleanup instead.
    const busyEpochs = new Map();
    const busySessions = new Set();

    function epochOf(sessionID) {
      return busyEpochs.get(sessionID) ?? 0;
    }

    // True when the event belongs to a different location: another TUI
    // instance sharing the server owns it and does the signalling. The own
    // directory is resolved per event so a changed TUI location (open dialog,
    // /cd, a session moved to a worktree) takes effect immediately.
    function isForeignLocation(event) {
      const own = typeof locationDirectory === "function" ? locationDirectory() : locationDirectory;
      const eventDirectory = event.location?.directory;
      return own !== undefined && eventDirectory !== undefined && eventDirectory !== own;
    }

    function stopGhosttyPoll() {
      if (ghosttyPollTimer) {
        clearInterval(ghosttyPollTimer);
        ghosttyPollTimer = null;
      }
    }

    function startGhosttyPoll() {
      if (ghosttyPollTimer || !ghostty.available || !notifier.available) return;
      ghosttyPollTimer = setInterval(async () => {
        try {
          // While locked, windows still exist behind the lock screen, so
          // visibility alone would wrongly count as the user returning. Wait
          // for an actual unlock before consulting visibility at all.
          if (lock.available && (await lock.isLocked())) return;
          const visible = await ghostty.isVisible();
          if (visible) {
            stopGhosttyPoll();
            await notifier.clear();
          }
        } catch {}
      }, POLL_INTERVAL_MS);
    }

    async function sendDesktopNotification(event) {
      if (!notifier.available) return;
      const sessionID = event.properties?.sessionID;
      const tabName = zellij.available ? await zellij.getTabName() : "OpenCode";
      const sessionTitle = (await getTitle(client, sessionID)) || "";
      const meta = ATTENTION_META[event.type];

      const result = await notifier.send({
        title: tabName || "OpenCode",
        subtitle: sessionTitle,
        message: meta.message,
        sound: "Blow",
      });
      if (result.code !== 0 && !result.skipped) {
        toast(`Notify: desktop notification failed (exit ${result.code})`, "error");
      }
    }

    async function sendNtfyNotification(event, stale) {
      if (!ntfy.available) return null;
      const sessionID = event.properties?.sessionID;
      const tabName = zellij.available ? await zellij.getTabName() : "OpenCode";
      const sessionTitle = (await getTitle(client, sessionID)) || "";
      const meta = ATTENTION_META[event.type];
      const detailed = ntfyConfig?.detail !== "minimal";

      // Questions and permissions carry their actual content (plus the last
      // agent text for context) when the reply channel is on, so they can be
      // answered from the phone; they also get action buttons that post the
      // reply directly. Completed tasks carry the agent's last message.
      // Minimal detail keeps everything generic.
      const answerable =
        broker && (event.type === "permission.asked" || event.type === "question.asked");
      let message = meta.message;
      let markdown = false;
      let actions = null;
      // Buttons post "<tag> <reply>" so a tap is routed back to this exact
      // request, not to whichever request happens to be newest.
      const replyTag = answerable ? generateReplyTag() : null;
      if (answerable) {
        const agentText = (await getAgentText(client, sessionID)) || "";
        message =
          event.type === "permission.asked"
            ? formatPermissionMessage(event.properties, agentText, maxBytes)
            : formatQuestionMessage(event.properties.questions ?? [], agentText, maxBytes);
        markdown = true;
        actions =
          event.type === "permission.asked"
            ? permissionActions(event.properties, replyTag)
            : questionActions(event.properties.questions ?? [], replyTag);
      } else if (event.type === "session.idle" && detailed) {
        const agentText = (await getAgentText(client, sessionID)) || "";
        const content = formatIdleMessage(agentText, maxBytes);
        if (content) {
          message = content;
          markdown = true;
        }
      }

      const title = sessionTitle || tabName || "OpenCode";
      const priority = ntfyConfig?.priority || meta.priority;

      // The lookups above (tab name, title, agent text) can be slow;
      // pushes may have been turned off, the session gone busy again, or
      // the plugin disposed while they ran. Revalidate before anything is
      // enqueued or published - stopping the queue must also stop pushes
      // that were still loading their content.
      if (stale?.()) return null;

      if (!answerable) {
        // Through the coalescer: identical consecutive pushes collapse, and
        // bursts stack into one capped notification.
        pushes.push({ title, message, priority, tags: meta.tags, markdown });
        return null;
      }

      // Register the request before publishing: the push can reach the
      // phone (and be answered by button) before the publish response
      // returns, and the reply cursor must cover that window. Until the
      // publish is confirmed it stays invisible to untagged typed replies.
      const request = {
        kind: event.type === "permission.asked" ? "permission" : "question",
        requestID: event.properties.id,
        sessionID,
        permission: event.properties.permission,
        questions: event.properties.questions ?? [],
        tag: replyTag,
      };
      broker.track(request, { published: false });

      const result = await ntfy.send({
        title,
        message,
        priority,
        tags: meta.tags,
        markdown,
        actions,
        // Tapping the push opens the reply topic's web view so it can also
        // be answered by text (the mobile apps cannot publish on their own).
        ...(ntfy.replyUrl ? { click: ntfy.replyUrl } : {}),
      });
      if (!result.ok && !result.skipped) {
        broker.resolve(request.requestID);
        toast(`Notify: ntfy push failed (${result.error})`, "error");
        return null;
      }
      broker.markPublished(request.requestID);
      return request;
    }

    // Requests answered or dismissed in the TUI (or by our own reply) drop
    // out of the reply channel; a session going busy settles its requests.
    let disposed = false;
    api.event.on("permission.replied", (event) => broker?.resolve(event.properties?.requestID));
    api.event.on("question.replied", (event) => broker?.resolve(event.properties?.requestID));
    api.event.on("question.rejected", (event) => broker?.resolve(event.properties?.requestID));
    api.lifecycle?.onDispose?.(() => {
      disposed = true;
      pushes.stop();
      broker?.stop();
    });

    async function markBusy(sessionID) {
      // A subagent going busy must not stop the parent's blink marker or clear
      // its notification, and it never signals on completion either.
      if (isSubagent(sessionID)) return;
      busyEpochs.set(sessionID, epochOf(sessionID) + 1);
      busySessions.add(sessionID);
      broker?.clearSession(sessionID);
      stopGhosttyPoll();
      await zellij.stopBlinking();
      if (notifier.available) await notifier.clear();
    }

    // `session.execution.started` is the live V2 busy signal; the legacy
    // `session.status` busy event is kept as a secondary source. Both are
    // gated on location: another tab's session going busy must not stop this
    // tab's blink marker or clear its pending notification.
    api.event.on("session.execution.started", async (event) => {
      if (isForeignLocation(event)) return;
      await markBusy(event.properties?.sessionID);
    });
    api.event.on("session.status", async (event) => {
      if (event.properties?.status?.type !== "busy") return;
      if (isForeignLocation(event)) return;
      await markBusy(event.properties?.sessionID);
    });

    async function handleAttention(event) {
      const sessionID = event.properties?.sessionID;
      if (event.type === "session.execution.failed") {
        // A failed execution ends the busy cycle like a completion does:
        // bump the epoch so any in-flight attention work for this session is
        // dropped, then clear the busy marker.
        busyEpochs.set(sessionID, epochOf(sessionID) + 1);
        busySessions.delete(sessionID);
      }
      const epoch = epochOf(sessionID);
      if (event.type === "session.idle") {
        if (!busySessions.has(sessionID)) {
          return;
        }
        busySessions.delete(sessionID);
        if (isSubagent(sessionID)) return;
        // With background subagents, a direct child finishing re-wakes this
        // session, so its turn is not over yet: signalling now would fire
        // again when the session finally completes. Mirrors the built-in
        // notifications plugin, which skips completions while a direct
        // child is still running.
        if (hasRunningChild(sessionID)) return;
      }

      const now = Date.now();
      if (now - lastNotifyTime < DEBOUNCE_MS) {
        return;
      }
      lastNotifyTime = now;

      // "Being viewed" needs both the Zellij tab and, when session tabs are
      // enabled and this session is an open tab, the OpenCode session tab to
      // point here. A background OpenCode tab inside the active Zellij tab
      // still needs a signal. Falls back to the Zellij check alone when tabs
      // are disabled or the session is not an open tab.
      const zellijTabActive = (await zellij.isTabActive()) === true;
      const sessionTabActive = isSessionTabActive(sessionID);
      const tabActive =
        sessionTabActive === undefined ? zellijTabActive : sessionTabActive && zellijTabActive;
      // Lock state is detected independently of the push mode: "off" must
      // still queue a desktop notification for unlock, and "on" must not
      // depend on detection working. The mode only decides whether ntfy
      // pushes: "auto" pushes when locked, "on" pushes always, "off" never.
      const locked = lock.available ? await lock.isLocked() : false;
      const pushCandidate =
        ntfy.available && (pushMode === "on" || (pushMode === "auto" && locked));
      // Visibility is irrelevant while locked (nobody is looking); otherwise
      // probe it - the push decision and the desktop path both need it.
      const ghosttyVisible =
        locked || !ghostty.available ? false : (await ghostty.isVisible()) === true;
      // Always-on replaces the desktop notification rather than firing on
      // top of it: while the terminal is visible, the normal in-terminal
      // signals (nothing, or blink + sound on another tab) apply and no push
      // is sent. When the terminal is not visible - or the screen is locked -
      // the push takes the desktop notification's place.
      const pushActive = pushCandidate && (locked || ghosttyVisible !== true);

      // The probes above awaited subprocesses; if this session went busy
      // again in the meantime (or the plugin was disposed) this event is
      // stale. The busy handler already cleaned up, so just drop it.
      if (disposed || epoch !== epochOf(sessionID)) {
        return;
      }

      if (pushActive) {
        const stillPushCandidate = () =>
          ntfy.available && (pushMode === "on" || (pushMode === "auto" && locked));
        const pushed = await sendNtfyNotification(
          event,
          () => disposed || epoch !== epochOf(sessionID) || !stillPushCandidate(),
        );
        // The user may have answered (or the plugin was disposed) while the
        // push was in flight: don't re-signal a busy session, and untrack a
        // request whose session was settled in the meantime.
        if (disposed || epoch !== epochOf(sessionID)) {
          if (pushed) broker?.resolve(pushed.requestID);
          return;
        }
        if (ntfyConfig?.desktop === "keep" && notifier.available) {
          await sendDesktopNotification(event);
          if (disposed || epoch !== epochOf(sessionID)) return;
        }
        // The blink marker points to a background tab; on the active tab the
        // user is already looking at the session (or will see it directly),
        // so blinking it would just flicker the name they are reading.
        if (!tabActive) await zellij.startBlinking();
        return;
      }

      if (tabActive && ghosttyVisible === true) return;

      if (!tabActive) {
        // Inactive Zellij tab: blink it (no-op if Zellij unavailable).
        await zellij.startBlinking();

        if (ghosttyVisible === true) {
          // User has the terminal up but is on a different tab.
          // Audible cue is enough; don't spam desktop notifications.
          await sound.play();
        } else {
          // Terminal is not visible (or unknown): desktop notification.
          await sendDesktopNotification(event);
        }
      } else {
        // Tab is active but Ghostty isn't visible (e.g. user tabbed away
        // from terminal). Post notification and poll for the user returning.
        await sendDesktopNotification(event);
        startGhosttyPoll();
      }
    }

    for (const [eventName, type] of ATTENTION_EVENTS) {
      api.event.on(eventName, async (event) => {
        // Another location's attention is that tab's instance's job; without
        // this gate every Zellij tab would signal every session's events.
        if (isForeignLocation(event)) return;
        try {
          await handleAttention({ ...event, type });
        } catch (err) {
          toast(`Notify error: ${err.message}`, "error");
        }
      });
    }
  };
}

// ---------------------------------------------------------------------------
// V2 TUI entry (`./tui`).
//
// The V1 TUI api this plugin was built against (api.kv, api.event.on with
// { properties }, api.keymap.registerLayer, api.lifecycle.onDispose,
// api.ui.toast, and client.permission.reply / client.question.reply) is
// adapted from the V2 TUI plugin context so the behavior below stays
// unchanged. The one place V2 differs semantically is questions: V1's
// `question.asked` is the V2 `form.created` event, and V2 answers forms with
// a keyed object instead of per-question answer arrays.
// ---------------------------------------------------------------------------

function newestAssistantText(messages) {
  let best = null;
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    const text = (message.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("\n\n")
      .trim();
    const created = message.time?.created ?? 0;
    if (text && (!best || created >= best.created)) best = { text, created };
  }
  return best?.text ?? "";
}

// Map a V2 form into the V1 `question.asked` shape the notification formatters
// and reply parsers expect.
export function formToQuestion(form) {
  return {
    sessionID: form.sessionID,
    id: form.id,
    questions: (form.fields ?? []).map((field) => ({
      // V2's question tool puts the short header in `title` and the actual
      // question in `description`; fall back through both, then the key.
      question: field.description ?? field.title ?? field.key,
      header: field.title ?? field.key,
      options: (field.options ?? []).map((option) => ({
        label: option.label,
        description: option.description ?? "",
      })),
      multiple: field.type === "multiselect",
      custom: field.custom !== false,
    })),
  };
}

// Turn the reply channel's per-question answer arrays into the keyed answer
// object a V2 form expects, using the field order from the original form.
export function answersToForm(answers, form) {
  const result = {};
  const fields = form?.fields ?? [];
  answers.forEach((answer, index) => {
    const field = fields[index];
    if (!field || answer == null) return;
    if (field.type === "multiselect") {
      result[field.key] = answer.map((label) => {
        const option = (field.options ?? []).find(
          (item) => item.label === label || item.value === label,
        );
        return option ? option.value : label;
      });
      return;
    }
    if (field.type === "boolean") {
      result[field.key] = /^(yes|true|1)$/i.test(answer[0] ?? "");
      return;
    }
    if (field.type === "number" || field.type === "integer") {
      const value = Number(answer[0]);
      result[field.key] = Number.isNaN(value) ? answer[0] : value;
      return;
    }
    // The reply channel sends option labels; a single-select string field
    // needs the option's value when label and value differ.
    if (Array.isArray(field.options) && field.options.length > 0) {
      const option = field.options.find(
        (item) => item.label === answer[0] || item.value === answer[0],
      );
      result[field.key] = option ? option.value : answer[0];
      return;
    }
    result[field.key] = answer[0];
  });
  return result;
}

export function createLegacyApi(context) {
  // V2 permission and form replies both need the owning session id, which the
  // reply channel does not carry. Learn it from the attention events the
  // plugin already observes.
  const permissionSessions = new Map();
  const formSessions = new Map();
  const forms = new Map();

  function track(type, data) {
    if (type === "permission.asked") permissionSessions.set(data.id, data.sessionID);
    if (type === "form.created") {
      formSessions.set(data.form.id, data.form.sessionID);
      forms.set(data.form.id, data.form);
    }
  }

  const unsubscribers = [];

  function subscribeEvent(context, type, handler) {
    if (type === "question.asked") {
      return context.data.on("form.created", (item) => {
        track("form.created", item.data);
        handler({ type, properties: formToQuestion(item.data.form), location: item.location });
      });
    }
    if (type === "permission.asked") {
      return context.data.on("permission.asked", (item) => {
        track("permission.asked", item.data);
        handler({
          type,
          properties: {
            ...item.data,
            // V1 named the action `permission`; replies and push bodies
            // render it ("Permission requested: bash", "Approved bash").
            permission: item.data.action,
            // V1 named these `patterns` (displayed) and `always` (persistable).
            patterns: item.data.resources,
            always: item.data.save,
          },
          location: item.location,
        });
      });
    }
    if (type === "question.replied") {
      return context.data.on("form.replied", (item) =>
        handler({ type, properties: { requestID: item.data.id }, location: item.location }),
      );
    }
    if (type === "question.rejected") {
      return context.data.on("form.cancelled", (item) =>
        handler({ type, properties: { requestID: item.data.id }, location: item.location }),
      );
    }
    return context.data.on(type, (item) =>
      handler({ type, properties: item.data, location: item.location }),
    );
  }

  const client = {
    permission: {
      async reply(input) {
        const sessionID = permissionSessions.get(input.requestID);
        if (!sessionID) throw new Error("unknown permission request");
        await context.client.permission.reply({
          sessionID,
          requestID: input.requestID,
          decision: input.reply,
          message: input.message,
        });
      },
    },
    question: {
      async reply(input) {
        const sessionID = formSessions.get(input.requestID);
        if (!sessionID) throw new Error("unknown form");
        await context.client.session.form.reply({
          sessionID,
          formID: input.requestID,
          answer: answersToForm(input.answers, forms.get(input.requestID)),
        });
      },
      async reject(input) {
        const sessionID = formSessions.get(input.requestID);
        if (!sessionID) throw new Error("unknown form");
        await context.client.session.form.cancel({ sessionID, formID: input.requestID });
      },
    },
  };

  const event = {
    on(type, handler) {
      // Every event envelope carries the owning session's location; the
      // handlers below gate on it (shared server, multiple TUI instances),
      // so it must be forwarded, not dropped with the rest of the envelope.
      // Unsubscribe functions are collected: the TUI host does not scope
      // `context.data` listeners to the plugin, and a hot reload would
      // otherwise leave the old instance handling events forever.
      const unsubscribe = subscribeEvent(context, type, handler);
      unsubscribers.push(unsubscribe);
      return unsubscribe;
    },
    dispose() {
      while (unsubscribers.length > 0) {
        try {
          unsubscribers.pop()();
        } catch {
          // A dead listener must not block the rest of the cleanup.
        }
      }
    },
  };

  const [store, update] = context.storage.store("state", { initial: { pushMode: "auto" } });
  const kv = {
    ready: true,
    get: (key, fallback) => (key in store ? store[key] : fallback),
    set: (key, value) => {
      void update((draft) => {
        draft[key] = value;
      });
    },
  };

  const keymap = {
    registerLayer(layer) {
      context.keymap.layer(() => ({
        mode: "global",
        commands: (layer.commands ?? []).map((command) => ({
          id: command.name,
          title: command.title,
          description: command.desc,
          group: command.category,
          palette: true,
          run: command.run,
        })),
      }));
    },
  };

  return {
    client,
    event,
    kv,
    keymap,
    ui: {
      toast: (toast) => context.ui.toast.show(toast),
      // The sliding select menu the system settings use; resolves to the
      // chosen value, or undefined when dismissed.
      select: (options) => context.ui.dialog.select(options),
    },
  };
}

export default Plugin.define({
  id: "opencode-notify",
  async setup(context) {
    const disposers = [];
    const api = createLegacyApi(context);
    const run = createTui({
      getSessionTitle: async (_client, sessionID) =>
        context.data.session.get(sessionID)?.title || "",
      getLastAgentText: async (_client, sessionID) => {
        await context.data.session.message.sync(sessionID).catch(() => {});
        return newestAssistantText(context.data.session.message.list(sessionID) ?? []);
      },
      isSubagent: (sessionID) => context.data.session.get(sessionID)?.parentID !== undefined,
      // Direct children only (a grandchild reports to its own parent);
      // mirrors the built-in notifications plugin.
      hasRunningChild: (sessionID) =>
        context.data.session
          .family(sessionID)
          .some(
            (child) =>
              child !== sessionID &&
              context.data.session.get(child)?.parentID === sessionID &&
              context.data.session.status(child) === "running",
          ),
      isSessionTabActive: (sessionID) => {
        const tabs = context.ui?.tabs;
        if (!tabs?.enabled?.()) return undefined;
        const root = context.data.session.root(sessionID);
        const tab = tabs.list().find((item) => item.sessionID === root);
        if (!tab) return undefined;
        return tab.active === true;
      },
      // This TUI's own location, read live per event: with the shared server,
      // only events from this directory are signalled by this instance, and
      // the location changes when a session from another directory is opened
      // or moved.
      locationDirectory: () => context.location?.directory,
    });
    await run(
      {
        ...api,
        lifecycle: { onDispose: (dispose) => disposers.push(dispose) },
      },
      context.options,
    );
    return () => {
      api.event.dispose();
      disposers.forEach((dispose) => dispose());
    };
  },
});
