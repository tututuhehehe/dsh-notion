/**
 * The tool contract this plugin registers into DSH's `ctx.tools`.
 *
 * A DSH tool is four things the registry owns end to end:
 *   - `name`, `description`, `parameters`: what the model sees. The registry does
 *     NOT validate arguments against `parameters` (only `defineTool` does, and
 *     this plugin hand-writes its definitions), so every tool body guards its own
 *     arguments and reports a fixable problem as `INVALID_INPUT`;
 *   - `output.schema`: the contract a successful canonical value must satisfy,
 *     validated by the registry before anything is shown;
 *   - `output.render`: the model-facing text blocks derived from that value;
 *   - `execute`: the body. It returns the canonical value; a thrown error becomes
 *     the call's error result.
 *
 * Nothing here is presentation-specific: the same definition drives native
 * function calling and the generated PTC SDK.
 */

export type TextBlock = { type: "text"; text: string };

export type JsonObject = Record<string, unknown>;

/** What the registry passes to a tool body. */
export type ToolExecution = {
  /**
   * Aborted when the call is cancelled or its configured timeout fires. Every
   * `ntn` call is spawned with it, so cancellation kills the child process.
   */
  signal?: AbortSignal;
};

/**
 * Stable error kinds, in the order a caller meets them.
 *
 * The DSH registry renders a thrown error as `Error: <message>` and keeps a
 * structured `{ name, code }` only for its own `HarnessError` instances, so a
 * plain Error's `code` would never reach the model or the session log. This
 * plugin therefore carries the kind inside the message text, which is the one
 * channel the registry always forwards.
 */
export const NOTION_ERROR_CODES = {
  /** The caller's arguments cannot be acted on; re-read the message and retry. */
  invalidInput: "INVALID_INPUT",
  /** `ntn` itself failed (bad token, no workspace, Notion API error, exit != 0). */
  ntnFailed: "NTN_FAILED",
  /** The call was cancelled or timed out; the child process was killed. */
  aborted: "ABORTED",
  /** A follow-up write failed and the page could not be fully cleaned up. */
  partialWrite: "PARTIAL_WRITE",
} as const;

export type NotionErrorCode = (typeof NOTION_ERROR_CODES)[keyof typeof NOTION_ERROR_CODES];

/**
 * A failure the model is meant to read and correct: bad input, a Notion schema
 * conflict, an `ntn` call that failed.
 *
 * `message` is prefixed with `[CODE]` so the kind survives DSH's rendering
 * (which forwards only the message text); `detail` keeps the unprefixed prose,
 * and `details` keeps the structured payload for tests and logs.
 */
export class NotionToolError extends Error {
  /** Stable machine-readable kind (`INVALID_INPUT`, `NTN_FAILED`, ...). */
  readonly code: NotionErrorCode;
  /** Structured payload; never model-facing (DSH drops it), used by tests/logs. */
  readonly details: JsonObject;
  /** The message as authored, without the `[CODE]` prefix. */
  readonly detail: string;

  constructor(
    message: string,
    options: { code?: NotionErrorCode; details?: JsonObject } = {}
  ) {
    const code = options.code ?? NOTION_ERROR_CODES.invalidInput;
    super(`[${code}] ${message}`);
    this.name = "NotionToolError";
    this.code = code;
    this.detail = message;
    this.details = options.details ?? {};
  }
}

/**
 * Per-tool wall-clock budgets.
 *
 * Every individual `ntn` spawn already has its own `timeoutMs` (plugin config,
 * 60 s by default), so these bound the WORK AROUND those spawns: `notion_query`
 * with `include_content` runs up to 100 sequential `pages get` calls, and
 * `notion_get` reads one schema per data source. `notion_page` additionally
 * walks parent chains and block children.
 */
export const TOOL_TIMEOUTS = {
  search: 120_000,
  get: 120_000,
  page: 180_000,
  query: 300_000,
} as const;

export type NotionTool<Value = JsonObject> = {
  name: string;
  description: string;
  parameters: JsonObject;
  output: {
    schema: JsonObject;
    render: (args: JsonObject, value: Value) => TextBlock[];
  };
  /**
   * Wall-clock budget for one whole call, in milliseconds. Declarative: the
   * registry records it and `@deepseek-ai/dsh-tool-call-timeout-policy` (part of
   * the `dsh` base bundle) turns it into a real deadline by aborting
   * `exec.signal`, which kills the running `ntn` child. When it fires the model
   * receives `TOOL_TIMEOUT` instead of waiting forever.
   */
  timeoutMs?: number;
  /**
   * Whether two calls with these arguments may run at the same time. Only an
   * exact `true` is scheduled in parallel; everything else stays exclusive.
   * Read-only tools answer `true`; a tool that can write answers `false`.
   */
  isConcurrencySafe?: (args: JsonObject) => boolean;
  execute: (args: JsonObject, exec: ToolExecution) => Promise<Value>;
};

/** Identity helper: keeps each tool file's definition checked against one contract. */
export function defineNotionTool<Value>(tool: NotionTool<Value>): NotionTool<Value> {
  return tool;
}

