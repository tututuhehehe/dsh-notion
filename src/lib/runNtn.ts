/**
 * Shared helper: spawn `ntn` with --json when requested, never a free-form shell for the model.
 * Callers pass argv only (no shell interpolation).
 */
import { spawn } from "node:child_process";

export type RunNtnResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
};

export type RunNtnOptions = {
  args: string[];
  /** Extra env; NOTION_API_TOKEN from process.env is always passed through. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /**
   * Cancellation from the caller (DSH passes the tool call's signal). Aborting it
   * kills the child process instead of leaving `ntn` running after the call is gone.
   */
  signal?: AbortSignal;
  /** Injected for tests. */
  spawnFn?: typeof spawn;
};

export async function runNtn(options: RunNtnOptions): Promise<RunNtnResult> {
  const { args, env, timeoutMs = 60_000, signal, spawnFn = spawn } = options;
  return new Promise((resolve) => {
    // Cancelled before spawning: report it without starting a process at all.
    if (signal?.aborted) {
      resolve({ ok: false, stdout: "", stderr: "ntn call aborted before it started", code: null });
      return;
    }
    const child = spawnFn("ntn", args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunNtnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    // Caller cancellation kills the child so a cancelled call cannot keep burning API quota.
    const onAbort = () => {
      child.kill("SIGTERM");
      finish({ ok: false, stdout, stderr: stderr || "ntn call aborted", code: null });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, stdout, stderr: stderr || `ntn timed out after ${timeoutMs}ms`, code: null });
    }, timeoutMs);
    child.stdout?.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", (err) => {
      const msg = err.message.includes("ENOENT")
        ? "ntn not found on PATH. Install: npm i -g ntn  (or https://ntn.dev). Then ntn login or set NOTION_API_TOKEN."
        : err.message;
      finish({ ok: false, stdout, stderr: msg, code: null });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, stdout, stderr, code });
    });
  });
}

export function parseJsonStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}
