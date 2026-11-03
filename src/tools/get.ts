/**
 * notion_get — read one page as Markdown, or inspect a database's schema.
 *
 * Backed by the official `ntn` CLI only (never a free-form shell):
 *   ntn pages get <id> [--json]                 page body (+ metadata for --json)
 *   ntn datasources resolve <database-id> --json  data source ids (a database may have several)
 *   ntn api v1/databases/<id>                    database title/url (best effort)
 *   ntn api v1/data_sources/<id>                 property schema for each data source
 *
 * Deliberately **never** queries rows: that is `notion_query`'s job. This tool stays O(schema).
 *
 * `ntn` itself does not accept Notion URLs (verified with 0.23.25: the URL is forwarded verbatim
 * and the API 404s), so the URL → id extraction happens in `src/lib/ids.ts`.
 *
 * Type detection: try page first, then database. A page 404 is what a database id looks like to
 * `ntn pages get`; only non-recoverable errors (auth/config, timeouts, 5xx/429) skip the fallback.
 */

import {
  abortError,
  bindSignal,
  codedError,
  defineNotionTool,
  inputError,
  readEnum,
  readString,
  textBlocks,
  TOOL_TIMEOUTS,
} from "../dsh/tool.ts";
import type { NotionTool } from "../dsh/tool.ts";
import { GET_RESULT_TEXT } from "../text/results.ts";
import { GET_ERRORS } from "../text/errors.ts";
import { GET_PARAMS } from "../text/params.ts";
import { TOOL_DESCRIPTIONS } from "../text/tools.ts";
import { describeFailure, failureHint } from "../lib/failures.ts";
import { extractNotionId } from "../lib/ids.ts";
import {
  isWritablePropertyType,
  sameNotionId,
  selectParentItemProperty,
} from "../lib/properties.ts";
import { parseJsonStdout, runNtn } from "../lib/runNtn.ts";
import type { RunNtnOptions, RunNtnResult } from "../lib/runNtn.ts";

export type NtnRunner = (options: RunNtnOptions) => Promise<RunNtnResult>;

export type NotionGetParams = {
  id_or_url: string;
  format?: "md" | "json";
};

export type PropertyInfo = {
  name: string;
  type: string;
  /** False for formula/rollup/created_time/… (Notion rejects integration writes). */
  writable: boolean;
  /** Set for relation columns that report their target data source. */
  relation_data_source_id?: string;
  /** True when the relation points at the data source that owns it. */
  self_relation?: boolean;
  /** Heuristic: the column notion_page_edit's parent / child-row create would write. */
  parent_item_candidate?: boolean;
};

export type DataSourceInfo = {
  id: string;
  name?: string;
  properties: PropertyInfo[];
  /** Present when the schema call failed; the id is still returned so the model can query it. */
  error?: string;
};

export type NotionPageResult = {
  type: "page";
  id: string;
  url?: string;
  title?: string;
  format: "md" | "json";
  markdown: string;
  /** Raw property values from the page object (json format only; md carries them as frontmatter). */
  properties?: Record<string, unknown>;
  truncated?: boolean;
  unknown_block_ids?: string[];
};

export type NotionDatabaseResult = {
  type: "database";
  id: string;
  title?: string;
  url?: string;
  /** Always every data source in the database, so multi-source databases are not silently halved. */
  data_source_ids: string[];
  /** Union of the per-data-source schemas (deduped by name+type). */
  properties: PropertyInfo[];
  /** Per-data-source breakdown (names + own schema). */
  data_sources: DataSourceInfo[];
  /** Data source ids whose schema has a Parent-item / self-relation candidate. */
  parent_item_candidates?: { data_source_id: string; property: string }[];
  warnings?: string[];
};

export type NotionGetResult = NotionPageResult | NotionDatabaseResult;

/** Force plain text: ANSI/hyperlink escapes would leak into Markdown and JSON parsing. */
const NTN_ENV = { NO_COLOR: "1", NO_HYPERLINK: "1" };

