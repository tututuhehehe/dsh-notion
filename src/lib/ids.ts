/**
 * Notion object ID parsing shared by the tools.
 *
 * Why this exists: `ntn pages get` and `ntn datasources resolve` take **IDs**, not URLs. Passing a
 * Notion URL is forwarded verbatim to the public API and comes back as 404 (verified against
 * ntn 0.23.25), so any tool that accepts `id_or_url` has to extract the ID itself.
 *
 * Notion URLs put the object ID in the path (`/p/Some-Title-<32 hex>`, sometimes dashed) and use
 * the query string for unrelated IDs (`?v=<view id>`), so only the path is scanned.
 *
 * Query strings are ignored on purpose. `?v=` is a view id, and `?p=` (peek links) is a navigation
 * pointer; following either here would silently change what a database URL resolves to. If peek
 * links ever need first-class support, handle that explicitly rather than scanning all query ids.
 */

const UUID_TOKEN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BARE_TOKEN = "[0-9a-f]{32}";

/** A whole-string id: dashed UUID or bare 32 hex characters. */
const ID_ONLY_RE = new RegExp(`^(?:${UUID_TOKEN}|${BARE_TOKEN})$`, "i");
/** Any id token inside a longer string (dashed UUID first; bare ids cannot contain dashes). */
const ID_TOKEN_RE = new RegExp(`${UUID_TOKEN}|${BARE_TOKEN}`, "gi");

const NOTION_HOSTS = ["notion.so", "notion.com", "notion.site"];

/**
 * Extract a canonical (dashed, lowercase) Notion ID from an ID or a Notion URL.
 *
 * Accepts:
 *   - `4077266d1cb4817792f0dd7ee36cdd00`
 *   - `4077266d-1cb4-8177-92f0-dd7ee36cdd00`
 *   - `https://app.notion.com/p/4077266d1cb4817792f0dd7ee36cdd00`
 *   - `https://www.notion.so/workspace/Some-Title-4077266d1cb4817792f0dd7ee36cdd00?v=...`
 *   - a pasted string that contains exactly one id (forgiving fallback)
 *
 * Returns null when nothing ID-shaped is present, so callers can fail before spawning `ntn`.
 */
export function extractNotionId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (ID_ONLY_RE.test(raw)) return canonicalize(raw);

  const url = parseNotionUrl(raw);
  if (url) {
    const fromPath = lastId(url.pathname);
    if (fromPath) return fromPath;
  }

  // Fallback for custom notion.site domains / pasted text. Strip query and fragment first so a
  // `?v=<view id>` is never mistaken for the object id.
  return lastId(stripQueryAndFragment(raw));
}

function parseNotionUrl(raw: string): URL | null {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    const isNotion = NOTION_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    return isNotion ? url : null;
  } catch {
    return null;
  }
}

function stripQueryAndFragment(value: string): string {
  return value.split("#", 1)[0].split("?", 1)[0];
}

function lastId(value: string): string | null {
  const matches = value.match(ID_TOKEN_RE);
  if (!matches || matches.length === 0) return null;
  return canonicalize(matches[matches.length - 1]);
}

function canonicalize(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return hex;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
