// Desktop notifications via terminal-notifier (macOS only).

import { hasBinary, run } from "./exec.js";

const GROUP = "opencode";

export async function createNotifier({
  platform = process.platform,
  binaryExists = hasBinary,
  execute = run,
} = {}) {
  const isMac = platform === "darwin";
  const hasTerminalNotifier = isMac ? await binaryExists("terminal-notifier") : false;

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
    return execute("terminal-notifier", args);
  }

  async function clear() {
    await execute("terminal-notifier", ["-remove", GROUP]);
  }

  return {
    available: true,
    reason: null,
    send,
    clear,
  };
}