/** Configuration/authentication failures that a database retry cannot fix. */
const AUTH_ERROR_RE = /no workspace selected|ntn login|notion_api_token|\(401 |unauthorized/i;

/** `ntn pages get` writes this exact warning to stderr when it truncated the body. */
const TRUNCATION_WARNING_RE = /page content (?:was|is) truncated|content was truncated/i;

/** Transient upstream failures: retrying the same id as a database would just fail again. */
const TRANSIENT_ERROR_RE =
  /\b(429|500|502|503|504|529)\b|rate_limited|internal_server_error|service_unavailable|gateway_timeout|service_overload|timed out/i;

type Attempt<T> = { ok: true; value: T } | { ok: false; res: RunNtnResult };

/** The model-facing parameters, in the enforced DSH JSON Schema subset. */
const GET_PARAMETERS = {
  type: "object",
  properties: {
    id_or_url: {
      type: "string",
      description: GET_PARAMS.id_or_url,
    },
    format: {
      type: "string",
      enum: ["md", "json"],
      description: GET_PARAMS.format,
    },
  },
  required: ["id_or_url"],
  additionalProperties: false,
} as const;

/** Canonical-value schema: a tagged union of the page and database payloads. */
const GET_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        type: { type: "string", const: "page" },
        id: { type: "string" },
        url: { type: "string" },
        title: { type: "string" },
        format: { type: "string", enum: ["md", "json"] },
        markdown: { type: "string" },
        properties: { type: "object", additionalProperties: true },
        truncated: { type: "boolean" },
        unknown_block_ids: { type: "array", items: { type: "string" } },
      },
      required: ["type", "id", "format", "markdown"],
      additionalProperties: true,
    },
    {
      type: "object",
      properties: {
        type: { type: "string", const: "database" },
        id: { type: "string" },
        title: { type: "string" },
        url: { type: "string" },
        data_source_ids: { type: "array", items: { type: "string" } },
        properties: { type: "array", items: { type: "object", additionalProperties: true } },
        data_sources: { type: "array", items: { type: "object", additionalProperties: true } },
        parent_item_candidates: { type: "array", items: { type: "object", additionalProperties: true } },
        warnings: { type: "array", items: { type: "string" } },
      },
      required: ["type", "id", "data_source_ids", "properties", "data_sources"],
      additionalProperties: true,
    },
  ],
} as const;

/** Model-facing text for a canonical page/database value. */
export function renderGetResult(value: NotionGetResult): string {
  return value.type === "database" ? renderDatabaseText(value) : renderPageText(value);
}

/**
 * Build the `notion_get` tool definition.
 * `run` exists for tests: injecting a fake runner replaces `runNtn`.
 */
export function createNotionGetTool(run: NtnRunner = runNtn): NotionTool<NotionGetResult> {
  return defineNotionTool<NotionGetResult>({
    name: "notion_get",
    description: TOOL_DESCRIPTIONS.get,
    timeoutMs: TOOL_TIMEOUTS.get,
    // Read-only: safe to run alongside sibling calls.
    isConcurrencySafe: () => true,
    parameters: GET_PARAMETERS as unknown as Record<string, unknown>,
    output: {
      schema: GET_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      render: (_args, value) => textBlocks(renderGetResult(value)),
    },

    async execute(args, exec) {
      try {
        if (exec.signal?.aborted) throw abortError();
        return await executeNotionGet(
          args as unknown as NotionGetParams,
          bindSignal(run, exec.signal)
        );
      } catch (error) {
        throw codedError(error);
      }
    },
  });
}

/**
 * Tool body, exported so tests can inject a fake `ntn` runner instead of spawning processes.
 */
