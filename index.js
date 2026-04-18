// opencode-notify: attention notifications for OpenCode.
//
// On attention events (session idle after work, permission asked, question
// asked), the plugin decides what to do based on which capabilities are
// available and whether the user is likely to miss the event:
//
//   Tab active | Ghostty visible | Action
//   -----------|-----------------|----------------------------
//   Yes        | Yes             | Do nothing (user can see it)
//   Yes        | No              | Desktop notification
//   No         | Yes             | Blink tab + sound
//   No         | No              | Blink tab + desktop notification
//
// Every capability (Zellij, Ghostty, terminal-notifier, afplay) is optional
// and probed at startup. Missing capabilities are skipped gracefully and the
// plugin continues with whatever is available.

import { createZellij } from "./lib/zellij.js";
import { createGhostty } from "./lib/ghostty.js";
import { createNotifier } from "./lib/notifier.js";
import { createSound } from "./lib/sound.js";
import { getSessionTitle } from "./lib/session.js";

const DEBOUNCE_MS = 2000;
const POLL_INTERVAL_MS = 1000;

const ATTENTION_EVENTS = new Set(["session.idle", "permission.asked", "question.asked"]);

export default {
  id: "opencode-notify",
  tui: async (api) => {
    const client = api.client;

    function toast(message, variant = "info") {
      api.ui.toast({ message, variant, duration: 4000 });
    }

    const zellij = await createZellij();
    const ghostty = await createGhostty();
    const notifier = await createNotifier();
    const sound = await createSound();

    // Startup warnings - never throw, just inform the user what is disabled.
    if (!zellij.available) {
      toast(`Notify: tab blinking disabled (${zellij.reason})`, "warning");
    }
    if (!notifier.available) {
      toast(`Notify: desktop notifications disabled (${notifier.reason})`, "warning");
    }

    // If nothing useful is available, log once and return without subscribing.
    if (!zellij.available && !notifier.available && !sound.available) {
      toast("Notify: no capabilities available on this system", "warning");
      return;
    }

    let lastNotifyTime = 0;
    let wasBusy = false;
    let ghosttyPollTimer = null;

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
      const sessionTitle = (await getSessionTitle(client, sessionID)) || "";

      let message;
      if (event.type === "permission.asked") {
        message = "Permission requested";
      } else if (event.type === "question.asked") {
        message = "Question needs your answer";
      } else {
        message = "Task completed";
      }

      const result = await notifier.send({
        title: tabName || "OpenCode",
        subtitle: sessionTitle,
        message,
        sound: "Blow",
      });
      if (result.code !== 0 && !result.skipped) {
        toast(`Notify: desktop notification failed (exit ${result.code})`, "error");
      }
    }

    api.event.on("session.status", async (event) => {
      if (event.properties?.status?.type === "busy") {
        wasBusy = true;
        stopGhosttyPoll();
        await zellij.stopBlinking();
        if (notifier.available) await notifier.clear();
      }
    });

    async function handleAttention(event) {
      if (event.type === "session.idle") {
        if (!wasBusy) return;
        wasBusy = false;
      }

      const now = Date.now();
      if (now - lastNotifyTime < DEBOUNCE_MS) return;
      lastNotifyTime = now;

      const tabActive = await zellij.isTabActive();
      // If we can't determine visibility, treat as "not visible" so the user
      // still gets pinged. This is the safe fallback.
      const ghosttyVisible = ghostty.available ? await ghostty.isVisible() : false;

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
  },
};
