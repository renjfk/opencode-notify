// Zellij tab discovery and blinking.
//
// Capability is only `available` when both:
//   - the process is running inside a Zellij pane (ZELLIJ_PANE_ID is set)
//   - the `zellij` binary is on PATH
//
// When unavailable, all methods are safe no-ops returning neutral values so
// callers don't need to branch.

import { hasBinary, run } from "./exec.js";

const BLINK_ON = "●";
const BLINK_OFF = "○";
const BLINK_INTERVAL_MS = 600;
const POLL_INTERVAL_MS = 1000;

export async function createZellij() {
  const paneId = process.env.ZELLIJ_PANE_ID;
  const binary = await hasBinary("zellij");

  if (!paneId || !binary) {
    return {
      available: false,
      reason: !paneId ? "not inside a Zellij session" : "zellij binary not found",
      isTabActive: async () => true,
      startBlinking: async () => {},
      stopBlinking: async () => {},
      getTabName: async () => "",
    };
  }

  let cachedTabId = null;

  async function listPanes() {
    const result = await run("zellij", ["action", "list-panes", "--json"]);
    if (result.code !== 0) return [];
    try {
      return JSON.parse(result.stdout);
    } catch {
      return [];
    }
  }

  function findOurPane(panes) {
    return panes.find((p) => p.id === Number(paneId) && !p.is_plugin);
  }

  async function getTabId() {
    if (cachedTabId !== null) return cachedTabId;
    const panes = await listPanes();
    cachedTabId = findOurPane(panes)?.tab_id ?? null;
    return cachedTabId;
  }

  async function getTabName() {
    const panes = await listPanes();
    return findOurPane(panes)?.tab_name || "opencode";
  }

  async function isTabActive() {
    const tabId = await getTabId();
    if (tabId === null) return true;
    const result = await run("zellij", ["action", "current-tab-info", "--json"]);
    if (result.code !== 0) return true;
    try {
      return JSON.parse(result.stdout).tab_id === tabId;
    } catch {
      return true;
    }
  }

  async function renameTab(name) {
    const tabId = await getTabId();
    if (tabId === null) return;
    await run("zellij", ["action", "rename-tab-by-id", String(tabId), name]);
  }

  // ---- Blinking state ----

  let originalTabName = null;
  let blinkTimer = null;
  let pollTimer = null;
  let blinkState = false;

  async function startBlinking({ onStopped } = {}) {
    if (blinkTimer) return;

    originalTabName = await getTabName();
    const tabId = await getTabId();
    if (tabId === null || !originalTabName) return;

    blinkState = true;
    blinkTimer = setInterval(async () => {
      const marker = blinkState ? BLINK_ON : BLINK_OFF;
      try {
        await renameTab(`${marker} ${originalTabName}`);
        blinkState = !blinkState;
      } catch {
        stopBlinkingInternal();
      }
    }, BLINK_INTERVAL_MS);

    pollTimer = setInterval(async () => {
      try {
        if (await isTabActive()) {
          await stopBlinking();
          if (onStopped) onStopped("tab-activated");
        }
      } catch {}
    }, POLL_INTERVAL_MS);
  }

  function stopBlinkingInternal() {
    if (blinkTimer) {
      clearInterval(blinkTimer);
      blinkTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    blinkState = false;
  }

  async function stopBlinking() {
    stopBlinkingInternal();
    if (originalTabName !== null) {
      try {
        await renameTab(originalTabName);
      } catch {}
      originalTabName = null;
    }
  }

  return {
    available: true,
    reason: null,
    getTabName,
    isTabActive,
    startBlinking,
    stopBlinking,
  };
}
