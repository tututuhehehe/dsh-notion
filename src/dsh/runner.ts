/**
 * The single ntn spawn path for the DSH plugin.
 *
 * Every tool receives this wrapper instead of runNtn directly, so the live
 * token, workspace id and the ntn PATH are applied in exactly one place.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { runNtn } from "../lib/runNtn.ts";
import type { RunNtnOptions, RunNtnResult } from "../lib/runNtn.ts";
import { resolveToken, type ResolvedNotionConfig } from "./config.ts";

/** Common Homebrew / npm-global locations, used when the host PATH is minimal. */
const KNOWN_NTN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

function ntnDir(config: ResolvedNotionConfig): string | undefined {
  for (const candidate of [config.ntnPath, ...KNOWN_NTN_DIRS]) {
    if (candidate && existsSync(candidate)) return dirname(candidate);
  }
  return undefined;
}

export type NtnRunner = (options: RunNtnOptions) => Promise<RunNtnResult>;

/**
 * Build the token-aware runner shared by the four tools.
 *
 * `getConfig` is invoked per call so a token saved in DSH Settings is picked up
 * by the next tool call without restarting the Host.
 */
export function makeRunner(getConfig: () => ResolvedNotionConfig): NtnRunner {
  return async (options: RunNtnOptions): Promise<RunNtnResult> => {
    const config = getConfig();
    const token = resolveToken(config);
    const env: Record<string, string | undefined> = { ...options.env };
    if (token) env.NOTION_API_TOKEN = token;
    if (config.workspaceId) env.NOTION_WORKSPACE_ID = config.workspaceId;
    const binDir = ntnDir(config);
    if (binDir) env.PATH = [binDir, process.env.PATH].filter(Boolean).join(":");
    return runNtn({
      ...options,
      timeoutMs: options.timeoutMs ?? config.timeoutMs,
      env,
    });
  };
}