export async function executeNotionGet(
  params: NotionGetParams,
  run: NtnRunner = runNtn
): Promise<NotionGetResult> {
  // Guard the arguments here rather than trusting the schema: the DSH registry
  // does not validate tool arguments, and an unguarded `undefined` would surface
  // as "Cannot read properties of undefined" instead of a fixable message.
  const raw = readString((params as { id_or_url?: unknown }).id_or_url, "id_or_url");
  const format =
    params.format === undefined
      ? "md"
      : readEnum(params.format, "format", [
          { value: "md" as const, aliases: ["markdown", "text", "md"] },
          { value: "json" as const, aliases: ["json"] },
        ]);

  const id = extractNotionId(raw);
  if (!id) {
    throw inputError(
      GET_ERRORS.noIdInInput({ raw }),
      { id_or_url: raw }
    );
  }

  // Three levels, because a Notion id carries no type information: page, data
  // source and database ids are all plain UUIDs. A caller holding ids from
  // notion_search should not have to know which kind it received.
  const page = await runPage(id, format, run);
  if (page.ok) return page.value;

  // 失败文案统一交给 lib/failures.ts：四个工具对 "没装 / 没登录 / 没共享 / 限流"
  // 的措辞必须一致，各自维护一套 regex 只会让同一个错误在不同工具里说法不同。
  if (isFatalCliError(page.res)) throw new Error(describeFailure(page.res, "notion_get failed"));

  if (shouldTryDatabase(page.res)) {
    // A database id resolves through `datasources resolve`; try it before the
    // data source probe so the common database read keeps its call count. A data
    // source id fails resolve (ntn suggests querying it directly) and lands on the
    // probe, which costs one extra request only for that id kind.
    const database = await runDatabase(id, run);
    if (database.ok) return database.value;

    if (isFatalCliError(database.res)) {
      throw new Error(describeFailure(database.res, "notion_get failed"));
    }

    const dataSource = await runDataSourceSchema(id, run);
    if (dataSource.ok) return dataSource.value;

    // Report what ntn actually said for each attempt. Only the three-level fallback
    // produces this context, so the per-attempt one-liners stay here; the actionable
    // hint comes from the shared module like every other tool's failure text.
    const hint =
      failureHint(page.res) ??
      failureHint(database.res) ??
      "Make sure the target is shared with the Notion integration (in Notion: ••• → Connections).";
    throw new Error(
      `Could not read ${id} as a page, database or data source.\n` +
        `- ntn pages get: ${errorSummary(page.res)}\n` +
        `- ntn datasources resolve: ${errorSummary(database.res)}\n` +
        `- ntn api v1/data_sources: ${dataSource.excerpt}\n` +
        hint
    );
  }

  throw new Error(describeFailure(page.res, `notion_get could not read ${id}`));
}

/**
 * Read one data source's schema directly (`GET v1/data_sources/{id}`).
 *
 * This is the level notion_get used to miss: a data source id is neither a page
 * nor a database id, so both existing branches rejected it even though the schema
 * is one API call away. The result is shaped like a single-data-source database,
 * so callers see one schema contract regardless of which id kind they hold.
 */
async function runDataSourceSchema(
  id: string,
  run: NtnRunner
): Promise<{ ok: true; value: NotionDatabaseResult } | { ok: false; excerpt: string }> {
  let res: RunNtnResult;
  try {
    res = await run({ args: ["api", `v1/data_sources/${id}`], env: NTN_ENV });
  } catch (error) {
    return { ok: false, excerpt: error instanceof Error ? error.message : String(error) };
  }
  if (!res.ok) return { ok: false, excerpt: errorSummary(res) };

  const parsed = tryParseJson(res.stdout);
  if (!isRecord(parsed)) return { ok: false, excerpt: "unexpected JSON from v1/data_sources" };

  const properties = readProperties(parsed, id);
  if (properties.length === 0) {
    return { ok: false, excerpt: "v1/data_sources returned no properties" };
  }

  const title = plainText(parsed.title);
  const url = typeof parsed.url === "string" && parsed.url ? parsed.url : undefined;
  const dataSource: DataSourceInfo = {
    id,
    ...(title ? { name: title } : {}),
    properties,
  };
  const candidates = parentItemCandidates([dataSource]);

  return {
    ok: true,
    value: {
      type: "database",
      id,
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      data_source_ids: [id],
      properties,
      data_sources: [dataSource],
      ...(candidates.length > 0 ? { parent_item_candidates: candidates } : {}),
    },
  };
}

async function runPage(
  id: string,
  format: "md" | "json",
  run: NtnRunner
): Promise<Attempt<NotionGetResult>> {
  const args = ["pages", "get", id];
  if (format === "json") args.push("--json");

  const res = await run({ args, env: NTN_ENV });
  if (!res.ok) return { ok: false, res };

  const page = format === "json" ? pageFromJson(id, res.stdout) : pageFromMarkdown(id, res);
  return { ok: true, value: page };
}

function pageFromMarkdown(id: string, res: RunNtnResult): NotionPageResult {
  // `ntn pages get` prints properties as YAML frontmatter followed by the body; keep both, they are
  // useful context and the CLI deliberately makes the output round-trippable (`pages edit` accepts it).
  const markdown = res.stdout.replace(/\s+$/, "");
  const truncated = TRUNCATION_WARNING_RE.test(res.stderr);
  return {
    type: "page",
    id,
    format: "md",
    markdown,
    ...(truncated ? { truncated: true } : {}),
  };
}

