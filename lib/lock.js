// Screen lock detection (macOS only).
//
// Reads the Aqua session's lock state from the IORegistry (the same source
// as CoreGraphics' CGSessionCopyCurrentDictionary): `ioreg -n Root -d1 -a`
// prints the root entry as an XML plist whose IOConsoleUsers dict contains
// the CGSSessionScreenIsLocked key only while the screen is locked. This is
// the lock state itself, not a proxy, and works on modern macOS including
// 26 (Tahoe), where the lock screen was rebuilt and no longer runs
// ScreenSaverEngine.
//
// Displays that sleep without locking are not detected; switch push
// notifications to "always on" via the command palette to cover that.
//
// When the capability is unavailable or the check fails, the screen is
// treated as NOT locked so the phone is never spammed - the desktop
// notification path still covers missed events.

import { hasBinary, run } from "./exec.js";

const LOCKED_KEY = /CGSSessionScreenIsLocked<\/key>\s*<(true|false|integer|string)\b[^>]*>([^<]*)/;

function parseLockState(plist) {
  const match = plist.match(LOCKED_KEY);
  if (!match) return false;
  const [tag, value] = [match[1], match[2]];
  if (tag === "true") return true;
  if (tag === "false") return false;
  return value.trim() !== "0";
}

export async function createLock({
  platform = process.platform,
  binaryExists = hasBinary,
  execute = run,
} = {}) {
  const isMac = platform === "darwin";
  const hasIoreg = isMac ? await binaryExists("ioreg") : false;

  if (!hasIoreg) {
    return {
      available: false,
      reason: isMac ? "ioreg not found" : "not macOS",
      isLocked: async () => false,
    };
  }

  async function isLocked() {
    const result = await execute("ioreg", ["-n", "Root", "-d1", "-a"]);
    if (result.code !== 0) return false;
    return parseLockState(result.stdout);
  }

  return {
    available: true,
    reason: null,
    isLocked,
  };
}
