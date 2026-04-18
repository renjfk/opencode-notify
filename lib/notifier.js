// Desktop notifications via terminal-notifier (macOS only).

import { hasBinary, run } from "./exec.js";

const GROUP = "opencode";

export async function createNotifier() {
  const isMac = process.platform === "darwin";
  const hasTerminalNotifier = isMac ? await hasBinary("terminal-notifier") : false;

  if (!hasTerminalNotifier) {
    return {
      available: false,
      reason: isMac ? "terminal-notifier not found (brew install terminal-notifier)" : "not macOS",
      send: async () => ({ code: 0, skipped: true }),
      clear: async () => {},
    };
  }

  async function send({ title, subtitle, message, sound = "Blow" } = {}) {
    const args = [];
    if (title) args.push("-title", title);
    if (subtitle) args.push("-subtitle", subtitle);
    args.push("-message", message || "");
    if (sound) args.push("-sound", sound);
    args.push("-group", GROUP);
    return run("terminal-notifier", args);
  }

  async function clear() {
    await run("terminal-notifier", ["-remove", GROUP]);
  }

  return {
    available: true,
    reason: null,
    send,
    clear,
  };
}