function pageFromJson(fallbackId: string, stdout: string): NotionPageResult {
  const parsed = parseJsonOrThrow(stdout, "ntn pages get --json");
  if (!isRecord(parsed)) {
    throw new Error("ntn pages get --json returned unexpected JSON (expected an object).");
  }

  const page = isRecord(parsed.page) ? parsed.page : {};
  const markdownBlock = isRecord(parsed.markdown) ? parsed.markdown : {};
  const markdown = markdownBlock.markdown;
  if (typeof markdown !== "string") {
    throw new Error("ntn pages get --json did not include a markdown body (is this a page?).");
  }

  const id = typeof page.id === "string" && page.id ? page.id : fallbackId;
  const url = typeof page.url === "string" && page.url ? page.url : undefined;
  const properties = isRecord(page.properties) ? page.properties : undefined;
  const title = extractTitle(page.properties);
  const unknownBlockIds = Array.isArray(markdownBlock.unknown_block_ids)
    ? markdownBlock.unknown_block_ids.filter((value): value is string => typeof value === "string")
    : [];

  return {
    type: "page",
    id,
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    format: "json",
    markdown,
    ...(properties ? { properties } : {}),
    truncated: markdownBlock.truncated === true,
    unknown_block_ids: unknownBlockIds,
  };
}

