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
const BLINK_MARKER_RE = /^(?:[●○]\s+)+/;

// Leftover markers from a previous blink cycle (a crash, a lost rename race,
// or a Zellij session that outlived the plugin) must never become part of the
// stored name, otherwise every new cycle would stack another dot.
function stripBlinkMarkers(name) {
  return name.replace(BLINK_MARKER_RE, "");
}

export async function createZellij({
  paneId = process.env.ZELLIJ_PANE_ID,
  binaryExists = hasBinary,
  execute = run,
} = {}) {
  const binary = await binaryExists("zellij");

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
    const result = await execute("zellij", ["action", "list-panes", "--json"]);
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
    return stripBlinkMarkers(findOurPane(panes)?.tab_name || "opencode");
  }

  async function isTabActive() {
    const tabId = await getTabId();
    if (tabId === null) return true;
    const result = await execute("zellij", ["action", "current-tab-info", "--json"]);
    if (result.code !== 0) return true;
    try {
      return JSON.parse(result.stdout).tab_id === tabId;
    } catch {
      return true;
    }
  }

  async function renameTab(name) {
    const tabId = await getTabId();
    if (tabId === null) return false;
    const result = await execute("zellij", ["action", "rename-tab-by-id", String(tabId), name]);
    return result.code === 0;
  }

  // ---- Blinking state ----
  //
  // All renames go through a single FIFO queue so they apply in a strict
  // order. A blink rename queued behind slower operations records the
  // generation it belongs to; stopBlinking bumps the generation and enqueues
  // the restore, so the restore always has the last word and no stale blink
  // rename can land after it. That is what previously left a stuck `●` in
  // the tab title when a stop interleaved with an in-flight rename.

  let originalTabName = null;
  let blinkTimer = null;
  let pollTimer = null;
  let blinkState = false;
  let blinkGeneration = 0;
  let starting = false;
  let renameQueue = Promise.resolve();

  function enqueueRename(name) {
    renameQueue = renameQueue.then(async () => {
      try {
        await renameTab(name);
      } catch {}
    });
    return renameQueue;
  }

  function enqueueBlinkRename(marker) {
    const generation = blinkGeneration;
    renameQueue = renameQueue.then(async () => {
      if (generation !== blinkGeneration) return;
      const name = originalTabName;
      if (name === null) return;
      let ok = false;
      try {
        ok = await renameTab(`${marker} ${name}`);
      } catch {}
      // The cycle may have been stopped (and a new one started) while this
      // rename was in flight; a failure here must not stop the new cycle.
      if (!ok && generation === blinkGeneration) stopBlinking();
    });
    return renameQueue;
  }

  async function startBlinking() {
    // Guard the whole async setup: two overlapping calls used to both pass
    // the `blinkTimer` check during the awaits and leak one interval.
    if (blinkTimer || starting) return;
    starting = true;
    try {
      originalTabName = await getTabName();
      const tabId = await getTabId();
      if (tabId === null || !originalTabName) {
        originalTabName = null;
        return;
      }

      blinkState = true;
      blinkTimer = setInterval(() => {
        const marker = blinkState ? BLINK_ON : BLINK_OFF;
        blinkState = !blinkState;
        enqueueBlinkRename(marker);
      }, BLINK_INTERVAL_MS);

      pollTimer = setInterval(async () => {
        try {
          if (await isTabActive()) {
            await stopBlinking();
          }
        } catch {}
      }, POLL_INTERVAL_MS);
    } finally {
      starting = false;
    }
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
    blinkGeneration += 1;
    stopBlinkingInternal();
    if (originalTabName !== null) {
      const name = originalTabName;
      originalTabName = null;
      await enqueueRename(name);
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
