/**
 * The tool contract this plugin registers into DSH's `ctx.tools`.
 *
 * A DSH tool is four things the registry owns end to end:
 *   - `name`, `description`, `parameters`: what the model sees and what its call is
 *     validated against (the enforced JSON Schema subset: type / oneOf / properties /
 *     required / additionalProperties / items / enum / const, plus annotations);
 *   - `output.value`: the canonical JSON result of a successful call, validated
 *     against `output.schema` before anything is shown;
 *   - `output.render`: the model-facing text blocks derived from that value;
 *   - `execute`: the body. It returns the canonical value, and a thrown error becomes
 *     the call's error result.
 *
 * Nothing here is presentation-specific: the same definition drives native function
 * calling and the generated PTC SDK.
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

/**
 * Per-tool wall-clock budgets.
 *
 * Every individual `ntn` spawn already has its own `timeoutMs` (plugin config,
 * 60 s by default), so these bound the WORK AROUND those spawns: `notion_query`
 * with `include_content` runs up to 100 sequential `pages get` calls, and
 * `notion_get` reads one schema per data source. `notion_page` additionally walks
 * parent chains for its cycle checks.
 */
export const TOOL_TIMEOUTS = {
  search: 120_000,
  get: 120_000,
  page: 180_000,
  query: 300_000,
} as const;

/** Identity helper: keeps each tool file's definition checked against one contract. */
export function defineNotionTool<Value>(tool: NotionTool<Value>): NotionTool<Value> {
  return tool;
}

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

/**
 * Caller cancellation as a tool error, for the point before anything is spawned.
 * The registry replaces a successful outcome with `ABORTED` on its own; this makes
 * a body that stopped early say why instead of returning a partial value.
 */
export function abortError(): NotionToolError {
  return new NotionToolError("tool call aborted", { code: NOTION_ERROR_CODES.aborted });
}

/**
 * Ensure a thrown value reaches the model with a `[CODE]` prefix.
 *
 * The tool bodies predate error codes and throw plain `Error`s both for bad
 * arguments and for failed `ntn` calls. DSH forwards only `message`, so this
 * wrapper is what keeps a bare `Error` from arriving as an unexplained
 * sentence. An already-coded error passes through untouched.
 *
 * Argument validation throws {@link NotionToolError} with `INVALID_INPUT` at
 * the point of validation, so anything still uncoded by the time it reaches
 * here is an `ntn` failure or an unparseable response.
 */
export function codedError(error: unknown): Error {
  if (error instanceof NotionToolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NotionToolError(message, { code: NOTION_ERROR_CODES.ntnFailed });
}

/** An argument the caller can fix: `[INVALID_INPUT]` with optional structured details. */
export function inputError(message: string, details?: JsonObject): NotionToolError {
  return new NotionToolError(message, {
    code: NOTION_ERROR_CODES.invalidInput,
    ...(details ? { details } : {}),
  });
}


/** Single-text-block renderer for the common "one human-readable summary" output. */
export function textBlocks(text: string): TextBlock[] {
  return [{ type: "text", text }];
}

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
 * (which forwards only the message text), while `detail` keeps the unprefixed
 * prose and `details` keeps the structured payload for tests and logs.
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
