/**
 * notion_query — query rows in a known Notion data source (or database).
 *
 * Backend is always `ntn datasources query … --json` spawned through runNtn. This tool is
 * deliberately NOT workspace keyword search: that is notion_search.
 *
 * A database can hold multiple data sources. `ntn datasources query` auto-resolves a database with
 * exactly one data source and exits with an explicit multi-source error otherwise (verified against
 * ntn 0.23.25), so a failed query is followed by `datasources resolve`: one id → retry by id,
 * several → fail with the id list the caller must choose from. This keeps the common path to one
 * ntn call and never silently picks a data source.
 *
 * `under` (1.1) is the one schema-aware path: it reads the data source schema, picks the
 * Parent-item column with the shared `selectParentItemProperty` selector, and turns the parent
 * row id into `{ property, relation: { contains } }`. That filter is ANDed with the caller's
 * filter; a caller filter that already targets the same relation column is refused rather than
 * silently rewritten.
 */
import {
  abortError,
  bindSignal,
  codedError,
  defineNotionTool,
  inputError,
  NOTION_ERROR_CODES,
  NotionToolError,
  readBoolean,
  readInteger,
  readString,
  describe,
  textBlocks,
  TOOL_TIMEOUTS,
} from "../dsh/tool.ts";
import type { NotionTool } from "../dsh/tool.ts";
import { TOOL_DESCRIPTIONS } from "../text/tools.ts";
import { parseResolveDataSources } from "../lib/datasources.ts";
import { describeFailure } from "../lib/failures.ts";
import type { ResolvedDataSource } from "../lib/datasources.ts";
import { extractNotionId } from "../lib/ids.ts";
import {
  isWritablePropertyType,
  sameNotionId,
  selectParentItemProperty,
} from "../lib/properties.ts";
import { parseJsonStdout, runNtn, type RunNtnResult } from "../lib/runNtn.ts";
import { extractSchemaProperties, reportedDataSourceId } from "../lib/schema.ts";
import type { SchemaProperty } from "../lib/schema.ts";

// Re-exported for callers/tests that used to import it from this module.
export { parseResolveDataSources };
export type { ResolvedDataSource };

export const DEFAULT_QUERY_LIMIT = 25;
export const MAX_QUERY_LIMIT = 100;

/** Injectable for unit tests; production always uses runNtn. */
export type RunNtnFn = (options: Parameters<typeof runNtn>[0]) => Promise<RunNtnResult>;

export type NotionQueryParams = {
  database_or_data_source: string;
  limit?: number;
  start_cursor?: string | null;
  filter?: Record<string, unknown>;
  sort?: string | string[];
  include_content?: boolean;
  /**
   * Parent row id/URL: only rows linked to that parent through the data source's
   * Parent-item / self-relation column. Translated into a relation filter here, so
   * callers do not have to know the column name.
   */
  under?: string;
};

export type QueryRow = {
  id: string;
  url: string | null;
  properties: Record<string, unknown>;
  /** Only present when include_content is true and `ntn pages get` succeeded. */
  markdown?: string;
  /** Only present when include_content is true and `ntn pages get` failed. */
  markdown_error?: string;
};

export type QueryResult = {
  results: QueryRow[];
  next_cursor: string | null;
  has_more: boolean;
  /**
   * The page size actually requested from Notion after clamping. Echoed so a
   * caller that asked for more than the maximum can see what it really got.
   */
  limit?: number;
};

export type NotionQueryDeps = {
  runNtn?: RunNtnFn;
};

/** Input problem the model can fix: reported with structured `details`, not a stack trace. */
export class QueryInputError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "QueryInputError";
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Delegate to src/lib/failures.ts so a given underlying failure reads the same whichever
 * tool hit it. That module attaches a hint only when the text identifies the cause, so an
 * unrecognised failure stays exactly as ntn worded it instead of getting a guess.
 */
function summarizeFailure(result: RunNtnResult, action: string): string {
  return describeFailure(result, `${action} failed`);
}

/**
 * Default 25; values above 100 are clamped (Notion hard limit), values <= 0 are rejected.
 * The schema already enforces minimum 1, but execute() is also reachable directly (tests,
 * programmatic callers), so keep the check here as well.
 */
/**
 * The tool's own limit reading. A fractional or numeric-string count is a harmless
 * phrasing difference, so it is truncated rather than rejected.
 * `<= 0` stays an error because no intended page size produces it.
 */
function readQueryLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_QUERY_LIMIT;
  const value = readInteger(raw, "limit", 1, MAX_QUERY_LIMIT);
  return value;
}

/** `sort` accepts one "Prop asc|desc" spec or an ordered list of specs; order matters to Notion. */
export function normalizeSort(sort?: string | string[]): string[] {
  if (sort === undefined) return [];
  const raw = Array.isArray(sort) ? sort : [sort];
  const specs: string[] = [];
  for (const item of raw) {
    // Guard the element type: a non-string entry would surface as
    // "item.trim is not a function", which says nothing the caller can act on.
    if (typeof item !== "string") {
      throw inputError(
        `sort entries must be "Property asc|desc" strings, got ${describe(item)}.`,
        { sort: item }
      );
    }
    const spec = item.trim();
    if (!spec) {
      throw inputError('sort entries must be non-empty "Property asc|desc" strings.');
    }
    specs.push(spec);
  }
  return specs;
}

function buildQueryArgs(
  target: string,
  options: {
    limit: number;
    startCursor?: string;
    filter?: Record<string, unknown>;
    sorts: string[];
  }
): string[] {
  const args = ["datasources", "query", target, "--limit", String(options.limit), "--json"];
  if (options.startCursor) args.push("--start-cursor", options.startCursor);
  if (options.filter !== undefined) args.push("--filter", JSON.stringify(options.filter));
  for (const spec of options.sorts) args.push("--sort", spec);
  return args;
}

function normalizeRow(row: unknown, index: number): QueryRow {
  if (!isRecord(row)) {
    throw new Error(`ntn datasources query returned result #${index + 1} that is not an object.`);
  }
  if (typeof row.id !== "string" || !row.id) {
    throw new Error(`ntn datasources query returned result #${index + 1} without an id.`);
  }
  return {
    id: row.id,
    url: typeof row.url === "string" ? row.url : null,
    properties: isRecord(row.properties) ? row.properties : {},
  };
}

/** Accept the Notion list shape, plus a bare results array as a defensive fallback. */
export function parseQueryResponse(raw: unknown, target: string): QueryResult {
  const payload = Array.isArray(raw)
    ? { results: raw, next_cursor: null, has_more: false }
    : isRecord(raw)
      ? raw
      : null;
  if (!payload) {
    throw new Error(`ntn datasources query returned no JSON object for ${target}.`);
  }
  if (!Array.isArray(payload.results)) {
    throw new Error(`ntn datasources query response for ${target} has no results array.`);
  }
  const nextCursor =
    typeof payload.next_cursor === "string" && payload.next_cursor ? payload.next_cursor : null;
  return {
    results: payload.results.map(normalizeRow),
    next_cursor: nextCursor,
    // Trust a cursor even if a CLI version omits has_more: silent truncation is worse than one
    // extra call. Notion itself sets next_cursor to null when has_more is false.
    has_more: payload.has_more === true || nextCursor !== null,
  };
}

function describeDataSources(target: string, dataSources: ResolvedDataSource[]): string {
  const lines = dataSources.map((ds) => `- ${ds.id}${ds.name ? ` (${ds.name})` : ""}`);
  return (
    `Database ${target} has ${dataSources.length} data sources. ` +
    "Pass one of these data source IDs as database_or_data_source:\n" +
    lines.join("\n")
  );
}

async function resolveDataSources(target: string, runner: RunNtnFn): Promise<ResolvedDataSource[]> {
  const resolved = await runner({ args: ["datasources", "resolve", target, "--json"] });
  if (!resolved.ok) return [];
  try {
    return parseResolveDataSources(parseJsonStdout(resolved.stdout));
  } catch {
    // The original query failure is the useful diagnostic here; do not mask it with a parse error.
    return [];
  }
}

/** Property schema of one data source (`GET v1/data_sources/{id}`); undefined when unreadable. */
async function fetchDataSourceSchema(
  runner: RunNtnFn,
  dataSourceId: string
): Promise<{ dataSourceId: string; properties: Map<string, SchemaProperty> } | undefined> {
  const result = await runner({ args: ["api", `v1/data_sources/${dataSourceId}`] });
  if (!result.ok) return undefined;
  let parsed: unknown;
  try {
    parsed = parseJsonStdout(result.stdout);
  } catch {
    return undefined;
  }
  const properties = extractSchemaProperties(parsed);
  if (!properties) return undefined;
  return { dataSourceId: reportedDataSourceId(parsed, dataSourceId), properties };
}

