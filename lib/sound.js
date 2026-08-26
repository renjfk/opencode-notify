// Attention sound playback via macOS `afplay`.

import { hasBinary, run } from "./exec.js";

const DEFAULT_SOUND = "/System/Library/Sounds/Blow.aiff";

export async function createSound({
  platform = process.platform,
  binaryExists = hasBinary,
  execute = run,
} = {}) {
  const isMac = platform === "darwin";
  const hasAfplay = isMac ? await binaryExists("afplay") : false;

  if (!hasAfplay) {
    return {
      available: false,
      reason: isMac ? "afplay not found" : "not macOS",
      play: async () => {},
    };
  }

  async function play(file = DEFAULT_SOUND) {
    // Fire and forget - do not await actual playback completion.
    execute("afplay", [file], { timeout: 10000 }).catch(() => {});
  }

  return {
    available: true,
    reason: null,
    play,
  };
}