/** Single-text-block renderer for the common "one human-readable summary" output. */
export function textBlocks(text: string): TextBlock[] {
  return [{ type: "text", text }];
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/** An argument the caller can fix: `[INVALID_INPUT]` with optional structured details. */
export function inputError(message: string, details?: JsonObject): NotionToolError {
  return new NotionToolError(message, {
    code: NOTION_ERROR_CODES.invalidInput,
    ...(details ? { details } : {}),
  });
}

/**
 * Wrap an uncaught body error so it reaches the model with a code.
 *
 * Argument validation throws {@link inputError} at the point of validation, so
 * anything still uncoded here is an `ntn` failure or an unparseable response —
 * blaming the caller for it would send the model looking at its own arguments.
 */
export function codedError(error: unknown): NotionToolError {
  if (error instanceof NotionToolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NotionToolError(message, { code: NOTION_ERROR_CODES.ntnFailed });
}

/**
 * Caller cancellation as a tool error, for the point before anything is spawned.
 * The registry replaces a successful outcome with `ABORTED` on its own; this makes
 * a body that stopped early say why instead of returning a partial value.
 */
export function abortError(): NotionToolError {
  return new NotionToolError("tool call aborted", { code: NOTION_ERROR_CODES.aborted });
}

/* ------------------------------------------------------------------ *
 * Cancellation plumbing
 * ------------------------------------------------------------------ */

/**
 * Bind a tool call's cancellation signal to every `ntn` spawn of that call.
 *
 * The DSH registry aborts `exec.signal` on cancellation and on the configured
 * timeout; without this the child process would outlive the call.
 */
export function bindSignal<O extends { signal?: AbortSignal }, R>(
  run: (options: O) => Promise<R>,
  signal: AbortSignal | undefined
): (options: O) => Promise<R> {
  if (!signal) return run;
  return async (options) => {
    if (signal.aborted) throw abortError();
    const result = await run({ ...options, signal });
    // A killed child reports a null exit code, which the failure formatters would
    // describe as "timed out or could not start"; say "aborted" instead.
    if (signal.aborted) throw abortError();
    return result;
  };
}

/* ------------------------------------------------------------------ *
 * Tolerant argument reading
 *
 * The model is not required to remember this plugin's exact spellings. Each
 * helper below accepts the shapes a caller plausibly produces for one value and
 * normalizes it, so a merely different phrasing still does the intended thing.
 * Nothing here guesses at INTENT: a synonym maps to the action it names, and an
 * unrecognized word (a typo, a different word) is rejected rather than snapped
 * to the nearest match — correcting a typo could perform a different write than
 * the caller asked for.
 * ------------------------------------------------------------------ */

/** One spelling a caller may use for a known enumerated value. */
type Spelling<T extends string> = { value: T; aliases: readonly string[] };

/**
 * Resolve an enumerated value from its accepted spellings.
 *
 * Matching is exact after case/`-`/`_`/space folding: `"Delete"`, `"delete"` and
 * `"delete "` all reach `trash` through its alias list, while an unknown word is
 * reported with the accepted list. Typos are NOT fuzzy-matched.
 */
export function readEnum<T extends string>(
  raw: unknown,
  field: string,
  spellings: readonly Spelling<T>[]
): T {
  if (typeof raw !== "string") {
    throw inputError(
      `${field} must be a string, got ${describe(raw)}. Accepted: ${spellingList(spellings)}.`,
      { field, value: raw }
    );
  }
  const folded = fold(raw);
  for (const spelling of spellings) {
    if (fold(spelling.value) === folded) return spelling.value;
    if (spelling.aliases.some((alias) => fold(alias) === folded)) return spelling.value;
  }
  throw inputError(
    `${field} "${raw}" is not recognized. Accepted: ${spellingList(spellings)}.`,
    { field, value: raw }
  );
}

function spellingList<T extends string>(spellings: readonly Spelling<T>[]): string {
  return spellings
    .map((spelling) => {
      // Drop an alias that merely repeats the value: `md (also "md")` is noise.
      const aliases = spelling.aliases.filter((alias) => fold(alias) !== fold(spelling.value));
      return aliases.length === 0
        ? spelling.value
        : `${spelling.value} (also ${aliases.map((alias) => `"${alias}"`).join(", ")})`;
    })
    .join(" | ");
}

/** Case-, space-, `-`/`_`-insensitive comparison key. */
function fold(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** A value the caller may send as a number or as a numeric string. */
export function readInteger(raw: unknown, field: string, min: number, max?: number): number {
  let value: number;
  if (typeof raw === "number" && Number.isFinite(raw)) value = Math.trunc(raw);
  else if (typeof raw === "string" && /^\s*-?\d+\s*$/.test(raw)) value = Number(raw.trim());
  else {
    throw inputError(
      `${field} must be an integer${max === undefined ? "" : ` between ${min} and ${max}`}, got ${describe(raw)}.`,
      { field, value: raw }
    );
  }
  if (value < min) {
    throw inputError(`${field} must be >= ${min}, got ${value}.`, { field, value: raw });
  }
  // Clamp rather than reject: asking for more results than the API serves is a
  // reasonable request, and the returned limit says what actually applied.
  if (max !== undefined && value > max) return max;
  return value;
}

/**
 * A boolean the caller may send as `true`/`false`, `"true"`/`"false"`,
 * `"yes"`/`"no"`, `1`/`0`, or `"1"`/`"0"`.
 */
export function readBoolean(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number" && (raw === 1 || raw === 0)) return raw === 1;
  if (typeof raw === "string") {
    const folded = fold(raw);
    if (folded === "true" || folded === "yes" || folded === "1") return true;
    if (folded === "false" || folded === "no" || folded === "0") return false;
  }
  throw inputError(`field ${field} must be a boolean, got ${describe(raw)}.`, {
    field,
    value: raw,
  });
}

/** A non-empty string argument. */
export function readString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw inputError(`${field} must be a non-empty string, got ${describe(raw)}.`, {
      field,
      value: raw,
    });
  }
  return raw.trim();
}

/** Short, safe rendering of a caller-supplied value for an error message. */
export function describe(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return (text ?? String(value)).slice(0, 80);
  } catch {
    return String(value);
  }
}
