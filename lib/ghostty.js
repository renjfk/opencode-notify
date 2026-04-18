// Ghostty window visibility detection via AppleScript.
//
// Only available on macOS with `osascript` on PATH. On any other platform, or
// when the check fails, visibility is reported as `null` (unknown) and the
// caller should fall back to a safe default (e.g. treat as "not visible" so
// notifications still fire).

import { hasBinary, run } from "./exec.js";

export async function createGhostty() {
  const isMac = process.platform === "darwin";
  const hasOsascript = isMac ? await hasBinary("osascript") : false;

  if (!hasOsascript) {
    return {
      available: false,
      reason: isMac ? "osascript not found" : "not macOS",
      isVisible: async () => null,
    };
  }

  async function isVisible() {
    const script =
      'tell application "System Events" to get (count of windows of application process "ghostty")';
    const result = await run("osascript", ["-e", script]);
    if (result.code !== 0) return null;
    const n = parseInt(result.stdout.trim(), 10);
    if (Number.isNaN(n)) return null;
    return n > 0;
  }

  return {
    available: true,
    reason: null,
    isVisible,
  };
}
