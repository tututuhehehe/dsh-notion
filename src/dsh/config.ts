/**
 * Runtime configuration for the DSH notion plugin.
 *
 * The token is never compiled into the bundle and is not part of the plugin
 * config object. It resolves, in order, from:
 *   1. the NOTION_API_TOKEN environment variable
 *   2. ./notion-token next to this plugin (tokenFile, relative paths resolve
 *      against the plugin directory)
 * Falling back to `ntn login` credentials when neither is set.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root of this plugin: <plugin dir>/dist/index.js -> <plugin dir>/. */
export const PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url));

export type NotionDshConfig = {
  /** Token file; relative paths resolve against the plugin directory. */
  tokenFile?: string;
  /** Optional Notion workspace id (multi-workspace tokens). */
  workspaceId?: string;
  /** Absolute path to the ntn binary; auto-discovered when omitted. */
  ntnPath?: string;
  /** Per-call timeout for ntn, milliseconds. */
  timeoutMs?: number;
};

export type ResolvedNotionConfig = {
  tokenFile: string;
  workspaceId: string;
  ntnPath: string;
  timeoutMs: number;
};

const DEFAULT_NTN_PATH = "/opt/homebrew/bin/ntn";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TOKEN_FILE = "notion-token";
const PLACEHOLDER = /^(paste|your|replace|todo|secret_xxx$|<)/i;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Resolve tokenFile: absolute and ~/... stay as-is, anything else is plugin-relative. */
export function resolveTokenFile(raw: string): string {
  if (!raw) return join(PLUGIN_ROOT, DEFAULT_TOKEN_FILE);
  if (raw.startsWith("/")) return raw;
  return join(PLUGIN_ROOT, expandHome(raw));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isPlaceholderToken(value: string): boolean {
  return PLACEHOLDER.test(value.trim());
}

/** Snapshot the plugin config; the loader hands plain values (no Config schema is declared). */
export function readConfig(raw: unknown): ResolvedNotionConfig {
  const config = (raw && typeof raw === "object" ? raw : {}) as NotionDshConfig;
  const timeout = number(config.timeoutMs);
  return {
    tokenFile: resolveTokenFile(text(config.tokenFile)),
    workspaceId: text(config.workspaceId),
    ntnPath: text(config.ntnPath) || DEFAULT_NTN_PATH,
    timeoutMs: timeout !== undefined && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Resolve the Notion integration token from the environment, then the token
 * file. Returns "" when neither is configured, which lets `ntn login`
 * credentials work. Throws when the token file still holds the placeholder so
 * the failure names the exact file to edit instead of a generic auth error.
 */
export function resolveToken(config: ResolvedNotionConfig): string {
  const fromEnv = text(process.env.NOTION_API_TOKEN);
  if (fromEnv && !isPlaceholderToken(fromEnv)) return fromEnv;

  let contents: string;
  try {
    contents = readFileSync(config.tokenFile, "utf8");
  } catch {
    return "";
  }
  const line = contents
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith("#")) ?? "";
  if (!line) return "";
  if (isPlaceholderToken(line)) {
    throw new Error(
      `Notion token is not configured yet: set the NOTION_API_TOKEN environment variable, ` +
        `or edit ${config.tokenFile} and replace the placeholder with your integration token ` +
        `(starts with "secret_" or "ntn_"), or delete that file and run \`ntn login\` instead.`,
    );
  }
  return line;
}
