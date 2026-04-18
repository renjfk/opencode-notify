// Attention sound playback via macOS `afplay`.

import { hasBinary, run } from "./exec.js";

const DEFAULT_SOUND = "/System/Library/Sounds/Blow.aiff";

export async function createSound() {
  const isMac = process.platform === "darwin";
  const hasAfplay = isMac ? await hasBinary("afplay") : false;

  if (!hasAfplay) {
    return {
      available: false,
      reason: isMac ? "afplay not found" : "not macOS",
      play: async () => {},
    };
  }

  async function play(file = DEFAULT_SOUND) {
    // Fire and forget - do not await actual playback completion.
    run("afplay", [file], { timeout: 10000 }).catch(() => {});
  }

  return {
    available: true,
    reason: null,
    play,
  };
}