async function runDatabase(id: string, run: NtnRunner): Promise<Attempt<NotionGetResult>> {
  const resolveRes = await run({
    args: ["datasources", "resolve", id, "--json"],
    env: NTN_ENV,
  });
  if (!resolveRes.ok) return { ok: false, res: resolveRes };

  const resolved = parseJsonOrThrow(resolveRes.stdout, `ntn datasources resolve ${id} --json`);
  const refs = readDataSourceRefs(resolved, id);
  const dataSourceIds = refs.map((ref) => ref.id);

  // Independent after resolve: database metadata + every data source schema, one subprocess each.
  const [metaRes, ...schemaResults] = await Promise.all([
    run({ args: ["api", `v1/databases/${id}`], env: NTN_ENV }),
    ...dataSourceIds.map((dataSourceId) =>
      run({ args: ["api", `v1/data_sources/${dataSourceId}`], env: NTN_ENV })
    ),
  ]);

  // Metadata is best effort: a missing capability must not hide the schema we already resolved.
  const meta = metaRes.ok ? tryParseJson(metaRes.stdout) : undefined;
  const metaRecord = isRecord(meta) ? meta : {};

  const dataSources: DataSourceInfo[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const schemaRes = schemaResults[i];
    const schema = schemaRes.ok ? tryParseJson(schemaRes.stdout) : undefined;
    const parsed = isRecord(schema) ? schema : undefined;
    const error = schemaRes.ok
      ? parsed
        ? undefined
        : "ntn api v1/data_sources returned unexpected JSON"
      : errorSummary(schemaRes);

    const schemaTitle = parsed ? plainText(parsed.title) : undefined;
    const dataSource: DataSourceInfo = {
      id: ref.id,
      ...(schemaTitle ?? ref.name ? { name: schemaTitle ?? ref.name } : {}),
      properties: parsed ? readProperties(parsed, ref.id) : [],
      ...(error ? { error } : {}),
    };
    if (error) warnings.push(`data source ${ref.id}: ${error}`);
    dataSources.push(dataSource);
  }

  const metaTitle = plainText(metaRecord.title);
  const title = metaTitle;
  const url = typeof metaRecord.url === "string" && metaRecord.url ? metaRecord.url : undefined;
  const metaId = typeof metaRecord.id === "string" && metaRecord.id ? metaRecord.id : id;

  const candidates = parentItemCandidates(dataSources);
  const result: NotionDatabaseResult = {
    type: "database",
    id: metaId,
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    data_source_ids: dataSourceIds,
    properties: unionProperties(dataSources.flatMap((dataSource) => dataSource.properties)),
    data_sources: dataSources,
    ...(candidates.length > 0 ? { parent_item_candidates: candidates } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  return { ok: true, value: result };
}

type DataSourceRef = { id: string; name?: string };

function readDataSourceRefs(parsed: unknown, databaseId: string): DataSourceRef[] {
  if (!isRecord(parsed)) {
    throw new Error(`ntn datasources resolve ${databaseId} --json returned unexpected JSON.`);
  }
  if (!Array.isArray(parsed.data_sources)) {
    throw new Error(`ntn datasources resolve ${databaseId} --json did not include data_sources.`);
  }

  const refs: DataSourceRef[] = [];
  const seen = new Set<string>();
  for (const item of parsed.data_sources) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    refs.push({
      id: item.id,
      ...(typeof item.name === "string" && item.name ? { name: item.name } : {}),
    });
  }

  if (parsed.data_sources.length > 0 && refs.length === 0) {
    throw new Error(
      `ntn datasources resolve ${databaseId} --json returned no usable data source ids.`
    );
  }
  return refs;
}

function readProperties(parsed: Record<string, unknown>, dataSourceId?: string): PropertyInfo[] {
  const raw = parsed.properties;
  if (!isRecord(raw)) return [];

  type Entry = { name: string; type: string; relationDataSourceId?: string };
  const entries: Entry[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const name = typeof value.name === "string" && value.name ? value.name : key;
    const type = typeof value.type === "string" && value.type ? value.type : "unknown";
    const relation = isRecord(value.relation) ? value.relation : undefined;
    const relationDataSourceId =
      relation && typeof relation.data_source_id === "string" ? relation.data_source_id : undefined;
    entries.push({
      name,
      type,
      ...(relationDataSourceId ? { relationDataSourceId } : {}),
    });
  }

  // Same selector notion_page_edit uses for parent / child-row create, so the advertised
  // Parent-item column and the written column can never diverge.
  const selected = dataSourceId
    ? selectParentItemProperty(entries, dataSourceId)
    : undefined;

  return entries.map((entry) => {
    const selfRelation =
      entry.type === "relation" && entry.relationDataSourceId !== undefined
        ? sameNotionId(entry.relationDataSourceId, dataSourceId)
        : undefined;
    return {
      name: entry.name,
      type: entry.type,
      writable: isWritablePropertyType(entry.type),
      ...(entry.relationDataSourceId
        ? { relation_data_source_id: entry.relationDataSourceId }
        : {}),
      ...(selfRelation !== undefined ? { self_relation: selfRelation } : {}),
      ...(selected?.name === entry.name ? { parent_item_candidate: true } : {}),
    };
  });
}

function parentItemCandidates(
  dataSources: DataSourceInfo[]
): { data_source_id: string; property: string }[] {
  const out: { data_source_id: string; property: string }[] = [];
  for (const dataSource of dataSources) {
    for (const property of dataSource.properties) {
      if (property.parent_item_candidate) {
        out.push({ data_source_id: dataSource.id, property: property.name });
      }
    }
  }
  return out;
}

function unionProperties(properties: PropertyInfo[]): PropertyInfo[] {
  const seen = new Map<string, PropertyInfo>();
  for (const property of properties) {
    const key = `${property.name}\u0000${property.type}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...property });
      continue;
    }
    // Same name+type in several data sources: relation flags are per-data-source, so
    // keep them only when every occurrence agrees (otherwise the union would lie).
    const agrees =
      existing.relation_data_source_id === property.relation_data_source_id &&
      existing.self_relation === property.self_relation &&
      existing.parent_item_candidate === property.parent_item_candidate;
    if (!agrees) {
      delete existing.relation_data_source_id;
      delete existing.self_relation;
      delete existing.parent_item_candidate;
    }
  }
  return [...seen.values()];
}

function extractTitle(properties: unknown): string | undefined {
  if (!isRecord(properties)) return undefined;
  for (const value of Object.values(properties)) {
    if (!isRecord(value) || value.type !== "title" || !Array.isArray(value.title)) continue;
    const title = plainText(value.title);
    if (title) return title;
  }
  return undefined;
}

function plainText(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  const text = items
    .map((item) => (isRecord(item) && typeof item.plain_text === "string" ? item.plain_text : ""))
    .join("");
  return text.trim() ? text : undefined;
}

function renderPageText(page: NotionPageResult): string {
  if (page.format === "json") return JSON.stringify(page, null, 2);
  const body = page.markdown.trim() ? page.markdown : "(This page has no readable content.)";
  // `details` is not shown to the model, so the truncation warning must be in the text itself.
  return page.truncated
    ? `${body}\n\n[notion_get] ntn truncated this page, so the text above is incomplete (rare: most pages, ` +
        `even very large ones, come back whole). Next: format="json" returns unknown_block_ids, child pages ` +
        `can be read by their own ids, notion_page_edit takes an exact old_str from the part above, and for ` +
        `a database notion_query reads its rows with limit / start_cursor.`
    : body;
}

function renderDatabaseText(result: NotionDatabaseResult): string {
  const lines: string[] = [];
  lines.push(`${result.title ?? "(untitled database)"} — Notion database`);
  lines.push(`ID: ${result.id}`);
  if (result.url) lines.push(`URL: ${result.url}`);

  lines.push(`Data sources (${result.data_source_ids.length}):`);
  if (result.data_source_ids.length === 0) {
    lines.push("- (none reported)");
  } else {
    for (const dataSource of result.data_sources) {
      const name = dataSource.name ? ` ${dataSource.name}` : "";
      const error = dataSource.error ? ` — schema unavailable: ${dataSource.error}` : "";
      lines.push(`- ${dataSource.id}${name}${error}`);
    }
  }

  lines.push(`Properties (${result.properties.length}):`);
  if (result.properties.length === 0) {
    lines.push("- (none)");
  } else {
    for (const property of result.properties) {
      lines.push(`- ${formatProperty(property)}`);
    }
  }

  if (result.parent_item_candidates && result.parent_item_candidates.length > 0) {
    lines.push(
      GET_RESULT_TEXT.parentItemCandidates({
        list: result.parent_item_candidates
          .map((candidate) => `${candidate.property} (data source ${candidate.data_source_id})`)
          .join(", "),
      })
    );
  }

  if (result.data_sources.length > 1) {
    lines.push("Per data source:");
    for (const dataSource of result.data_sources) {
      const schema =
        dataSource.properties.map((property) => formatProperty(property)).join(", ") ||
        "(none)";
      lines.push(`- ${dataSource.id}: ${schema}`);
    }
  }

  if (result.warnings && result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }

  lines.push("");
  lines.push(GET_RESULT_TEXT.schemaOnly);
  return lines.join("\n");
}

/** One-line schema entry; flags tell a model what it may write and what parent row link to use. */
function formatProperty(property: PropertyInfo): string {
  const flags: string[] = [];
  if (!property.writable) flags.push("read-only");
  if (property.type === "relation" && property.relation_data_source_id) {
    flags.push(
      `→ ${property.relation_data_source_id}${property.self_relation ? " (self)" : ""}`
    );
  }
  if (property.parent_item_candidate) flags.push("Parent-item candidate");
  return `${property.name}: ${property.type}${flags.length ? ` — ${flags.join(", ")}` : ""}`;
}

/**
 * 只取第一行错误摘要：三级回退要把每次尝试各列一行，schema 失败也要塞进结果的
 * warnings/error 字段，完整的失败文案（含 exit code 和 hint）由 lib/failures.ts 负责。
 */
function errorSummary(res: RunNtnResult): string {
  const first =
    (res.stderr || res.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const cleaned = first.replace(/^error:\s*/i, "");
  return cleaned || `ntn exited with code ${res.code ?? "null"}`;
}

/**
 * 只做路由判断，不生成文案：这三种情况重试成数据库/数据源都不可能成功，所以
 * 立刻上报，而不是多花两三个 ntn 进程。文案在 lib/failures.ts。
 */
function isFatalCliError(res: RunNtnResult): boolean {
  if (res.code === null) return true;
  if (res.code === 4) return true;
  return AUTH_ERROR_RE.test(res.stderr);
}

function shouldTryDatabase(res: RunNtnResult): boolean {
  if (isFatalCliError(res)) return false;
  const text = `${res.stderr}\n${res.stdout}`;
  return !TRANSIENT_ERROR_RE.test(text);
}

function parseJsonOrThrow(stdout: string, what: string): unknown {
  try {
    return parseJsonStdout(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${what} returned invalid JSON: ${detail}`);
  }
}

function tryParseJson(stdout: string): unknown {
  try {
    return parseJsonStdout(stdout);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
