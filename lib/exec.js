// Small helpers around node:child_process for safe, quiet command execution.

import { execFile } from "node:child_process";

/**
 * Run a command with arguments and resolve with { stdout, stderr, code }.
 * Never rejects - callers inspect `code`. Stderr/stdout are captured as strings.
 */
export function run(cmd, args = [], { timeout = 5000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (err.code ?? 1) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error: err || null,
        });
      },
    );
    if (input != null && child.stdin) {
      child.stdin.end(input);
    }
  });
}

/**
 * Check if a binary is available on PATH. Uses `command -v` for portability.
 */
export async function hasBinary(name) {
  const result = await run("/bin/sh", ["-c", `command -v ${JSON.stringify(name)}`]);
  return result.code === 0 && result.stdout.trim().length > 0;
}
