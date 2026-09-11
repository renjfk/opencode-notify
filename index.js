// opencode-notify: attention notifications for OpenCode.
//
// On attention events (session idle after work, permission asked, question
// asked), the plugin decides what to do based on which capabilities are
// available and whether the user is likely to miss the event:
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

const ATTENTION_EVENTS = new Set(["session.idle", "permission.asked", "question.asked"]);

const ATTENTION_META = {
  "permission.asked": { message: "Permission requested", priority: "high", tags: ["warning"] },
  "question.asked": { message: "Question needs your answer", priority: "high", tags: ["question"] },
  "session.idle": { message: "Task completed", priority: "default", tags: ["white_check_mark"] },
};

const PUSH_MODES = ["auto", "on", "off"];
const KV_PUSH_MODE = "notify.pushMode";

const PUSH_MODE_META = {
  auto: { label: "automatic (when the screen locks)", title: "Push notifications: automatic" },
  on: { label: "always on", title: "Push notifications: always on" },
  off: { label: "off", title: "Push notifications: off" },
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
    if (ntfy.configured && api.keymap?.registerLayer) {
      api.keymap.registerLayer({
        commands: PUSH_MODES.map((mode) => ({
          namespace: "palette",
          name: `notify.push.${mode}`,
          title: PUSH_MODE_META[mode].title,
          desc: "opencode-notify: route attention pushes to ntfy",
          category: "Notify",
          run: () => setPushMode(mode),
        })),
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

    api.event.on("session.status", async (event) => {
      if (event.properties?.status?.type === "busy") {
        const sessionID = event.properties?.sessionID;
        busyEpochs.set(sessionID, epochOf(sessionID) + 1);
        busySessions.add(sessionID);
        broker?.clearSession(sessionID);
        stopGhosttyPoll();
        await zellij.stopBlinking();
        if (notifier.available) await notifier.clear();
      }
    });

    async function handleAttention(event) {
      const sessionID = event.properties?.sessionID;
      const epoch = epochOf(sessionID);
      if (event.type === "session.idle") {
        if (!busySessions.has(sessionID)) {
          return;
        }
        busySessions.delete(sessionID);
      }

      const now = Date.now();
      if (now - lastNotifyTime < DEBOUNCE_MS) {
        return;
      }
      lastNotifyTime = now;

      const tabActive = await zellij.isTabActive();
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

    for (const type of ATTENTION_EVENTS) {
      api.event.on(type, async (event) => {
        try {
          await handleAttention({ ...event, type });
        } catch (err) {
          toast(`Notify error: ${err.message}`, "error");
        }
      });
    }
  };
}

export default {
  id: "opencode-notify",
  tui: createTui(),
};