/**
 * Schema for whatever the caller queried: a data source id loads directly, a database id
 * goes through `datasources resolve` (one → use it, several → refuse and list them).
 */
async function schemaForTarget(
  target: string,
  runner: RunNtnFn
): Promise<{ dataSourceId: string; properties: Map<string, SchemaProperty> }> {
  // Only a parsed Notion id may enter an API path; anything else goes to `datasources resolve`
  // as argv (never interpolated into `v1/data_sources/<target>`).
  const candidate = extractNotionId(target);
  if (candidate) {
    const direct = await fetchDataSourceSchema(runner, candidate);
    if (direct) return direct;
  }

  const resolved = await resolveDataSources(candidate ?? target, runner);
  if (resolved.length > 1) {
    throw new QueryInputError(describeDataSources(target, resolved), {
      target,
      data_source_ids: resolved.map((dataSource) => dataSource.id),
    });
  }
  if (resolved.length === 0) {
    throw new QueryInputError(
      `无法读取 ${target} 的属性 schema（无法直接读取 data source，datasources resolve 也失败）。` +
        "under 需要 data source schema 才能找到 Parent-item 列：请传 data source id，或确认 Integration 已被邀请。",
      { target }
    );
  }
  // Do not repeat an identical read that just failed (a database id that resolve merely echoes).
  const schema =
    !candidate || !sameNotionId(resolved[0].id, candidate)
      ? await fetchDataSourceSchema(runner, resolved[0].id)
      : undefined;
  if (!schema) {
    throw new QueryInputError(
      `无法从 data source ${resolved[0].id} 读取属性列表（GET v1/data_sources/${resolved[0].id} 失败）。` +
        "under 需要该 schema 才能找到 Parent-item 列；请确认 id 正确、Integration 已被邀请。",
      { target, dataSourceId: resolved[0].id }
    );
  }
  return schema;
}

/** All property names a raw Notion filter references, including nested and/or filters. */
function collectFilterProperties(filter: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(filter)) {
    for (const item of filter) collectFilterProperties(item, out);
    return out;
  }
  if (!isRecord(filter)) return out;
  if (typeof filter.property === "string") out.add(filter.property);
  for (const key of ["and", "or"] as const) {
    if (filter[key] !== undefined) collectFilterProperties(filter[key], out);
  }
  return out;
}

/**
 * Turn `under` into a relation filter on the data source's Parent-item column, merging the
 * caller's filter with `and`. Refuses instead of guessing when:
 *   - no Parent-item / self-relation column can be identified
 *   - the caller already filters that same column (two relation predicates on one column
 *     cannot be merged without changing meaning)
 */
async function filterUnder(
  params: NotionQueryParams,
  target: string,
  runner: RunNtnFn
): Promise<Record<string, unknown>> {
  const raw = params.under;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new QueryInputError("under 必须是父行 id 或 Notion URL（非空字符串）。", { under: raw });
  }
  const underId = extractNotionId(raw);
  if (!underId) {
    throw new QueryInputError(
      `under 里没有可识别的 Notion 行 id：${JSON.stringify(raw)}。` +
        "请传父行 id（32 位 hex 或 UUID）或其 Notion URL。",
      { under: raw }
    );
  }

  const schema = await schemaForTarget(target, runner);
  const property = selectParentItemProperty(schema.properties.values(), schema.dataSourceId);
  if (!property) {
    const hints = [...schema.properties.values()]
      .filter((entry) => isWritablePropertyType(entry.type))
      .map((entry) => ({ name: entry.name, type: entry.type }));
    const relations = [...schema.properties.values()]
      .filter((entry) => entry.type === "relation")
      .map((entry) => entry.name);
    throw new QueryInputError(
      `data source ${schema.dataSourceId} 没有可用的 Parent-item / 自关联 relation 列，无法用 under 筛子行` +
        `（${relations.length ? `现有 relation 列：${relations.join(", ")}` : "该 data source 没有任何 relation 列"}）。` +
        "请改用 filter 显式过滤，或先为该库加一个指向自身的 relation 属性。" +
        // DSH keeps only the message, so the writable columns must be listed here.
        `可写属性：${hints.length ? hints.map((h) => `${h.name} (${h.type})`).join(", ") : "(none)"}。`,
      {
        target,
        dataSourceId: schema.dataSourceId,
        hint_properties: hints,
        relation_properties: relations,
      }
    );
  }

  const underFilter = { property: property.name, relation: { contains: underId } };
  const callerFilter = params.filter;
  // `{}` means "no filter" to a model; Notion would reject it as an `and` operand.
  if (callerFilter === undefined || Object.keys(callerFilter).length === 0) {
    return underFilter;
  }

  const referenced = collectFilterProperties(callerFilter);
  if (referenced.has(property.name)) {
    throw new QueryInputError(
      `filter 已经在过滤 ${property.name} 列，而 under 也要用它筛父行 ${underId}：两个 relation 条件不能自动合并。` +
        "请只用 under（去掉 filter 里那一条），或不用 under、自己写完整的 relation filter。",
      {
        target,
        dataSourceId: schema.dataSourceId,
        parent_item_property: property.name,
        under_id: underId,
        conflicting_property: property.name,
      }
    );
  }

  return { and: [underFilter, callerFilter] };
}

