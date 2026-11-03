/**
 * Turning an `ntn` failure into something a model can act on.
 *
 * `ntn` exits non-zero with a real message for most problems, but a few shapes are
 * opaque: a bare `Failed to execute public API request` names no cause, and "not
 * installed" / "not logged in" / "no workspace" / "not shared" all look like generic
 * failures unless they are recognised. A model that cannot tell them apart retries the
 * same call, or reports the wrong problem to the user.
 *
 * The rule here is: attach a hint ONLY when the text actually identifies the cause. If
 * nothing matches, say nothing extra — a confidently wrong diagnosis is worse than none.
 * For the one genuinely opaque case the hint says so and suggests one retry, rather than
 * pretending to know whether it was the network, the token or the workspace.
 */
import type { RunNtnResult } from "./runNtn.ts";

/** Longest slice of stderr we are willing to repeat to the model. */
const SNIPPET_LIMIT = 300;

/** One recognised failure shape and what to do about it. */
type FailureHint = {
  match: RegExp;
  hint: string;
};

/**
 * ORDER MATTERS. The token pattern also contains "run `ntn login`", so it must be tested
 * before the workspace pattern or the workspace advice (which does not fix a bad token)
 * would win.
 */
const FAILURE_HINTS: readonly FailureHint[] = [
  {
    match: /not found on PATH|ENOENT/i,
    hint: "Hint: the Notion CLI is not installed where this process can see it. Install it with `npm i -g ntn` (or `curl -fsSL https://ntn.dev | bash`), then run `ntn login`.",
  },
  {
    // The binary exists but the OS refused to execute it — a different fix from "missing".
    match: /EACCES|EPERM/i,
    hint: "Hint: `ntn` was found but the OS refused to execute it (EACCES/EPERM). Fix the file's permissions or its mount options; reinstalling will not help while the permission is wrong.",
  },
  {
    match: /api token is invalid|unauthorized|\b401\b|invalid_token/i,
    hint: "Hint: the token was rejected. Set a valid NOTION_API_TOKEN (or run `ntn login`), and make sure the target pages/databases are shared with that integration.",
  },
  {
    match: /no workspace selected|not logged in|not authenticated/i,
    hint: "Hint: not authenticated yet. Run `ntn login`, or set NOTION_API_TOKEN (plus NOTION_WORKSPACE_ID for multi-workspace tokens), then share the target pages/databases with the integration.",
  },
  {
    match: /restricted_resource|\b403\b|could not find (page|database)|object_not_found|\b404\b|does not have access|not shared/i,
    hint: "Hint: the object exists but this integration cannot see it (or it does not exist). In Notion open the page/database, use ••• → Connections, and add the integration. A 404 and a missing permission look identical to the API.",
  },
  {
    match: /rate_limited|\b429\b|too many requests/i,
    hint: "Hint: Notion rate-limited the request. Wait a moment and retry the same call; if it repeats, reduce how many calls you make in a burst (for example lower `limit`, or skip `include_content`).",
  },
  {
    match: /\b5\d\d\b|internal_server_error|service_unavailable|gateway_timeout|service_overload/i,
    hint: "Hint: Notion returned a server-side error. This is usually transient — retry once; if it keeps failing the request is probably too large or malformed rather than unlucky.",
  },
  {
    match: /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|network/i,
    hint: "Hint: the request could not reach Notion (network/DNS). Check connectivity and retry.",
  },
  {
    match: /timed out after \d+ms|no exit code/i,
    hint: "Hint: the `ntn` process was killed by our own timeout. Narrow the request (lower `limit`, avoid `include_content`) or retry; a repeated timeout is not a credential problem.",
  },
  {
    // ntn's own wrapper message, with the underlying cause discarded. We cannot tell
    // which of the above it was, so we say exactly that instead of guessing.
    match: /failed to execute public API request/i,
    hint: "Hint: `ntn` discarded the underlying cause here (its own wording), so the reason is genuinely unknown from this error. Retry once; if it persists, check the token, the workspace, and whether the target is shared with the integration, in that order.",
  },
];

/** The longest snippet of raw stderr we repeat; the full text is rarely useful. */
export function snippet(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "<empty>";
  return trimmed.length > SNIPPET_LIMIT ? `${trimmed.slice(0, SNIPPET_LIMIT)}…` : trimmed;
}

/** The actionable hint for this failure, or `undefined` when nothing is recognised. */
export function failureHint(result: RunNtnResult): string | undefined {
  const text = `${result.stderr}\n${result.stdout}`;
  if (!text.trim()) return undefined;
  return FAILURE_HINTS.find((entry) => entry.match.test(text))?.hint;
}

/**
 * One-line status: what failed and how it exited.
 * `no exit code` means the child never produced one — killed by our timeout, or unable to
 * start at all — which is a different situation from a normal non-zero exit.
 */
export function failureStatus(result: RunNtnResult): string {
  return result.code === null ? "no exit code (timed out or could not start)" : `exit ${result.code}`;
}

/**
 * The full model-facing failure text: label, exit status, a bounded slice of ntn's own
 * message, and (only when recognised) one actionable hint.
 */
export function describeFailure(result: RunNtnResult, label?: string): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return [
    `${label ? `${label}: ` : ""}ntn ${failureStatus(result)}.`,
    detail ? snippet(detail) : "ntn printed no error text.",
    failureHint(result),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}