async function attachMarkdown(rows: QueryRow[], runner: RunNtnFn): Promise<void> {
  // Sequential on purpose: up to 100 rows means up to 100 ntn processes, and Notion rate limits
  // are per integration. include_content defaults to false, so this path is opt-in.
  for (const row of rows) {
    const page = await runner({ args: ["pages", "get", row.id] });
    if (page.ok) {
      row.markdown = page.stdout;
    } else {
      row.markdown_error = summarizeFailure(page, `ntn pages get ${row.id}`);
    }
  }
}

/**
 * Core query implementation, separated from tool registration so tests can inject a fake runNtn.
 */
export async function queryDataSource(
  params: NotionQueryParams,
  runner: RunNtnFn = runNtn
): Promise<QueryResult> {
  // Guard the raw values before touching them: the schema does not enforce types
  // (the DSH registry never validates arguments), so `params.x.trim()` on a
  // number would surface as "trim is not a function" instead of a fixable error.
  const rawTarget = (params as { database_or_data_source?: unknown }).database_or_data_source;
  const target =
    rawTarget === undefined || rawTarget === null || rawTarget === ""
      ? ""
      : readString(rawTarget, "database_or_data_source");
  if (!target) {
    throw new QueryInputError(
      "database_or_data_source 必须是 data source / database 的 id 或 URL（非空），" +
        "不知道 id 时先用 notion_search 按标题找到它。"
    );
  }

  const rawCursor = (params as { start_cursor?: unknown }).start_cursor;
  const rawInclude = (params as { include_content?: unknown }).include_content;
  const includeContent =
    rawInclude === undefined ? false : readBoolean(rawInclude, "include_content");
  const limit = readQueryLimit((params as { limit?: unknown }).limit);
  const sorts = normalizeSort((params as { sort?: unknown }).sort as string | string[] | undefined);
  const startCursor =
    rawCursor === undefined ||
    rawCursor === null ||
    (typeof rawCursor === "string" && rawCursor.trim() === "")
      ? undefined
      : readString(rawCursor, "start_cursor");
  const callerFilter = params.filter;
  if (callerFilter !== undefined && !isRecord(callerFilter)) {
    throw new QueryInputError("filter must be a Notion filter JSON object.");
  }
  // `under` resolves the data source schema first, then becomes a relation filter.
  const underFilter =
    params.under === undefined ? undefined : await filterUnder(params, target, runner);
  const filter = underFilter ?? callerFilter;

  const options = { limit, startCursor, filter, sorts };
  let query = await runner({ args: buildQueryArgs(target, options) });

  if (!query.ok) {
    // A database with one data source normally resolves inside `datasources query`; if that
    // failed, resolve explicitly. One data source → retry by id. Several → make the caller pick.
    const resolved = await resolveDataSources(target, runner);
    if (resolved.length > 1) {
      // Picking one of several data sources is the caller's decision, so this is
      // an input error, not an ntn failure; the ids go in details for the caller.
      throw new QueryInputError(describeDataSources(target, resolved), {
        target,
        data_source_ids: resolved.map((dataSource) => dataSource.id),
      });
    }
    if (resolved.length === 1 && resolved[0].id !== target) {
      const retry = await runner({ args: buildQueryArgs(resolved[0].id, options) });
      if (retry.ok) {
        query = retry;
      } else {
        throw new Error(
          `${summarizeFailure(query, `ntn datasources query ${target}`)}; ` +
            `retry with data source ${resolved[0].id} also failed: ${summarizeFailure(
              retry,
              "ntn datasources query"
            )}`
        );
      }
    } else {
      // No resolution, or the input already was that data source: never repeat an identical call.
      throw new Error(summarizeFailure(query, `ntn datasources query ${target}`));
    }
  }

  let result: QueryResult;
  try {
    result = parseQueryResponse(parseJsonStdout(query.stdout), target);
  } catch (error) {
    throw new Error(
      `Could not parse ntn datasources query output for ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // Echo the page size that actually applied: a clamped request is otherwise
  // invisible, and the caller has no way to know it did not get what it asked for.
  result = { ...result, limit };

  if (includeContent) {
    await attachMarkdown(result.results, runner);
  }
  return result;
}

const QUERY_PARAMETERS = {
  type: "object",
  properties: {
    database_or_data_source: {
      // No `minLength`: DSH's enforced schema subset rejects it, and the PTC SDK
      // then degrades this whole tool's argument type to `unknown`. The empty case
      // is guarded at execution instead.
      type: "string",
      description:
        "Notion data source id, database id, or Notion URL. If the database has multiple data sources, pass one data source id explicitly.",
    },
    limit: {
      type: "integer",
      description: `Max rows per page (default ${DEFAULT_QUERY_LIMIT}, clamped to ${MAX_QUERY_LIMIT}).`,
    },
    start_cursor: {
      oneOf: [{ type: "string" }, { type: "null" }],
      description:
        "Pagination cursor from a previous response's next_cursor. Omit for the first page.",
    },
    filter: {
      type: "object",
      additionalProperties: true,
      description: "Raw Notion filter JSON object, passed through verbatim.",
    },
    under: {
      type: "string",
      description:
        "Only rows linked to this parent row (id or Notion URL), filtered through the data source's Parent-item / self-relation column. Combined with filter via AND; refuses when filter already targets that same relation column.",
    },
    sort: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      description: 'Sort spec "Property asc|desc", or an ordered array of specs for multiple sorts.',
    },
    include_content: {
      type: "boolean",
      description:
        "Also fetch each row's Markdown with ntn pages get (default false; one extra call per row).",
    },
  },
  required: ["database_or_data_source"],
  additionalProperties: false,
} as const;

const QUERY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          url: { oneOf: [{ type: "string" }, { type: "null" }] },
          properties: { type: "object", additionalProperties: true },
          markdown: { type: "string" },
          markdown_error: { type: "string" },
        },
        required: ["id", "url", "properties"],
        additionalProperties: false,
      },
    },
    next_cursor: { oneOf: [{ type: "string" }, { type: "null" }] },
    has_more: { type: "boolean" },
    limit: { type: "integer" },
  },
  required: ["results", "next_cursor", "has_more"],
  additionalProperties: false,
} as const;

/** Model-facing text: the query payload as JSON, which is what callers page through. */
function renderQueryResult(result: QueryResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Build the `notion_query` tool definition.
 * `deps` exists for tests: injecting a fake runner replaces `runNtn`.
 */
export function createNotionQueryTool(deps: NotionQueryDeps = {}): NotionTool<QueryResult> {
  const runner = deps.runNtn ?? runNtn;

  return defineNotionTool<QueryResult>({
    name: "notion_query",
    description: TOOL_DESCRIPTIONS.query,
    timeoutMs: TOOL_TIMEOUTS.query,
    // Read-only: safe to run alongside sibling calls.
    isConcurrencySafe: () => true,
    parameters: QUERY_PARAMETERS as unknown as Record<string, unknown>,
    output: {
      schema: QUERY_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      render: (_args, value) => textBlocks(renderQueryResult(value)),
    },

    async execute(args, exec) {
      try {
        if (exec.signal?.aborted) throw abortError();
        return await queryDataSource(
          args as unknown as NotionQueryParams,
          bindSignal(runner, exec.signal)
        );
      } catch (error) {
        if (error instanceof QueryInputError) {
          throw new NotionToolError(error.message, {
            code: NOTION_ERROR_CODES.invalidInput,
            details: error.details,
          });
        }
        // Everything else (a failed `ntn datasources query`, an unparseable response)
        // must still reach the model with a code; without this it arrives bare.
        throw codedError(error);
      }
    },
  });
}
