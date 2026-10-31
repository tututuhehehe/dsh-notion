// src/dsh/tool.ts
var TOOL_TIMEOUTS = {
  search: 12e4,
  get: 12e4,
  page: 18e4,
  query: 3e5
};
function defineNotionTool(tool) {
  return tool;
}
function bindSignal(run, signal) {
  if (!signal) return run;
  return async (options) => {
    if (signal.aborted) throw abortError();
    const result = await run({ ...options, signal });
    if (signal.aborted) throw abortError();
    return result;
  };
}
function abortError() {
  return new NotionToolError("tool call aborted", { code: NOTION_ERROR_CODES.aborted });
}
function codedError(error, code = NOTION_ERROR_CODES.ntnFailed) {
  if (error instanceof NotionToolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NotionToolError(message, { code });
}
function textBlocks(text2) {
  return [{ type: "text", text: text2 }];
}
var NOTION_ERROR_CODES = {
  /** The caller's arguments cannot be acted on; re-read the message and retry. */
  invalidInput: "INVALID_INPUT",
  /** `ntn` itself failed (bad token, no workspace, Notion API error, exit != 0). */
  ntnFailed: "NTN_FAILED",
  /** The call was cancelled or timed out; the child process was killed. */
  aborted: "ABORTED",
  /** A follow-up write failed and the page could not be fully cleaned up. */
  partialWrite: "PARTIAL_WRITE"
};
var NotionToolError = class extends Error {
  /** Stable machine-readable kind (`INVALID_INPUT`, `NTN_FAILED`, ...). */
  code;
  /** Structured payload; never model-facing (DSH drops it), used by tests/logs. */
  details;
  /** The message as authored, without the `[CODE]` prefix. */
  detail;
  constructor(message, options = {}) {
    const code = options.code ?? NOTION_ERROR_CODES.invalidInput;
    super(`[${code}] ${message}`);
    this.name = "NotionToolError";
    this.code = code;
    this.detail = message;
    this.details = options.details ?? {};
  }
};

// src/lib/ids.ts
var UUID_TOKEN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
var BARE_TOKEN = "[0-9a-f]{32}";
var ID_ONLY_RE = new RegExp(`^(?:${UUID_TOKEN}|${BARE_TOKEN})$`, "i");
var ID_TOKEN_RE = new RegExp(`${UUID_TOKEN}|${BARE_TOKEN}`, "gi");
var NOTION_HOSTS = ["notion.so", "notion.com", "notion.site"];
function extractNotionId(input) {
  const raw = input.trim();
  if (!raw) return null;
  if (ID_ONLY_RE.test(raw)) return canonicalize(raw);
  const url = parseNotionUrl(raw);
  if (url) {
    const fromPath = lastId(url.pathname);
    if (fromPath) return fromPath;
  }
  return lastId(stripQueryAndFragment(raw));
}
function parseNotionUrl(raw) {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    const isNotion = NOTION_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    return isNotion ? url : null;
  } catch {
    return null;
  }
}
function stripQueryAndFragment(value) {
  return value.split("#", 1)[0].split("?", 1)[0];
}
function lastId(value) {
  const matches = value.match(ID_TOKEN_RE);
  if (!matches || matches.length === 0) return null;
  return canonicalize(matches[matches.length - 1]);
}
function canonicalize(id) {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return hex;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// src/lib/properties.ts
var READ_ONLY_PROPERTY_TYPES = /* @__PURE__ */ new Set([
  "formula",
  "rollup",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "unique_id",
  "button",
  "verification"
]);
function isWritablePropertyType(type) {
  return !READ_ONLY_PROPERTY_TYPES.has(type);
}
var PARENT_ITEM_NAME_RE = /parent[\s_-]*item|parent|上级|父项|父任务|父/i;
function isParentItemName(name2) {
  return PARENT_ITEM_NAME_RE.test(name2);
}
function canonicalNotionId(id) {
  return id.replace(/-/g, "").toLowerCase();
}
function sameNotionId(a, b) {
  if (!a || !b) return false;
  return canonicalNotionId(a) === canonicalNotionId(b);
}
function selectParentItemProperty(properties, dataSourceId) {
  const relations = [...properties].filter((property) => property.type === "relation");
  if (relations.length === 0) return void 0;
  const selfRelations = relations.filter(
    (property) => property.relationDataSourceId === void 0 || sameNotionId(property.relationDataSourceId, dataSourceId)
  );
  const named = selfRelations.find((property) => isParentItemName(property.name));
  if (named) return named;
  return selfRelations.length === 1 ? selfRelations[0] : void 0;
}

// src/lib/runNtn.ts
import { spawn } from "node:child_process";
async function runNtn(options) {
  const { args, env, timeoutMs = 6e4, signal, spawnFn = spawn } = options;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, stdout: "", stderr: "ntn call aborted before it started", code: null });
      return;
    }
    const child = spawnFn("ntn", args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
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
      const msg = err.message.includes("ENOENT") ? "ntn not found on PATH. Install: npm i -g ntn  (or https://ntn.dev). Then ntn login or set NOTION_API_TOKEN." : err.message;
      finish({ ok: false, stdout, stderr: msg, code: null });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, stdout, stderr, code });
    });
  });
}
function parseJsonStdout(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

// src/tools/get.ts
var NTN_ENV = { NO_COLOR: "1", NO_HYPERLINK: "1" };
var AUTH_ERROR_RE = /no workspace selected|ntn login|notion_api_token|\(401 |unauthorized/i;
var TRUNCATION_WARNING_RE = /page content (?:was|is) truncated|content was truncated/i;
var TRANSIENT_ERROR_RE = /\b(429|500|502|503|504|529)\b|rate_limited|internal_server_error|service_unavailable|gateway_timeout|service_overload|timed out/i;
var GET_PARAMETERS = {
  type: "object",
  properties: {
    id_or_url: {
      type: "string",
      description: "Notion page or database ID (dashed UUID or 32-character id) or a notion.so / app.notion.com URL."
    },
    format: {
      type: "string",
      enum: ["md", "json"],
      description: "Page output. 'md' (default) returns the Markdown body with properties as frontmatter; 'json' returns the structured page payload (markdown plus url/title/truncation metadata). Databases are always returned as schema, regardless of format."
    }
  },
  required: ["id_or_url"],
  additionalProperties: false
};
var GET_OUTPUT_SCHEMA = {
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
        unknown_block_ids: { type: "array", items: { type: "string" } }
      },
      required: ["type", "id", "format", "markdown"],
      additionalProperties: true
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
        warnings: { type: "array", items: { type: "string" } }
      },
      required: ["type", "id", "data_source_ids", "properties", "data_sources"],
      additionalProperties: true
    }
  ]
};
function renderGetResult(value) {
  return value.type === "database" ? renderDatabaseText(value) : renderPageText(value);
}
function createNotionGetTool(run = runNtn) {
  return defineNotionTool({
    name: "notion_get",
    description: "Read one Notion page or inspect one database. A page returns Markdown (format='md', default) with its properties as frontmatter, or a structured payload (format='json') that also carries url, title, truncated and unknown_block_ids. A database returns every data source id plus each property's name, type, writable flag and Parent-item / self-relation candidates; rows are never fetched here, so read them with notion_query. If a page comes back truncated, ask for format='json' to see unknown_block_ids or read a narrower page.",
    timeoutMs: TOOL_TIMEOUTS.get,
    // Read-only: safe to run alongside sibling calls.
    isConcurrencySafe: () => true,
    parameters: GET_PARAMETERS,
    output: {
      schema: GET_OUTPUT_SCHEMA,
      render: (_args, value) => textBlocks(renderGetResult(value))
    },
    async execute(args, exec) {
      try {
        if (exec.signal?.aborted) throw abortError();
        return await executeNotionGet(
          args,
          bindSignal(run, exec.signal)
        );
      } catch (error) {
        throw codedError(error);
      }
    }
  });
}
async function executeNotionGet(params, run = runNtn) {
  const format = params.format ?? "md";
  if (format !== "md" && format !== "json") {
    throw new Error(`Unsupported format "${String(format)}". Use "md" (default) or "json".`);
  }
  const id = extractNotionId(params.id_or_url);
  if (!id) {
    throw new Error(
      `Could not find a Notion ID in "${params.id_or_url}". Pass a 32-character id (with or without dashes) or a notion.so / app.notion.com URL.`
    );
  }
  const page = await runPage(id, format, run);
  if (page.ok) return page.value;
  const pageError = errorSummary(page.res);
  if (isFatalCliError(page.res)) throw new Error(fatalCliMessage(page.res));
  if (!shouldTryDatabase(page.res)) {
    throw new Error(`Could not read page ${id}: ${pageError}`);
  }
  const database = await runDatabase(id, run);
  if (database.ok) return database.value;
  const databaseError = errorSummary(database.res);
  if (isFatalCliError(database.res)) throw new Error(fatalCliMessage(database.res));
  throw new Error(
    `Could not read ${id} as a Notion page or database.
- page: ${pageError}
- database: ${databaseError}
Check the id/URL, and make sure the page or database is shared with the Notion integration (in Notion: \u2022\u2022\u2022 \u2192 Connections).`
  );
}
async function runPage(id, format, run) {
  const args = ["pages", "get", id];
  if (format === "json") args.push("--json");
  const res = await run({ args, env: NTN_ENV });
  if (!res.ok) return { ok: false, res };
  const page = format === "json" ? pageFromJson(id, res.stdout) : pageFromMarkdown(id, res);
  return { ok: true, value: page };
}
function pageFromMarkdown(id, res) {
  const markdown = res.stdout.replace(/\s+$/, "");
  const truncated = TRUNCATION_WARNING_RE.test(res.stderr);
  return {
    type: "page",
    id,
    format: "md",
    markdown,
    ...truncated ? { truncated: true } : {}
  };
}
function pageFromJson(fallbackId, stdout) {
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
  const url = typeof page.url === "string" && page.url ? page.url : void 0;
  const properties = isRecord(page.properties) ? page.properties : void 0;
  const title = extractTitle(page.properties);
  const unknownBlockIds = Array.isArray(markdownBlock.unknown_block_ids) ? markdownBlock.unknown_block_ids.filter((value) => typeof value === "string") : [];
  return {
    type: "page",
    id,
    ...url ? { url } : {},
    ...title ? { title } : {},
    format: "json",
    markdown,
    ...properties ? { properties } : {},
    truncated: markdownBlock.truncated === true,
    unknown_block_ids: unknownBlockIds
  };
}
async function runDatabase(id, run) {
  const resolveRes = await run({
    args: ["datasources", "resolve", id, "--json"],
    env: NTN_ENV
  });
  if (!resolveRes.ok) return { ok: false, res: resolveRes };
  const resolved = parseJsonOrThrow(resolveRes.stdout, `ntn datasources resolve ${id} --json`);
  const refs = readDataSourceRefs(resolved, id);
  const dataSourceIds = refs.map((ref) => ref.id);
  const [metaRes, ...schemaResults] = await Promise.all([
    run({ args: ["api", `v1/databases/${id}`], env: NTN_ENV }),
    ...dataSourceIds.map(
      (dataSourceId) => run({ args: ["api", `v1/data_sources/${dataSourceId}`], env: NTN_ENV })
    )
  ]);
  const meta = metaRes.ok ? tryParseJson(metaRes.stdout) : void 0;
  const metaRecord = isRecord(meta) ? meta : {};
  const dataSources = [];
  const warnings = [];
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const schemaRes = schemaResults[i];
    const schema = schemaRes.ok ? tryParseJson(schemaRes.stdout) : void 0;
    const parsed = isRecord(schema) ? schema : void 0;
    const error = schemaRes.ok ? parsed ? void 0 : "ntn api v1/data_sources returned unexpected JSON" : errorSummary(schemaRes);
    const schemaTitle = parsed ? plainText(parsed.title) : void 0;
    const dataSource = {
      id: ref.id,
      ...schemaTitle ?? ref.name ? { name: schemaTitle ?? ref.name } : {},
      properties: parsed ? readProperties(parsed, ref.id) : [],
      ...error ? { error } : {}
    };
    if (error) warnings.push(`data source ${ref.id}: ${error}`);
    dataSources.push(dataSource);
  }
  const metaTitle = plainText(metaRecord.title);
  const title = metaTitle;
  const url = typeof metaRecord.url === "string" && metaRecord.url ? metaRecord.url : void 0;
  const metaId = typeof metaRecord.id === "string" && metaRecord.id ? metaRecord.id : id;
  const candidates = parentItemCandidates(dataSources);
  const result = {
    type: "database",
    id: metaId,
    ...title ? { title } : {},
    ...url ? { url } : {},
    data_source_ids: dataSourceIds,
    properties: unionProperties(dataSources.flatMap((dataSource) => dataSource.properties)),
    data_sources: dataSources,
    ...candidates.length > 0 ? { parent_item_candidates: candidates } : {},
    ...warnings.length > 0 ? { warnings } : {}
  };
  return { ok: true, value: result };
}
function readDataSourceRefs(parsed, databaseId) {
  if (!isRecord(parsed)) {
    throw new Error(`ntn datasources resolve ${databaseId} --json returned unexpected JSON.`);
  }
  if (!Array.isArray(parsed.data_sources)) {
    throw new Error(`ntn datasources resolve ${databaseId} --json did not include data_sources.`);
  }
  const refs = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of parsed.data_sources) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    refs.push({
      id: item.id,
      ...typeof item.name === "string" && item.name ? { name: item.name } : {}
    });
  }
  if (parsed.data_sources.length > 0 && refs.length === 0) {
    throw new Error(
      `ntn datasources resolve ${databaseId} --json returned no usable data source ids.`
    );
  }
  return refs;
}
function readProperties(parsed, dataSourceId) {
  const raw = parsed.properties;
  if (!isRecord(raw)) return [];
  const entries = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const name2 = typeof value.name === "string" && value.name ? value.name : key;
    const type = typeof value.type === "string" && value.type ? value.type : "unknown";
    const relation = isRecord(value.relation) ? value.relation : void 0;
    const relationDataSourceId = relation && typeof relation.data_source_id === "string" ? relation.data_source_id : void 0;
    entries.push({
      name: name2,
      type,
      ...relationDataSourceId ? { relationDataSourceId } : {}
    });
  }
  const selected = dataSourceId ? selectParentItemProperty(entries, dataSourceId) : void 0;
  return entries.map((entry) => {
    const selfRelation = entry.type === "relation" && entry.relationDataSourceId !== void 0 ? sameNotionId(entry.relationDataSourceId, dataSourceId) : void 0;
    return {
      name: entry.name,
      type: entry.type,
      writable: isWritablePropertyType(entry.type),
      ...entry.relationDataSourceId ? { relation_data_source_id: entry.relationDataSourceId } : {},
      ...selfRelation !== void 0 ? { self_relation: selfRelation } : {},
      ...selected?.name === entry.name ? { parent_item_candidate: true } : {}
    };
  });
}
function parentItemCandidates(dataSources) {
  const out = [];
  for (const dataSource of dataSources) {
    for (const property of dataSource.properties) {
      if (property.parent_item_candidate) {
        out.push({ data_source_id: dataSource.id, property: property.name });
      }
    }
  }
  return out;
}
function unionProperties(properties) {
  const seen = /* @__PURE__ */ new Map();
  for (const property of properties) {
    const key = `${property.name}\0${property.type}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...property });
      continue;
    }
    const agrees = existing.relation_data_source_id === property.relation_data_source_id && existing.self_relation === property.self_relation && existing.parent_item_candidate === property.parent_item_candidate;
    if (!agrees) {
      delete existing.relation_data_source_id;
      delete existing.self_relation;
      delete existing.parent_item_candidate;
    }
  }
  return [...seen.values()];
}
function extractTitle(properties) {
  if (!isRecord(properties)) return void 0;
  for (const value of Object.values(properties)) {
    if (!isRecord(value) || value.type !== "title" || !Array.isArray(value.title)) continue;
    const title = plainText(value.title);
    if (title) return title;
  }
  return void 0;
}
function plainText(items) {
  if (!Array.isArray(items)) return void 0;
  const text2 = items.map((item) => isRecord(item) && typeof item.plain_text === "string" ? item.plain_text : "").join("");
  return text2.trim() ? text2 : void 0;
}
function renderPageText(page) {
  if (page.format === "json") return JSON.stringify(page, null, 2);
  const body = page.markdown.trim() ? page.markdown : "(This page has no readable content.)";
  return page.truncated ? `${body}

[notion_get] ntn truncated this page; use format="json" to inspect unknown_block_ids, or read a narrower page.` : body;
}
function renderDatabaseText(result) {
  const lines = [];
  lines.push(`${result.title ?? "(untitled database)"} \u2014 Notion database`);
  lines.push(`ID: ${result.id}`);
  if (result.url) lines.push(`URL: ${result.url}`);
  lines.push(`Data sources (${result.data_source_ids.length}):`);
  if (result.data_source_ids.length === 0) {
    lines.push("- (none reported)");
  } else {
    for (const dataSource of result.data_sources) {
      const name2 = dataSource.name ? ` ${dataSource.name}` : "";
      const error = dataSource.error ? ` \u2014 schema unavailable: ${dataSource.error}` : "";
      lines.push(`- ${dataSource.id}${name2}${error}`);
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
      "Parent-item candidates (use one with notion_page attach / a child-row create): " + result.parent_item_candidates.map((candidate) => `${candidate.property} (data source ${candidate.data_source_id})`).join(", ")
    );
  }
  if (result.data_sources.length > 1) {
    lines.push("Per data source:");
    for (const dataSource of result.data_sources) {
      const schema = dataSource.properties.map((property) => formatProperty(property)).join(", ") || "(none)";
      lines.push(`- ${dataSource.id}: ${schema}`);
    }
  }
  if (result.warnings && result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }
  lines.push("");
  lines.push("Schema only \u2014 no rows. Use notion_query with a data_source_id to read pages.");
  return lines.join("\n");
}
function formatProperty(property) {
  const flags = [];
  if (!property.writable) flags.push("read-only");
  if (property.type === "relation" && property.relation_data_source_id) {
    flags.push(
      `\u2192 ${property.relation_data_source_id}${property.self_relation ? " (self)" : ""}`
    );
  }
  if (property.parent_item_candidate) flags.push("Parent-item candidate");
  return `${property.name}: ${property.type}${flags.length ? ` \u2014 ${flags.join(", ")}` : ""}`;
}
function errorSummary(res) {
  const first = (res.stderr || res.stdout || "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const cleaned = first.replace(/^error:\s*/i, "");
  return cleaned || `ntn exited with code ${res.code ?? "null"}`;
}
function isFatalCliError(res) {
  if (res.code === null) return true;
  if (res.code === 4) return true;
  return AUTH_ERROR_RE.test(res.stderr);
}
function shouldTryDatabase(res) {
  if (isFatalCliError(res)) return false;
  const text2 = `${res.stderr}
${res.stdout}`;
  return !TRANSIENT_ERROR_RE.test(text2);
}
function fatalCliMessage(res) {
  const summary = errorSummary(res);
  if (res.code === null) {
    if (/ntn not found on path/i.test(res.stderr)) return res.stderr.trim();
    if (/timed out/i.test(res.stderr)) {
      return `Notion CLI timed out: ${summary}. Retry, or read a smaller page.`;
    }
    return `Could not run \`ntn\`: ${summary}`;
  }
  return `Notion CLI is not authenticated or configured: ${summary}. Run \`ntn login\` or set NOTION_API_TOKEN.`;
}
function parseJsonOrThrow(stdout, what) {
  try {
    return parseJsonStdout(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${what} returned invalid JSON: ${detail}`);
  }
}
function tryParseJson(stdout) {
  try {
    return parseJsonStdout(stdout);
  } catch {
    return void 0;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/lib/datasources.ts
function parseResolveDataSources(raw) {
  const isRecord4 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (isRecord4(raw)) {
    if (Array.isArray(raw.data_sources)) items = raw.data_sources;
    else if (Array.isArray(raw.results)) items = raw.results;
    else if (typeof raw.id === "string" || typeof raw.data_source_id === "string") items = [raw];
  }
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of items) {
    if (typeof item === "string") {
      const id2 = item.trim();
      if (id2 && !seen.has(id2)) {
        seen.add(id2);
        out.push({ id: id2 });
      }
      continue;
    }
    if (!isRecord4(item)) continue;
    const id = typeof item.id === "string" ? item.id : typeof item.data_source_id === "string" ? item.data_source_id : typeof item.dataSourceId === "string" ? item.dataSourceId : void 0;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name2 = typeof item.name === "string" ? item.name : typeof item.title === "string" ? item.title : void 0;
    out.push(name2 ? { id, name: name2 } : { id });
  }
  return out;
}

// src/lib/schema.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function extractSchemaProperties(raw) {
  if (!isRecord2(raw)) return void 0;
  let properties = raw.properties;
  if (!isRecord2(properties)) {
    for (const wrapper of ["data_source", "database"]) {
      const nested = raw[wrapper];
      if (isRecord2(nested) && isRecord2(nested.properties)) {
        properties = nested.properties;
        break;
      }
    }
  }
  if (!isRecord2(properties)) return void 0;
  const map = /* @__PURE__ */ new Map();
  for (const [name2, entry] of Object.entries(properties)) {
    if (!isRecord2(entry)) continue;
    const type = typeof entry.type === "string" ? entry.type : "unknown";
    const relation = isRecord2(entry.relation) ? entry.relation : void 0;
    const relationDataSourceId = relation && typeof relation.data_source_id === "string" ? relation.data_source_id : void 0;
    map.set(name2, {
      name: name2,
      type,
      ...relationDataSourceId ? { relationDataSourceId } : {}
    });
  }
  return map.size ? map : void 0;
}
function reportedDataSourceId(raw, fallback) {
  if (isRecord2(raw) && typeof raw.id === "string" && raw.id) return raw.id;
  return fallback;
}

// src/tools/page.ts
var BODY_CONTENT_KEY = "body_content";
var ICON_KEY = "icon";
var PAGE_SCHEMA = {
  source: "page",
  properties: /* @__PURE__ */ new Map([["title", { name: "title", type: "title" }]])
};
var FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var HEX32_RE = /^[0-9a-f]{32}$/i;
function isNotionId(value) {
  return UUID_RE.test(value) || HEX32_RE.test(value);
}
var InputError = class extends NotionToolError {
  constructor(message, details = {}) {
    super(message, { code: NOTION_ERROR_CODES.invalidInput, details });
    this.name = "InputError";
  }
};
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function describeValue(value) {
  try {
    const text2 = JSON.stringify(value);
    return (text2 ?? String(value)).slice(0, 80);
  } catch {
    return String(value);
  }
}
function truncate(text2, max = 1200) {
  return text2.length > max ? `${text2.slice(0, max)}\u2026` : text2;
}
function formatParent(parent) {
  return `${parent.kind === "data_source" ? "data-source" : parent.kind}:${parent.id}`;
}
function writableProperties(schema) {
  return [...schema.properties.values()].filter((prop) => isWritablePropertyType(prop.type)).map((prop) => ({ name: prop.name, type: prop.type }));
}
function formatHints(hints) {
  return hints.length ? hints.map((hint) => `${hint.name} (${hint.type})`).join(", ") : "(none)";
}
function titlePropertyName(schema) {
  for (const prop of schema.properties.values()) {
    if (prop.type === "title") return prop.name;
  }
  return void 0;
}
function relationProperties(schema) {
  return [...schema.properties.values()].filter((prop) => prop.type === "relation");
}
function findParentItemProperty(schema, dataSourceId) {
  return selectParentItemProperty(schema.properties.values(), dataSourceId);
}
var HTTP_URL_RE = /^https?:\/\//i;
var MAX_EMOJI_LENGTH = 16;
function normalizeIcon(raw) {
  if (raw === void 0) return void 0;
  if (raw === null) return { payload: null, display: null };
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) {
      throw new InputError(
        `props.${ICON_KEY} \u4E0D\u80FD\u662F\u7A7A\u5B57\u7B26\u4E32\uFF1A\u4E0D\u8BBE\u7F6E icon \u5C31\u7701\u7565\u8FD9\u4E2A\u952E\uFF0C\u6E05\u9664\u5DF2\u6709 icon \u8BF7\u4F20 null\u3002`,
        { property: ICON_KEY }
      );
    }
    if (HTTP_URL_RE.test(value)) {
      return { payload: { type: "external", external: { url: value } }, display: value };
    }
    if ([...value].length > MAX_EMOJI_LENGTH) {
      throw new InputError(
        `props.${ICON_KEY} \u770B\u8D77\u6765\u65E2\u4E0D\u662F emoji \u4E5F\u4E0D\u662F\u56FE\u7247 URL\uFF08\u957F\u5EA6 ${[...value].length}\uFF09\uFF1A${describeValue(value)}\u3002\u8BF7\u4F20\u5355\u4E2A emoji\uFF08\u5982 "\u{1F3AF}"\uFF09\u3001http(s) \u56FE\u7247 URL\uFF0C\u6216 null \u6E05\u9664\u3002`,
        { property: ICON_KEY, value }
      );
    }
    return { payload: { type: "emoji", emoji: value }, display: value };
  }
  if (isPlainObject(raw)) {
    const type = raw.type;
    if (type === "emoji") {
      const emoji = typeof raw.emoji === "string" ? raw.emoji.trim() : "";
      if (!emoji) {
        throw new InputError(
          `props.${ICON_KEY} \u7684 emoji \u5BF9\u8C61\u7F3A\u5C11 emoji \u6587\u672C\uFF1A\u9700\u8981 { "type": "emoji", "emoji": "\u{1F3AF}" }\u3002`,
          { property: ICON_KEY }
        );
      }
      return { payload: { type: "emoji", emoji }, display: emoji };
    }
    if (type === "external") {
      const url = isPlainObject(raw.external) ? raw.external.url : void 0;
      if (typeof url !== "string" || !HTTP_URL_RE.test(url.trim())) {
        throw new InputError(
          `props.${ICON_KEY} \u7684 external \u5BF9\u8C61\u9700\u8981\u4E00\u4E2A http(s) url\uFF1A{ "type": "external", "external": { "url": "https://\u2026/a.png" } }\u3002`,
          { property: ICON_KEY }
        );
      }
      return { payload: { type: "external", external: { url: url.trim() } }, display: url.trim() };
    }
    if (type === "custom_emoji" || type === "file") {
      return { payload: raw, display: `${String(type)} icon` };
    }
    throw new InputError(
      `props.${ICON_KEY} \u7684\u5BF9\u8C61\u5F62\u5F0F\u5FC5\u987B\u5E26 type\uFF1A\u63A5\u53D7 "emoji" / "external" / "custom_emoji" / "file"\uFF0C\u6216\u76F4\u63A5\u4F20 emoji \u5B57\u7B26\u4E32\u3001\u56FE\u7247 URL\u3001null\u3002\u6536\u5230 ${describeValue(raw)}\u3002`,
      { property: ICON_KEY, value: raw }
    );
  }
  throw new InputError(
    `props.${ICON_KEY} \u5FC5\u987B\u662F emoji \u5B57\u7B26\u4E32\u3001http(s) \u56FE\u7247 URL\u3001\u5DF2\u6784\u597D\u7684 Notion icon \u5BF9\u8C61\uFF0C\u6216 null\uFF08\u6E05\u9664\uFF09\uFF1B\u6536\u5230 ${describeValue(raw)}\u3002`,
    { property: ICON_KEY, value: raw }
  );
}
function normalizeProps(raw) {
  if (raw === void 0 || raw === null) return { hasBody: false };
  if (Array.isArray(raw)) {
    throw new InputError(
      'props \u5FC5\u987B\u662F\u5BF9\u8C61 map\uFF08{\u5C5E\u6027\u540D: \u503C}\uFF09\uFF0C\u4E0D\u662F\u6570\u7EC4\u3002\u4F8B\u5982 {"Status":"\u8FDB\u884C\u4E2D","\u6807\u7B7E":["a","b"]}\u3002'
    );
  }
  if (!isPlainObject(raw)) {
    throw new InputError(`props \u5FC5\u987B\u662F\u5BF9\u8C61 map\uFF08{\u5C5E\u6027\u540D: \u503C}\uFF09\uFF0C\u6536\u5230 ${describeValue(raw)}\u3002`);
  }
  const rest = {};
  let body;
  let hasBody = false;
  let icon;
  for (const [name2, value] of Object.entries(raw)) {
    if (name2 === BODY_CONTENT_KEY) {
      hasBody = true;
      if (value === void 0) continue;
      if (typeof value !== "string") {
        throw new InputError(
          `props.${BODY_CONTENT_KEY} \u5FC5\u987B\u662F Markdown \u5B57\u7B26\u4E32\uFF08\u9875\u9762\u6B63\u6587\uFF09\uFF0C\u6536\u5230 ${describeValue(value)}\u3002`,
          { property: BODY_CONTENT_KEY }
        );
      }
      body = value;
      continue;
    }
    if (name2 === ICON_KEY) {
      icon = normalizeIcon(value);
      continue;
    }
    if (value === void 0) continue;
    rest[name2] = value;
  }
  const entries = Object.entries(rest);
  return {
    ...entries.length ? { props: Object.fromEntries(entries) } : {},
    ...body !== void 0 ? { body } : {},
    hasBody,
    ...icon ? { icon } : {}
  };
}
function assertReservedKeysAvailable(schema, hasBody, icon) {
  const conflicts = [
    ...hasBody && schema.properties.has(BODY_CONTENT_KEY) ? [BODY_CONTENT_KEY] : [],
    ...icon && schema.properties.has(ICON_KEY) ? [ICON_KEY] : []
  ];
  if (conflicts.length === 0) return;
  const described = conflicts.map(
    (name2) => name2 === BODY_CONTENT_KEY ? `"${name2}"\uFF08\u4FDD\u7559\u952E\uFF1A\u9875\u9762\u6B63\u6587\uFF09` : `"${name2}"\uFF08\u4FDD\u7559\u952E\uFF1A\u9875\u9762 icon\uFF09`
  ).join("\u3001");
  throw new InputError(
    `data source \u91CC\u5B58\u5728\u540D\u4E3A ${described} \u7684\u771F\u5B9E\u5217\uFF0C\u4E0E\u4FDD\u7559\u952E\u540C\u540D\u3002\u4E0D\u80FD\u540C\u65F6\u5F53\u4F5C\u5217\u540D\u5199\u5165\uFF0C\u8BF7\u5148\u91CD\u547D\u540D\u8BE5\u5217\uFF0C\u6216\u4E0D\u4F7F\u7528\u8BE5\u4FDD\u7559\u952E\uFF1B\u672C\u6B21\u6CA1\u6709\u5199\u5165\u4EFB\u4F55\u5185\u5BB9\u3002`,
    {
      conflict: true,
      reserved_keys: conflicts,
      ...schema.dataSourceId ? { dataSourceId: schema.dataSourceId } : {}
    }
  );
}
function normalizeTitle(raw) {
  if (raw === void 0 || raw === null) return void 0;
  if (typeof raw !== "string") throw new InputError("title \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u3002");
  if (/[\r\n]/.test(raw)) throw new InputError("title \u4E0D\u80FD\u5305\u542B\u6362\u884C\u3002");
  const title = raw.trim();
  return title || void 0;
}
function parseParentSpec(raw, action) {
  const usage = action === "attach" ? "page:<id>\uFF08\u628A\u9875\u9762\u6302\u5230\u8BE5\u9875\u9762\u4E0B\uFF09\u6216\u7236\u884C id\uFF08\u628A\u884C\u6302\u5230\u7236\u884C\u4E0B\uFF09" : "page:<id>\u3001database:<id>\u3001data-source:<id>\uFF0C\u6216\u6570\u636E\u5E93\u884C id\uFF08\u4F5C\u4E3A\u5B50\u884C\u7236\u7EA7\uFF09";
  if (typeof raw !== "string" || !raw.trim()) {
    throw new InputError(`${action} \u9700\u8981 parent\uFF1A${usage}\u3002`);
  }
  const value = raw.trim();
  const match = /^(page|database|data[_-]?source)\s*:\s*(.+)$/i.exec(value);
  if (!match) {
    if (!isNotionId(value)) {
      throw new InputError(
        `parent \u683C\u5F0F\u65E0\u6548\uFF1A${describeValue(raw)}\u3002\u7528\u6CD5\uFF1A${usage}\u3002\u53EA\u63A5\u53D7 Notion id\uFF0832 \u4F4D hex \u6216 UUID\uFF0C\u4E0D\u8981\u8D34\u6574\u6761 URL\uFF09\u3002`
      );
    }
    return { bare: true, id: value };
  }
  const kindRaw = match[1].toLowerCase().replace("_", "-");
  const kind = kindRaw === "data-source" ? "data_source" : kindRaw;
  const id = match[2].trim();
  if (!isNotionId(id)) {
    throw new InputError(
      `parent \u91CC\u7684 id \u65E0\u6548\uFF1A${describeValue(match[2])}\u3002\u53EA\u63A5\u53D7 Notion id\uFF0832 \u4F4D hex \u6216 UUID\uFF0C\u4E0D\u8981\u8D34\u6574\u6761 URL\uFF09\uFF0C\u4F8B\u5982 data-source:716f546f-1824-45f0-b73a-481bf8b5f5db\u3002`
    );
  }
  return { bare: false, kind, id };
}
function requireId(raw, action) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new InputError(`${action} \u9700\u8981 id\uFF08\u9875\u9762 id\uFF0C32 \u4F4D hex \u6216\u5E26\u8FDE\u5B57\u7B26\u7684 UUID\uFF09\u3002`);
  }
  const id = raw.trim();
  if (!isNotionId(id)) {
    throw new InputError(
      `id \u65E0\u6548\uFF1A${describeValue(raw)}\u3002\u53EA\u63A5\u53D7 Notion \u9875\u9762 id\uFF0832 \u4F4D hex \u6216\u5E26\u8FDE\u5B57\u7B26\u7684 UUID\uFF09\uFF0C\u4E0D\u8981\u7528\u8DEF\u5F84\u6216 URL\u3002`
    );
  }
  return id;
}
var ALLOWED_PARAMS = {
  create: ["action", "parent", "title", "props"],
  edit: ["action", "id", "title", "props"],
  attach: ["action", "id", "parent", "yes"],
  trash: ["action", "id", "yes"]
};
var UNEXPECTED_PARAMS_MESSAGE = {
  create: "create \u53EA\u63A5\u53D7 { action, parent, title, props }\uFF08\u6B63\u6587\u5199\u5728 props.body_content\uFF09\u3002",
  edit: "edit \u53EA\u63A5\u53D7 { action, id, title, props }\uFF08\u6B63\u6587\u5199\u5728 props.body_content\uFF09\u3002",
  attach: "attach \u53EA\u63A5\u53D7 { action, id, parent, yes }\uFF0C\u4E0D\u63A5\u53D7 props/title\uFF08\u4E5F\u5C31\u6CA1\u6709 body_content\uFF09\uFF1B\u6539\u5185\u5BB9\u6216\u6807\u9898\u8BF7\u7528 edit\u3002yes \u53EA\u7528\u4E8E\u540C\u610F\u8986\u76D6\u5DF2\u6709\u7684 Parent-item \u94FE\u63A5\u3002",
  trash: "trash \u53EA\u63A5\u53D7 { action, id, yes }\u3002"
};
function rejectUnexpectedParams(params, action) {
  const allowed = ALLOWED_PARAMS[action];
  const unexpected = Object.keys(params).filter(
    (key) => params[key] !== void 0 && !allowed.includes(key)
  );
  if (unexpected.length > 0) {
    throw new InputError(
      `${UNEXPECTED_PARAMS_MESSAGE[action]} \u591A\u4F59\u7684\u53C2\u6570\uFF1A${unexpected.join(", ")}\u3002`,
      { unexpected_params: unexpected }
    );
  }
}
function parseJsonMaybe(stdout) {
  try {
    return parseJsonStdout(stdout);
  } catch {
    return void 0;
  }
}
function ntnFailure(label, result, note) {
  const detail = (result.stderr || result.stdout || "").trim();
  const exit = result.code === null ? "" : `\uFF08exit ${result.code}\uFF09`;
  return new NotionToolError(
    `${note ? `${note}\uFF1B` : ""}${label} \u5931\u8D25${exit}${detail ? `\uFF1A${truncate(detail)}` : ""}`,
    {
      code: NOTION_ERROR_CODES.ntnFailed,
      details: {
        stderr: result.stderr.trim(),
        stdout: truncate(result.stdout.trim()),
        code: result.code
      }
    }
  );
}
async function fetchDataSourceSchema(runner, dataSourceId) {
  const path = `v1/data_sources/${dataSourceId}`;
  const result = await runner({ args: ["api", path] });
  if (!result.ok) throw ntnFailure(`\u8BFB\u53D6\u5C5E\u6027 schema (${path})`, result);
  const parsed = parseJsonMaybe(result.stdout);
  const properties = extractSchemaProperties(parsed);
  if (!properties) {
    throw new InputError(
      `\u65E0\u6CD5\u4ECE ${path} \u8BFB\u53D6\u5C5E\u6027\u5217\u8868\uFF1A\u8BF7\u786E\u8BA4 id \u6B63\u786E\u3001Integration \u5DF2\u88AB\u9080\u8BF7\u5230\u8BE5\u6570\u636E\u5E93\uFF0C\u5E76\u4E14 parent \u7C7B\u578B\u5339\u914D\uFF08\u65B0\u7248\u6570\u636E\u5E93\u7528 data-source:<id>\uFF09\u3002`,
      { endpoint: path }
    );
  }
  return {
    source: "data_source",
    properties,
    dataSourceId: reportedDataSourceId(parsed, dataSourceId)
  };
}
async function resolveDatabaseDataSource(runner, databaseId) {
  const result = await runner({ args: ["datasources", "resolve", databaseId, "--json"] });
  if (!result.ok) {
    throw ntnFailure(`\u89E3\u6790 database ${databaseId} \u7684 data source`, result);
  }
  const refs = parseResolveDataSources(parseJsonMaybe(result.stdout));
  if (refs.length === 0) {
    throw new InputError(
      `database ${databaseId} \u6CA1\u6709\u8FD4\u56DE\u4EFB\u4F55 data source id\u3002\u8BF7\u786E\u8BA4 Integration \u5DF2\u88AB\u9080\u8BF7\uFF0C\u5E76\u6539\u7528 data-source:<id> \u6307\u5B9A\u3002`,
      { databaseId }
    );
  }
  if (refs.length > 1) {
    const lines = refs.map((ref) => `- ${ref.id}${ref.name ? ` (${ref.name})` : ""}`);
    throw new InputError(
      `database ${databaseId} \u6709 ${refs.length} \u4E2A data source\uFF0C\u9700\u8981\u552F\u4E00\u4E00\u4E2A\u624D\u80FD\u786E\u5B9A schema\u3002\u8BF7\u6539\u7528 parent: data-source:<id>\uFF0C\u53EF\u9009\uFF1A
${lines.join("\n")}`,
      { databaseId, data_source_ids: refs.map((ref) => ref.id) }
    );
  }
  return refs[0].id;
}
function parentFromPage(raw) {
  if (!isPlainObject(raw)) return void 0;
  const parent = isPlainObject(raw.parent) ? raw.parent : void 0;
  if (!parent) return void 0;
  const type = typeof parent.type === "string" ? parent.type : "";
  if (type === "data_source_id" && typeof parent.data_source_id === "string") {
    return { kind: "data_source", id: parent.data_source_id };
  }
  if (type === "database_id" && typeof parent.database_id === "string") {
    return { kind: "database", id: parent.database_id };
  }
  if (type === "page_id" || type === "workspace") {
    return { kind: "page", id: typeof parent.page_id === "string" ? parent.page_id : "" };
  }
  if (typeof parent.data_source_id === "string") {
    return { kind: "data_source", id: parent.data_source_id };
  }
  if (typeof parent.database_id === "string") {
    return { kind: "database", id: parent.database_id };
  }
  if (typeof parent.page_id === "string") {
    return { kind: "page", id: parent.page_id };
  }
  return void 0;
}
function pageObjectFrom(raw) {
  if (!isPlainObject(raw)) return { properties: {} };
  return {
    ...parentFromPage(raw) ? { parent: parentFromPage(raw) } : {},
    properties: isPlainObject(raw.properties) ? raw.properties : {}
  };
}
async function fetchPageObject(runner, pageId) {
  const result = await runner({ args: ["api", `v1/pages/${pageId}`] });
  if (!result.ok) throw ntnFailure(`\u8BFB\u53D6\u9875\u9762 ${pageId}`, result);
  return pageObjectFrom(parseJsonMaybe(result.stdout));
}
async function fetchPageParent(runner, pageId) {
  return (await fetchPageObject(runner, pageId)).parent;
}
function makePageReader(runner) {
  const cache = /* @__PURE__ */ new Map();
  return (pageId) => {
    const key = canonicalNotionId(pageId);
    let pending = cache.get(key);
    if (!pending) {
      pending = fetchPageObject(runner, pageId);
      cache.set(key, pending);
    }
    return pending;
  };
}
function relationIdsIn(page, propertyName) {
  const value = page.properties[propertyName];
  if (!isPlainObject(value) || !Array.isArray(value.relation)) return [];
  return value.relation.map((entry) => isPlainObject(entry) && typeof entry.id === "string" ? entry.id : "").filter((id) => id !== "");
}
var MAX_ANCESTOR_WALK = 100;
async function assertNoRowCycle(runner, readPage, options) {
  const { childId, parentId, relationName, dataSourceId } = options;
  const visited = /* @__PURE__ */ new Set();
  const queue = [parentId];
  const databaseDataSources = /* @__PURE__ */ new Map();
  while (queue.length > 0) {
    if (visited.size > MAX_ANCESTOR_WALK) {
      throw new InputError(
        `Parent-item \u7956\u5148\u94FE\u8D85\u8FC7 ${MAX_ANCESTOR_WALK} \u5C42\uFF0C\u65E0\u6CD5\u786E\u8BA4\u4E0D\u4F1A\u5F62\u6210\u73AF\uFF1B\u5DF2\u505C\u6B62\uFF0C\u672A\u5199\u5165\u3002`,
        { id: childId, parent: parentId, cycle_check: "too_deep" }
      );
    }
    const current = queue.shift();
    const key = canonicalNotionId(current);
    if (visited.has(key)) continue;
    visited.add(key);
    if (sameNotionId(current, childId)) {
      throw new InputError(
        `\u884C ${childId} \u4E0D\u80FD\u6302\u5230 ${parentId} \u4E0B\uFF1A\u90A3\u4F1A\u5F62\u6210 Parent-item \u73AF\uFF08${parentId} \u7684\u7956\u5148\u91CC\u6709 ${childId}\uFF09\u3002`,
        {
          id: childId,
          parent: parentId,
          cycle: true,
          cycle_path: [parentId, childId],
          cycle_check: "cycle"
        }
      );
    }
    let page;
    try {
      page = await readPage(current);
    } catch (error) {
      throw new InputError(
        `\u65E0\u6CD5\u8BFB\u53D6\u7956\u5148\u884C ${current}\uFF0C\u56E0\u6B64\u65E0\u6CD5\u786E\u8BA4\u628A ${childId} \u6302\u5230 ${parentId} \u4E0B\u4E0D\u4F1A\u5F62\u6210\u73AF\uFF1B\u5DF2\u5728\u5199\u5165\u524D\u505C\u6B62\u3002`,
        {
          id: childId,
          parent: parentId,
          ancestor: current,
          cycle_check: "unreadable",
          cause: error instanceof Error ? error.message : String(error)
        }
      );
    }
    const ancestorParent = page.parent;
    if (!ancestorParent || ancestorParent.kind === "page") break;
    let ancestorDataSourceId = ancestorParent.id;
    if (ancestorParent.kind === "database") {
      const cacheKey = canonicalNotionId(ancestorParent.id);
      const cached = databaseDataSources.get(cacheKey);
      if (cached) {
        ancestorDataSourceId = cached;
      } else {
        try {
          ancestorDataSourceId = await resolveDatabaseDataSource(runner, ancestorParent.id);
        } catch (error) {
          throw new InputError(
            `\u65E0\u6CD5\u786E\u8BA4\u7956\u5148\u884C ${current} \u6240\u5C5E\u7684 data source\uFF0C\u56E0\u6B64\u65E0\u6CD5\u786E\u8BA4\u628A ${childId} \u6302\u5230 ${parentId} \u4E0B\u4E0D\u4F1A\u5F62\u6210\u73AF\uFF1B\u5DF2\u5728\u5199\u5165\u524D\u505C\u6B62\u3002`,
            {
              id: childId,
              parent: parentId,
              ancestor: current,
              cycle_check: "unreadable",
              cause: error instanceof Error ? error.message : String(error)
            }
          );
        }
        databaseDataSources.set(cacheKey, ancestorDataSourceId);
      }
    }
    if (!sameNotionId(ancestorDataSourceId, dataSourceId)) break;
    queue.push(...relationIdsIn(page, relationName));
  }
}
async function walkPageAncestors(readPage, options) {
  const { childId, parentId } = options;
  const path = [];
  const visited = /* @__PURE__ */ new Set();
  let current = parentId;
  while (current && path.length <= MAX_ANCESTOR_WALK) {
    if (sameNotionId(current, childId)) return { cycle: [...path, current], status: "walked" };
    const key = canonicalNotionId(current);
    if (visited.has(key)) break;
    visited.add(key);
    path.push(current);
    let page;
    try {
      page = await readPage(current);
    } catch {
      return { cycle: null, status: "partial" };
    }
    if (!page.parent || page.parent.kind !== "page" || !page.parent.id) break;
    current = page.parent.id;
  }
  if (sameNotionId(current, childId)) return { cycle: [...path, current], status: "walked" };
  return { cycle: null, status: path.length > MAX_ANCESTOR_WALK ? "partial" : "walked" };
}
async function dataSourceIdForParent(runner, parent) {
  return parent.kind === "data_source" ? parent.id : resolveDatabaseDataSource(runner, parent.id);
}
async function schemaForPage(runner, pageId) {
  const parent = await fetchPageParent(runner, pageId);
  if (!parent || parent.kind === "page") return PAGE_SCHEMA;
  const dataSourceId = await dataSourceIdForParent(runner, parent);
  return fetchDataSourceSchema(runner, dataSourceId);
}
async function classifyBareParent(runner, id, action, readPage) {
  let page;
  try {
    page = readPage ? await readPage(id) : await fetchPageObject(runner, id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InputError(
      `\u65E0\u6CD5\u628A ${id} \u5F53\u4F5C parent\uFF1A\u8BFB\u53D6\u5B83\u4F5C\u4E3A\u9875\u9762\u5931\u8D25${detail ? `\uFF08${truncate(detail, 300)}\uFF09` : ""}\u3002${action} \u7684\u88F8 id \u5FC5\u987B\u662F\u9875\u9762\u6216\u6570\u636E\u5E93\u884C\uFF1B\u5982\u679C\u5B83\u662F database \u6216 data source\uFF0C\u8BF7\u5199\u6210 database:<id> / data-source:<id>\u3002`,
      { parent: id }
    );
  }
  const parent = page.parent;
  if (!parent) {
    throw new InputError(
      `\u65E0\u6CD5\u628A ${id} \u5F53\u4F5C parent\uFF1AGET v1/pages \u6CA1\u6709\u8FD4\u56DE parent\u3002${action} \u7684\u88F8 id \u5FC5\u987B\u662F\u9875\u9762\u6216\u6570\u636E\u5E93\u884C\uFF1B\u5982\u679C\u5B83\u662F database \u6216 data source\uFF0C\u8BF7\u5199\u6210 database:<id> / data-source:<id>\u3002`,
      { parent: id }
    );
  }
  if (parent.kind === "page") return { kind: "page" };
  return { kind: "row", schemaParent: parent };
}
async function resolveContainer(runner, raw, action, readPage) {
  const spec = parseParentSpec(raw, action);
  if (spec.bare) {
    const target = await classifyBareParent(runner, spec.id, action, readPage);
    if (target.kind === "page") {
      return { kind: "page", createParent: { kind: "page", id: spec.id }, schema: PAGE_SCHEMA };
    }
    const dataSourceId2 = await dataSourceIdForParent(runner, target.schemaParent);
    return {
      kind: "row",
      createParent: { kind: "data_source", id: dataSourceId2 },
      schema: await fetchDataSourceSchema(runner, dataSourceId2),
      dataSourceId: dataSourceId2,
      rowParentId: spec.id
    };
  }
  if (spec.kind === "page") {
    return { kind: "page", createParent: { kind: "page", id: spec.id }, schema: PAGE_SCHEMA };
  }
  const dataSourceId = spec.kind === "data_source" ? spec.id : await resolveDatabaseDataSource(runner, spec.id);
  return {
    kind: "data_source",
    createParent: { kind: "data_source", id: dataSourceId },
    schema: await fetchDataSourceSchema(runner, dataSourceId),
    dataSourceId
  };
}
function richText(content) {
  return content === "" ? [] : [{ type: "text", text: { content } }];
}
function requireString(prop, value) {
  if (typeof value !== "string") {
    throw new InputError(
      `\u5C5E\u6027 "${prop.name}" (${prop.type}) \u9700\u8981\u5B57\u7B26\u4E32\uFF0C\u6536\u5230 ${describeValue(value)}\u3002`,
      { property: prop.name, expected: prop.type }
    );
  }
  return value;
}
function stringList(prop, value) {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.filter((item) => item.trim() !== "");
  }
  throw new InputError(
    `\u5C5E\u6027 "${prop.name}" (${prop.type}) \u9700\u8981 string[]\uFF0C\u6536\u5230 ${describeValue(value)}\u3002`,
    { property: prop.name, expected: "string[]" }
  );
}
function titleText(value) {
  if (typeof value === "string") return value.trim() || void 0;
  if (Array.isArray(value)) {
    const text2 = value.map((part) => {
      if (!isPlainObject(part) || !isPlainObject(part.text)) return "";
      return typeof part.text.content === "string" ? part.text.content : "";
    }).join("");
    return text2.trim() || void 0;
  }
  if (isPlainObject(value) && "title" in value) return titleText(value.title);
  return void 0;
}
function buildPropertyValue(prop, value) {
  if (value === null) {
    switch (prop.type) {
      case "number":
        return { number: null };
      case "select":
        return { select: null };
      case "status":
        return { status: null };
      case "date":
        return { date: null };
      case "url":
        return { url: null };
      case "email":
        return { email: null };
      case "phone_number":
        return { phone_number: null };
      case "rich_text":
        return { rich_text: [] };
      case "multi_select":
        return { multi_select: [] };
      case "people":
        return { people: [] };
      case "relation":
        return { relation: [] };
      case "title":
        throw new InputError(`\u5C5E\u6027 "${prop.name}" \u662F\u6807\u9898\uFF0C\u4E0D\u80FD\u8BBE\u4E3A null\u3002`, { property: prop.name });
      default:
        throw new InputError(`\u5C5E\u6027 "${prop.name}" (${prop.type}) \u4E0D\u652F\u6301\u7528 null \u6E05\u7A7A\u3002`, {
          property: prop.name,
          expected: prop.type
        });
    }
  }
  if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, prop.type)) {
    return { [prop.type]: value[prop.type] };
  }
  switch (prop.type) {
    case "title": {
      const text2 = requireString(prop, value);
      if (!text2.trim()) throw new InputError(`\u6807\u9898\u5C5E\u6027 "${prop.name}" \u4E0D\u80FD\u4E3A\u7A7A\u3002`, { property: prop.name });
      return { title: richText(text2) };
    }
    case "rich_text": {
      let text2;
      if (typeof value === "string") {
        text2 = value;
      } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        text2 = value.join("\n");
      } else {
        throw new InputError(
          `\u5C5E\u6027 "${prop.name}" (rich_text) \u9700\u8981\u5B57\u7B26\u4E32\uFF0C\u6536\u5230 ${describeValue(value)}\u3002`,
          { property: prop.name, expected: "string" }
        );
      }
      return { rich_text: richText(text2) };
    }
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return { number: value };
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return { number: Number(value) };
      }
      throw new InputError(
        `\u5C5E\u6027 "${prop.name}" (number) \u9700\u8981\u6570\u5B57\uFF0C\u6536\u5230 ${describeValue(value)}\u3002`,
        { property: prop.name, expected: "number" }
      );
    }
    case "select":
    case "status": {
      const name2 = typeof value === "string" ? value : isPlainObject(value) && typeof value.name === "string" ? value.name : void 0;
      if (name2 === void 0) {
        throw new InputError(
          `\u5C5E\u6027 "${prop.name}" (${prop.type}) \u9700\u8981\u9009\u9879\u540D\u5B57\u7B26\u4E32\uFF0C\u6536\u5230 ${describeValue(value)}\u3002`,
          { property: prop.name, expected: "string" }
        );
      }
      return { [prop.type]: name2.trim() ? { name: name2 } : null };
    }
    case "multi_select": {
      return { multi_select: stringList(prop, value).map((name2) => ({ name: name2 })) };
    }
    case "date": {
      if (typeof value === "string") {
        const start = value.trim();
        return { date: start ? { start } : null };
      }
      if (isPlainObject(value) && typeof value.start === "string" && value.start.trim()) {
        const date = { start: value.start };
        if (typeof value.end === "string" && value.end.trim()) date.end = value.end;
        if (typeof value.time_zone === "string" && value.time_zone.trim()) {
          date.time_zone = value.time_zone;
        }
        return { date };
      }
      throw new InputError(
        `\u5C5E\u6027 "${prop.name}" (date) \u9700\u8981\u65E5\u671F\u5B57\u7B26\u4E32\u6216 {start,end}\uFF0C\u6536\u5230 ${describeValue(value)}\u3002`,
        { property: prop.name, expected: "string | {start,end}" }
      );
    }
    case "checkbox": {
      if (typeof value !== "boolean") {
        throw new InputError(
          `\u5C5E\u6027 "${prop.name}" (checkbox) \u9700\u8981 true/false\uFF0C\u6536\u5230 ${describeValue(value)}\u3002`,
          { property: prop.name, expected: "boolean" }
        );
      }
      return { checkbox: value };
    }
    case "url":
    case "email":
    case "phone_number": {
      const text2 = requireString(prop, value);
      return { [prop.type]: text2.trim() ? text2 : null };
    }
    case "people":
    case "relation": {
      const ids = stringList(prop, value);
      return { [prop.type]: ids.map((id) => ({ id })) };
    }
    default:
      throw new InputError(
        `\u5C5E\u6027 "${prop.name}" \u7684\u7C7B\u578B ${prop.type} \u6682\u4E0D\u652F\u6301\u901A\u8FC7\u7B80\u5316\u503C\u5199\u5165\uFF1B\u53EF\u6539\u7528 props \u91CC\u76F4\u63A5\u7ED9 Notion \u539F\u751F payload\uFF0C\u4F8B\u5982 {"${prop.name}": {"${prop.type}": ...}}\u3002`,
        { property: prop.name, type: prop.type }
      );
  }
}
function resolveProperty(schema, name2) {
  const prop = schema.properties.get(name2);
  const hints = writableProperties(schema);
  if (!prop) {
    throw new InputError(
      `\u672A\u77E5\u5C5E\u6027 "${name2}"\u3002\u53EF\u7528\u53EF\u5199\u5C5E\u6027\uFF1A${formatHints(hints)}\u3002`,
      { property: name2, hint_properties: hints }
    );
  }
  if (READ_ONLY_PROPERTY_TYPES.has(prop.type)) {
    throw new InputError(
      `\u5C5E\u6027 "${name2}" \u7684\u7C7B\u578B\u662F ${prop.type}\uFF08\u53EA\u8BFB\uFF09\uFF0C\u4E0D\u80FD\u5199\u5165\u3002\u53EF\u5199\u5C5E\u6027\uFF1A${formatHints(hints)}\u3002`,
      { property: name2, type: prop.type, hint_properties: hints }
    );
  }
  return prop;
}
function buildProperties(schema, props) {
  const properties = {};
  const names = [];
  let title;
  for (const [name2, value] of Object.entries(props)) {
    const prop = resolveProperty(schema, name2);
    properties[name2] = buildPropertyValue(prop, value);
    names.push(name2);
    if (prop.type === "title") title = titleText(value) ?? title;
  }
  return title ? { properties, names, title } : { properties, names };
}
function frontmatterTitle(markdown) {
  const block = FRONTMATTER_RE.exec(markdown);
  if (!block) return void 0;
  const match = /^title\s*:\s*(.+?)\s*$/m.exec(block[1]);
  if (!match) return void 0;
  const raw = match[1].trim();
  if (!raw) return void 0;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return normalizeTitle(JSON.parse(raw));
    } catch {
      return void 0;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return normalizeTitle(raw.slice(1, -1).replace(/''/g, "'"));
  }
  return normalizeTitle(raw);
}
function leadingH1(markdown) {
  const match = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(markdown);
  if (!match) return void 0;
  const title = normalizeTitle(match[1].replace(/\s+#+\s*$/, ""));
  if (!title) return void 0;
  const rest = markdown.slice(match[0].length).replace(/^\s*\r?\n/, "");
  return { title, rest };
}
function withFrontmatterTitle(markdown, title) {
  const line = `title: ${JSON.stringify(title)}`;
  const block = FRONTMATTER_RE.exec(markdown);
  if (block) {
    const lines = block[1].split(/\r?\n/);
    const index = lines.findIndex((entry) => /^title\s*:/.test(entry));
    if (index >= 0) lines[index] = line;
    else lines.unshift(line);
    return `---
${lines.join("\n")}
---

${markdown.slice(block[0].length)}`;
  }
  return `---
${line}
---

${markdown}`;
}
function planContent(markdown, titleHint) {
  const existingFrontmatterTitle = frontmatterTitle(markdown);
  const h1 = existingFrontmatterTitle ? void 0 : leadingH1(markdown);
  const title = titleHint ?? existingFrontmatterTitle ?? h1?.title;
  let body = markdown;
  if (h1 && title === h1.title) body = h1.rest;
  if (title) body = withFrontmatterTitle(body, title);
  return title ? { body, title } : { body };
}
function pageUrl(pageId) {
  return `https://app.notion.com/p/${pageId.replace(/-/g, "")}`;
}
function findPageId(value, depth = 0) {
  if (depth > 3 || value === null || value === void 0) return void 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPageId(item, depth + 1);
      if (found) return found;
    }
    return void 0;
  }
  if (!isPlainObject(value)) return void 0;
  for (const key of ["id", "page_id", "pageId"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && (UUID_RE.test(candidate) || HEX32_RE.test(candidate))) {
      return candidate;
    }
  }
  for (const key of ["page", "result", "data"]) {
    const found = findPageId(value[key], depth + 1);
    if (found) return found;
  }
  return void 0;
}
function findPageIdInText(text2) {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})/i.exec(text2);
  return match?.[1];
}
function pageUrlFromRaw(raw, pageId) {
  if (isPlainObject(raw) && typeof raw.url === "string" && raw.url.startsWith("http")) return raw.url;
  return pageUrl(pageId);
}
function patchArgs(pageId, properties, icon) {
  const body = {};
  if (Object.keys(properties).length > 0) body.properties = properties;
  if (icon) body.icon = icon.payload;
  return ["api", `v1/pages/${pageId}`, "-X", "PATCH", "--data", JSON.stringify(body)];
}
function describePageValue(value) {
  const props = value.properties.join(", ");
  if (value.action === "create") {
    return [
      `\u5DF2\u521B\u5EFA\u9875\u9762${value.title ? ` "${value.title}"` : ""}${value.id ? `\uFF1A${value.id}` : ""}`,
      value.url ? `URL: ${value.url}` : "",
      value.parent ? `parent: ${value.parent}` : "",
      value.parent_item_row_id ? `Parent-item \u2192 ${value.parent_item_row_id}` : "",
      value.properties.length ? `\u5DF2\u5199\u5165\u5C5E\u6027\uFF1A${props}` : "\u672A\u5199\u5165\u5C5E\u6027\uFF08props \u4E3A\u7A7A\uFF09",
      value.icon !== void 0 ? `icon: ${value.icon ?? "\uFF08\u5DF2\u6E05\u9664\uFF09"}` : ""
    ].filter(Boolean).join("\n");
  }
  if (value.action === "edit") {
    const what = value.changed.includes("body_content") ? "\u5185\u5BB9" : "\u5C5E\u6027";
    return [
      `\u5DF2\u66F4\u65B0\u9875\u9762 ${value.id} \u7684${what}`,
      value.url ? `URL: ${value.url}` : "",
      value.changed.includes("body_content") && value.changed.includes("properties") ? `\u5DF2\u5199\u5165\u5C5E\u6027\uFF1A${props}` : value.properties.length ? `\u5C5E\u6027\uFF1A${props}` : "",
      value.icon !== void 0 ? `icon: ${value.icon ?? "\uFF08\u5DF2\u6E05\u9664\uFF09"}` : ""
    ].filter(Boolean).join("\n");
  }
  if (value.action === "attach") {
    if (value.already_linked) {
      return [
        `\u884C ${value.id} \u5DF2\u7ECF\u5728\u7236\u884C ${value.parent_item_row_id} \u4E0B\uFF08Parent-item \u5217\uFF1A${value.parent_item_property}\uFF09\uFF0C\u65E0\u9700\u6539\u52A8`,
        value.url ? `URL: ${value.url}` : "",
        "changed: (none)"
      ].filter(Boolean).join("\n");
    }
    if (value.parent_item_property) {
      return [
        `\u5DF2\u628A\u884C ${value.id} \u6302\u5230\u7236\u884C ${value.parent_item_row_id} \u4E0B`,
        `Parent-item \u5217\uFF1A${value.parent_item_property}`,
        value.replaced_parent_ids?.length ? `\u66FF\u6362\u4E86\u539F\u6765\u7684\u7236\u7EA7\uFF1A${value.replaced_parent_ids.join(", ")}` : "",
        value.url ? `URL: ${value.url}` : ""
      ].filter(Boolean).join("\n");
    }
    return [
      `\u5DF2\u628A\u9875\u9762 ${value.id} \u6302\u5230 ${value.parent} \u4E0B`,
      value.url ? `URL: ${value.url}` : "",
      value.cycle_check === "partial" ? "\u6CE8\u610F\uFF1A\u9875\u9762\u7956\u5148\u94FE\u672A\u80FD\u5B8C\u6574\u8BFB\u53D6\uFF0C\u6DF1\u5C42\u73AF\u68C0\u67E5\u4E3A best-effort\uFF08cycle_check: partial\uFF09" : "",
      "changed: parent"
    ].filter(Boolean).join("\n");
  }
  return [`\u5DF2\u628A\u9875\u9762 ${value.id} \u79FB\u5165\u56DE\u6536\u7AD9`, value.url ? `URL: ${value.url}` : ""].filter(Boolean).join("\n");
}
function pageValue(action, fields) {
  return { ok: true, action, properties: [], ...fields };
}
function parentItemError(schema, dataSourceId) {
  const relations = relationProperties(schema);
  const hints = writableProperties(schema);
  const detail = relations.length ? `\u73B0\u6709 relation \u5217\uFF1A${relations.map(
    (prop) => prop.relationDataSourceId ? `${prop.name} \u2192 ${prop.relationDataSourceId}` : prop.name
  ).join(", ")}` : "\u8BE5 data source \u6CA1\u6709\u4EFB\u4F55 relation \u5217";
  return new InputError(
    `data source ${dataSourceId} \u6CA1\u6709\u53EF\u7528\u7684 Parent-item / \u81EA\u5173\u8054 relation \u5217\uFF0C\u65E0\u6CD5\u628A\u884C\u6302\u5230\u7236\u884C\u4E0B\uFF08${detail}\uFF09\u3002\u8BF7\u5728 Notion \u91CC\u4E3A\u8FD9\u4E2A\u5E93\u52A0\u4E00\u4E2A\u6307\u5411\u81EA\u8EAB\u7684 relation \u5C5E\u6027\uFF08\u9ED8\u8BA4\u540D Parent-item\uFF09\uFF0C\u6216\u7528 notion_get \u67E5\u770B\u73B0\u6709\u5217\u540E\u91CD\u8BD5\u3002`,
    {
      dataSourceId,
      hint_properties: hints,
      relation_properties: relations.map((prop) => prop.name)
    }
  );
}
function withRowParentRelation(properties, prop, parentRowId) {
  const current = properties[prop.name];
  const existing = isPlainObject(current) && Array.isArray(current["relation"]) ? current["relation"] : [];
  const merged = [...existing, { id: parentRowId }];
  properties[prop.name] = { relation: merged };
}
async function rollbackCreatedPage(runner, pageId, cause) {
  let trash;
  try {
    trash = await runner({ args: ["pages", "trash", pageId, "--yes"] });
  } catch (error) {
    trash = {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: null
    };
  }
  const detail = (trash.stderr || trash.stdout || "").trim();
  const partial = !trash.ok;
  const rollbackLine = partial ? `
\u56DE\u6EDA\u5931\u8D25\uFF1Antn pages trash ${pageId} \u4E5F\u5931\u8D25\u4E86${detail ? `\uFF08${truncate(detail, 300)}\uFF09` : ""}\uFF0C\u8BE5\u9875\u9762/\u884C\u4ECD\u7136\u5B58\u5728\uFF08partial: true\uFF09\u3002\u8BF7\u624B\u52A8\u6E05\u7406\uFF1Anotion_page { action: "trash", id: "${pageId}", yes: true }\u3002` : `
\u5DF2\u56DE\u6EDA\uFF1A\u65B0\u9875\u9762 ${pageId} \u5DF2\u79FB\u5165\u56DE\u6536\u7AD9\uFF08partial: false\uFF09\uFF0C\u6CA1\u6709\u7559\u4E0B\u534A\u6210\u54C1\u3002`;
  const details = {
    ...cause.details,
    partial,
    created_id: pageId,
    rollback: partial ? "trash_failed" : "trashed",
    rollback_code: trash.code,
    ...detail ? { rollback_error: truncate(detail, 600) } : {}
  };
  return new NotionToolError(`${cause.detail}${rollbackLine}`, {
    code: partial ? NOTION_ERROR_CODES.partialWrite : cause.code,
    details
  });
}
async function createPage(params, runner) {
  const { props, body, hasBody, icon } = normalizeProps(params.props);
  const explicitTitle = normalizeTitle(params.title);
  const readPage = makePageReader(runner);
  const container = await resolveContainer(runner, params.parent, "create", readPage);
  assertReservedKeysAvailable(container.schema, hasBody, icon);
  const markdown = body ?? "";
  let properties = {};
  let propertyNames = [];
  let propsTitle;
  if (props) {
    const built = buildProperties(container.schema, props);
    properties = built.properties;
    propertyNames = built.names;
    propsTitle = built.title;
    if (explicitTitle) {
      const titleName = titlePropertyName(container.schema);
      if (!titleName) {
        throw new InputError(
          `\u65E0\u6CD5\u786E\u5B9A ${container.schema.source} \u7684\u6807\u9898\u5C5E\u6027\uFF0C\u4E0D\u80FD\u7528 title \u6307\u5B9A\u6807\u9898\uFF1B\u8BF7\u6539\u7528 props \u5E76\u6307\u5B9A\u6807\u9898\u5C5E\u6027\u540D\u3002`
        );
      }
      properties[titleName] = { title: richText(explicitTitle) };
      if (!propertyNames.includes(titleName)) propertyNames.push(titleName);
    }
  }
  const draft = planContent(markdown, explicitTitle ?? propsTitle);
  const title = draft.title;
  if (container.kind !== "page" && !title) {
    const hints = writableProperties(container.schema);
    throw new InputError(
      `\u5728 ${container.kind === "row" ? `\u884C ${container.rowParentId} \u6240\u5728 data source` : container.kind} \u4E2D\u521B\u5EFA\u9875\u9762\u9700\u8981\u6807\u9898\uFF1A\u8BF7\u4F20 title\u3001\u5728 props \u91CC\u5199\u6807\u9898\u5C5E\u6027\uFF08${titlePropertyName(container.schema) ?? "title"}\uFF09\uFF0C\u6216\u8BA9 props.body_content \u4EE5 "# \u6807\u9898" \u5F00\u5934\u3002\u53EF\u5199\u5C5E\u6027\uFF1A${formatHints(hints)}\u3002`,
      { parent: formatParent(container.createParent), hint_properties: hints }
    );
  }
  if (!draft.body.trim()) {
    throw new InputError(
      "create \u9700\u8981 props.body_content \u6216 title\uFF1Antn pages create \u4E0D\u63A5\u53D7\u7A7A Markdown\uFF0C\u53EA\u6709 parent \u65E0\u6CD5\u521B\u5EFA\u7A7A\u767D\u9875\u9762\u3002"
    );
  }
  let rowRelationName;
  if (container.kind === "row") {
    const relation = findParentItemProperty(container.schema, container.dataSourceId);
    if (!relation) throw parentItemError(container.schema, container.dataSourceId);
    rowRelationName = relation.name;
    withRowParentRelation(properties, relation, container.rowParentId);
    if (!propertyNames.includes(relation.name)) propertyNames.push(relation.name);
  }
  const createResult = await runner({
    args: [
      "pages",
      "create",
      "--json",
      "--parent",
      formatParent(container.createParent),
      `--content=${draft.body}`
    ]
  });
  if (!createResult.ok) throw ntnFailure("ntn pages create", createResult);
  const created = parseJsonMaybe(createResult.stdout);
  const structuredId = findPageId(created);
  const textId = structuredId ? void 0 : findPageIdInText(createResult.stdout);
  const pageId = structuredId ?? textId;
  const url = pageId ? pageUrlFromRaw(created, pageId) : void 0;
  const needsPatch = propertyNames.length > 0 || icon !== void 0;
  if (needsPatch) {
    if (!structuredId) {
      throw new InputError(
        `\u9875\u9762\u5DF2\u521B\u5EFA\uFF08parent ${formatParent(container.createParent)}\uFF09\uFF0C\u4F46\u6CA1\u6709\u4ECE ntn \u7684\u7ED3\u6784\u5316\u8F93\u51FA\u91CC\u53D6\u5230\u9875\u9762 id\uFF0C${propertyNames.length > 0 ? "props \u548C icon \u90FD" : "icon"}\u672A\u5199\u5165\u3002\u6CA1\u6709\u53EF\u4FE1 id \u5C31\u4E0D\u81EA\u52A8 trash\uFF08\u907F\u514D\u8BEF\u5220\uFF09\uFF0C\u8BF7\u7528 notion_search/notion_get \u627E\u5230\u8BE5\u9875\u9762\u540E\uFF0C\u7528 notion_page edit \u5199\u5165\uFF0C\u6216 notion_page trash \u5220\u9664\uFF08partial: true\uFF0Crollback: unknown_id\uFF09\u3002`,
        {
          parent: formatParent(container.createParent),
          partial: true,
          rollback: "unknown_id",
          ...pageId ? { id_candidate: pageId } : {},
          stdout: truncate(createResult.stdout.trim())
        }
      );
    }
    const patchResult = await runner({ args: patchArgs(structuredId, properties, icon) });
    if (!patchResult.ok) {
      throw await rollbackCreatedPage(
        runner,
        structuredId,
        ntnFailure(
          "PATCH \u9875\u9762\u5C5E\u6027/icon",
          patchResult,
          container.kind === "row" ? `\u5B50\u884C\u5DF2\u521B\u5EFA\uFF08id ${structuredId}\uFF09\uFF0C\u4F46\u5C5E\u6027/Parent-item relation/icon \u672A\u5199\u5165` : `\u9875\u9762\u5DF2\u521B\u5EFA\uFF08id ${structuredId}\uFF09\uFF0C\u4F46\u5C5E\u6027/icon \u672A\u5199\u5165`
        )
      );
    }
  }
  return pageValue("create", {
    ...pageId ? { id: pageId } : {},
    ...url ? { url } : {},
    parent: formatParent(container.createParent),
    ...title ? { title } : {},
    ...container.kind === "row" ? {
      parent_item_row_id: container.rowParentId,
      ...rowRelationName ? { parent_item_property: rowRelationName } : {}
    } : {},
    ...icon ? { icon: icon.display } : {},
    properties: propertyNames,
    changed: [
      ...propertyNames.length > 0 || container.kind === "row" ? ["properties"] : [],
      ...icon ? ["icon"] : []
    ]
  });
}
async function editPage(params, runner) {
  const id = requireId(params.id, "edit");
  const { props, body, hasBody, icon } = normalizeProps(params.props);
  const explicitTitle = normalizeTitle(params.title);
  const markdown = body !== void 0 && body.trim() !== "" ? body : void 0;
  if (!markdown && !props && !explicitTitle && icon === void 0) {
    throw new InputError(
      "edit \u9700\u8981 props\uFF08\u542B props.body_content / props.icon\uFF09\u3001title \u6216 props.icon \u81F3\u5C11\u4E00\u9879\uFF1B\u7A7A\u8C03\u7528\u4E0D\u4F1A\u4FEE\u6539\u9875\u9762\u3002"
    );
  }
  const schema = await schemaForPage(runner, id);
  assertReservedKeysAvailable(schema, hasBody, icon);
  let properties = {};
  const propertyNames = [];
  if (props) {
    const built = buildProperties(schema, props);
    Object.assign(properties, built.properties);
    propertyNames.push(...built.names);
  }
  if (explicitTitle) {
    const titleName = titlePropertyName(schema);
    if (!titleName) {
      throw new InputError(
        `\u65E0\u6CD5\u786E\u5B9A\u9875\u9762 ${id} \u7684\u6807\u9898\u5C5E\u6027\uFF0C\u4E0D\u80FD\u7528 title \u6539\u6807\u9898\uFF1B\u8BF7\u6539\u7528 props \u5E76\u6307\u5B9A\u6807\u9898\u5C5E\u6027\u540D\u3002`
      );
    }
    properties[titleName] = { title: richText(explicitTitle) };
    if (!propertyNames.includes(titleName)) propertyNames.push(titleName);
  }
  if (markdown) {
    const editResult = await runner({ args: ["pages", "edit", id, `--content=${markdown}`, "--json"] });
    if (!editResult.ok) throw ntnFailure("ntn pages edit", editResult);
    const edited = parseJsonMaybe(editResult.stdout);
    if (propertyNames.length > 0 || icon !== void 0) {
      const patchResult2 = await runner({ args: patchArgs(id, properties, icon) });
      if (!patchResult2.ok) {
        throw ntnFailure(
          "PATCH \u9875\u9762\u5C5E\u6027/icon",
          patchResult2,
          `\u9875\u9762 ${id} \u5185\u5BB9\u5DF2\u66F4\u65B0\uFF0C\u4F46${propertyNames.length > 0 ? "\u5C5E\u6027" : ""}${propertyNames.length > 0 && icon ? "\u548C icon" : icon ? "icon" : ""}\u672A\u5199\u5165`
        );
      }
    }
    const url2 = pageUrlFromRaw(edited, id);
    return pageValue("edit", {
      id,
      ...url2 ? { url: url2 } : {},
      ...icon ? { icon: icon.display } : {},
      properties: propertyNames,
      changed: [
        "body_content",
        ...propertyNames.length > 0 ? ["properties"] : [],
        ...icon ? ["icon"] : []
      ]
    });
  }
  if (propertyNames.length === 0 && icon !== void 0) {
    const iconOnly = await runner({ args: patchArgs(id, {}, icon) });
    if (!iconOnly.ok) throw ntnFailure("PATCH \u9875\u9762 icon", iconOnly);
    const patchedIcon = parseJsonMaybe(iconOnly.stdout);
    const url2 = pageUrlFromRaw(patchedIcon, id);
    return pageValue("edit", {
      id,
      ...url2 ? { url: url2 } : {},
      icon: icon.display,
      properties: [],
      changed: ["icon"]
    });
  }
  const patchResult = await runner({ args: patchArgs(id, properties, icon) });
  if (!patchResult.ok) throw ntnFailure("PATCH \u9875\u9762\u5C5E\u6027/icon", patchResult);
  const patched = parseJsonMaybe(patchResult.stdout);
  const url = pageUrlFromRaw(patched, id);
  return pageValue("edit", {
    id,
    ...url ? { url } : {},
    ...icon ? { icon: icon.display } : {},
    properties: propertyNames,
    changed: [...propertyNames.length > 0 ? ["properties"] : [], ...icon ? ["icon"] : []]
  });
}
async function attachPage(params, runner) {
  const id = requireId(params.id, "attach");
  const spec = parseParentSpec(params.parent, "attach");
  if (!spec.bare && spec.kind !== "page") {
    throw new InputError(
      "attach \u7684 parent \u53EA\u652F\u6301 page:<id> \u6216\uFF08\u88F8\uFF09\u884C id\uFF1A\u9875\u9762\u6302\u5230\u9875\u9762\u4E0B\u7528 POST /v1/pages/{id}/move\uFF0C\u884C\u6302\u5230\u884C\u4E0B\u7528 Parent-item relation\u3002\u8981\u628A\u9875\u9762\u653E\u8FDB\u67D0\u4E2A data source\uFF0C\u8BF7\u7528 notion_page create\u3002"
    );
  }
  const readPage = makePageReader(runner);
  const container = await resolveContainer(runner, params.parent, "attach", readPage);
  const childPage = await readPage(id);
  const childParent = childPage.parent;
  if (!childParent) {
    throw new InputError(
      `\u65E0\u6CD5\u786E\u5B9A\u9875\u9762 ${id} \u7684\u5F53\u524D\u7236\u7EA7\uFF08GET v1/pages \u672A\u8FD4\u56DE parent\uFF09\u3002attach \u4E0D\u4F1A\u5728\u6CA1\u6709\u786E\u8BA4\u7684\u60C5\u51B5\u4E0B\u79FB\u52A8\u9875\u9762\u3002`,
      { id }
    );
  }
  if (container.kind === "page") {
    const targetParentId = container.createParent.id;
    if (sameNotionId(id, targetParentId)) {
      throw new InputError(`\u9875\u9762 ${id} \u4E0D\u80FD\u6302\u5230\u81EA\u5DF1\u4E0B\u9762\u3002`, { id, parent: targetParentId });
    }
    if (childParent.kind === "page" && sameNotionId(childParent.id, targetParentId)) {
      throw new InputError(`\u9875\u9762 ${id} \u5DF2\u7ECF\u662F ${targetParentId} \u7684\u5B50\u9875\u9762\uFF0C\u65E0\u9700 attach\u3002`, {
        id
      });
    }
    const cycle = await walkPageAncestors(readPage, { childId: id, parentId: targetParentId });
    if (cycle.cycle) {
      throw new InputError(
        `\u9875\u9762 ${id} \u4E0D\u80FD\u6302\u5230\u9875\u9762 ${targetParentId} \u4E0B\uFF1A\u4F1A\u5F62\u6210\u73AF\uFF08${cycle.cycle.join(" \u2192 ")}\uFF09\u3002`,
        { id, parent: targetParentId, cycle: true, cycle_path: cycle.cycle, cycle_check: "cycle" }
      );
    }
    const result = await runner({
      args: [
        "api",
        `v1/pages/${id}/move`,
        "-X",
        "POST",
        "--data",
        JSON.stringify({ parent: { page_id: targetParentId } })
      ]
    });
    if (!result.ok) throw ntnFailure(`\u628A\u9875\u9762 ${id} \u6302\u5230 ${targetParentId} \u4E0B`, result);
    const moved = parseJsonMaybe(result.stdout);
    const url2 = pageUrlFromRaw(moved, id);
    return pageValue("attach", {
      id,
      url: url2,
      parent: formatParent(container.createParent),
      cycle_check: cycle.status,
      properties: [],
      changed: ["parent"]
    });
  }
  if (container.kind !== "row") {
    throw new InputError("attach \u65E0\u6CD5\u628A\u9875\u9762\u6302\u5230 data source \u5BB9\u5668\u4E0B\uFF1B\u8BF7\u6539\u7528 create\u3002");
  }
  if (childParent.kind === "page") {
    throw new InputError(
      `\u9875\u9762 ${id} \u4E0D\u5728\u6570\u636E\u5E93\u91CC\uFF08\u7236\u7EA7\u662F\u9875\u9762${childParent.id ? ` ${childParent.id}` : ""}\uFF09\uFF0C\u4E0D\u80FD\u7528 Parent-item relation \u6302\u5230\u884C ${container.rowParentId} \u4E0B\uFF1Battach \u884C\u53EA\u9002\u7528\u4E8E\u540C\u4E00\u5E93\u5185\u7684\u884C\u3002`,
      { id, parentRowId: container.rowParentId }
    );
  }
  if (sameNotionId(id, container.rowParentId)) {
    throw new InputError(`\u884C ${id} \u4E0D\u80FD\u6302\u5230\u81EA\u5DF1\u4E0B\u9762\u3002`, { id });
  }
  const childDataSourceId = await dataSourceIdForParent(runner, childParent);
  if (!sameNotionId(childDataSourceId, container.dataSourceId)) {
    throw new InputError(
      `\u884C ${id} \u5C5E\u4E8E data source ${childDataSourceId}\uFF0C\u7236\u884C ${container.rowParentId} \u5C5E\u4E8E ${container.dataSourceId}\uFF1B\u81EA\u5173\u8054 Parent-item \u53EA\u80FD\u5728\u540C\u4E00 data source \u5185\u4F7F\u7528\uFF0C\u8DE8\u5E93\u8BF7\u6539\u7528 page \u7236\u7EA7\u6216 create\u3002`,
      { id, childDataSourceId, parentDataSourceId: container.dataSourceId }
    );
  }
  const relation = findParentItemProperty(container.schema, container.dataSourceId);
  if (!relation) throw parentItemError(container.schema, container.dataSourceId);
  const currentParents = relationIdsIn(childPage, relation.name);
  const parentAlreadySet = currentParents.some(
    (existing) => sameNotionId(existing, container.rowParentId)
  );
  if (parentAlreadySet && currentParents.length === 1) {
    return pageValue("attach", {
      id,
      url: pageUrl(id),
      parent: formatParent(container.createParent),
      parent_item_property: relation.name,
      parent_item_row_id: container.rowParentId,
      already_linked: true,
      properties: [],
      changed: []
    });
  }
  if (currentParents.length > 0 && params.yes !== true) {
    throw new InputError(
      `\u884C ${id} \u7684 ${relation.name}\uFF08Parent-item\uFF09\u5DF2\u7ECF\u6307\u5411 ${currentParents.join(", ")}\uFF0Cattach \u5230 ${container.rowParentId} \u4F1A\u8986\u76D6\u8FD9\u4E2A\u94FE\u63A5\u3002\u786E\u8BA4\u8981\u6539\u7236\u7EA7\u8BF7\u4F20 yes: true\uFF1B\u672C\u6B21\u6CA1\u6709\u5199\u5165\u3002`,
      {
        id,
        parent: formatParent(container.createParent),
        parent_item_property: relation.name,
        current_parent_ids: currentParents,
        overwrite: true
      }
    );
  }
  await assertNoRowCycle(runner, readPage, {
    childId: id,
    parentId: container.rowParentId,
    relationName: relation.name,
    dataSourceId: container.dataSourceId
  });
  const properties = { [relation.name]: { relation: [{ id: container.rowParentId }] } };
  const patchResult = await runner({ args: patchArgs(id, properties) });
  if (!patchResult.ok) throw ntnFailure(`\u8BBE\u7F6E ${relation.name}\uFF08Parent-item\uFF09relation`, patchResult);
  const patched = parseJsonMaybe(patchResult.stdout);
  const url = pageUrlFromRaw(patched, id);
  return pageValue("attach", {
    id,
    url,
    parent: formatParent(container.createParent),
    parent_item_property: relation.name,
    parent_item_row_id: container.rowParentId,
    ...currentParents.length > 0 ? { replaced_parent_ids: currentParents } : {},
    cycle_check: "walked",
    properties: [],
    changed: ["parent_item_relation"]
  });
}
async function trashPage(params, runner) {
  const id = requireId(params.id, "trash");
  if (params.yes !== true) {
    throw new InputError(
      "trash \u4F1A\u5220\u9664\uFF08\u79FB\u5165\u56DE\u6536\u7AD9\uFF09\u9875\u9762\uFF0C\u5FC5\u987B\u663E\u5F0F\u4F20 yes: true \u624D\u4F1A\u8C03\u7528 ntn\uFF1B\u672C\u6B21\u6CA1\u6709\u8C03\u7528 ntn\u3002"
    );
  }
  const result = await runner({ args: ["pages", "trash", id, "--yes"] });
  if (!result.ok) throw ntnFailure("ntn pages trash", result);
  return pageValue("trash", {
    id,
    url: pageUrl(id),
    properties: [],
    changed: ["trashed"]
  });
}
var PAGE_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["create", "edit", "attach", "trash"],
      description: "create | edit | attach | trash"
    },
    id: {
      type: "string",
      description: "Page or row id (required for edit/attach/trash; create takes its container from parent)."
    },
    parent: {
      type: "string",
      description: "create/attach: page:<id> | database:<id> | data-source:<id>, or a bare page/row id (a row id means a child row under that row). Attach only accepts page:<id> or a row id."
    },
    title: {
      type: "string",
      description: "Page title. create: sets the title (also used when props carry the title property). edit: updates the title property."
    },
    props: {
      type: "object",
      additionalProperties: true,
      description: 'Object map of property name \u2192 simplified value ({} = omit). Two reserved keys are page fields, not columns: body_content is the page Markdown body, and icon is the page icon (an emoji like "\u{1F3AF}", an http(s) image URL, or null to clear it). Examples: {"body_content":"# \u6807\u9898\\n\\n\u6B63\u6587","Status":"\u8FDB\u884C\u4E2D","\u6807\u7B7E":["a","b"],"\u622A\u6B62\u65E5\u671F":"2025-01-31","Done":true} and {"icon":"\u{1F3AF}"}.'
    },
    yes: {
      type: "boolean",
      description: "trash: must be true, otherwise the tool refuses without calling ntn. attach (row\u2192row): consent to replacing an existing Parent-item link that points at a different parent."
    }
  },
  required: ["action"],
  additionalProperties: false
};
var PAGE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean", const: true },
    action: { type: "string", enum: ["create", "edit", "attach", "trash"] },
    id: { type: "string" },
    url: { type: "string" },
    title: { type: "string" },
    parent: { type: "string" },
    properties: { type: "array", items: { type: "string" } },
    changed: { type: "array", items: { type: "string" } },
    icon: { oneOf: [{ type: "string" }, { type: "null" }] },
    parent_item_row_id: { type: "string" },
    parent_item_property: { type: "string" },
    already_linked: { type: "boolean" },
    replaced_parent_ids: { type: "array", items: { type: "string" } },
    cycle_check: { type: "string" }
  },
  required: ["ok", "action", "properties", "changed"],
  additionalProperties: false
};
function createNotionPageTool(deps = {}) {
  const runner = deps.runNtn ?? runNtn;
  return defineNotionTool({
    name: "notion_page",
    description: `Create, edit, attach (re-parent) or trash one Notion page. put the page Markdown in props.body_content and the page icon in props.icon; there is no top-level content or icon parameter. action=create needs parent: page:<id> | database:<id> | data-source:<id>, or a bare database row id (a child row, linked through the data source's Parent-item / self-relation column); props are applied by a second request, and a page in a database also needs a title (the title parameter, the title property in props, or a leading "# Heading" in props.body_content). If that second request fails the new page is trashed so no half-made page is left behind, and the error says whether cleanup succeeded: rollback reports trashed, trash_failed or unknown_id, and partial:true means something was left behind. action=edit needs id plus at least one of props (body_content / icon / columns) or title. action=attach needs id and parent and only re-parents: page\u2192page moves the page, row\u2192row sets the Parent-item relation, and it is not a file upload; it refuses cycle-forming moves and refuses to replace a different existing parent unless yes:true (the same parent is a no-op). action=trash needs id and yes:true, otherwise nothing is called. props is an object map keyed by property NAME (several keys = several properties, {} = no change), and its values are converted by the column type: unknown names and read-only columns are rejected with the writable columns in hint_properties. No default property values are invented.`,
    timeoutMs: TOOL_TIMEOUTS.page,
    // Every action can write (create/edit/attach/trash mutate the workspace), so
    // page calls stay exclusive: never overlap two of them.
    isConcurrencySafe: () => false,
    parameters: PAGE_PARAMETERS,
    output: {
      schema: PAGE_OUTPUT_SCHEMA,
      render: (_args, value) => textBlocks(describePageValue(value))
    },
    async execute(args, exec) {
      const raw = args;
      const action = raw.action;
      if (typeof action !== "string" || !Object.prototype.hasOwnProperty.call(ALLOWED_PARAMS, action)) {
        throw new InputError(
          `\u672A\u77E5 action ${describeValue(action)}\uFF1A\u53EA\u652F\u6301 create / edit / attach / trash\uFF08\u79FB\u52A8/\u6302\u8F7D\u7528 attach\uFF0C\u6CA1\u6709 move\uFF09\u3002`
        );
      }
      if (exec.signal?.aborted) throw abortError();
      const typedAction = action;
      rejectUnexpectedParams(raw, typedAction);
      const typed = args;
      const run = bindSignal(runner, exec.signal);
      if (typedAction === "create") return await createPage(typed, run);
      if (typedAction === "edit") return await editPage(typed, run);
      if (typedAction === "attach") return await attachPage(typed, run);
      return await trashPage(typed, run);
    }
  });
}

// src/tools/query.ts
var DEFAULT_QUERY_LIMIT = 25;
var MAX_QUERY_LIMIT = 100;
var QueryInputError = class extends Error {
  details;
  constructor(message, details = {}) {
    super(message);
    this.name = "QueryInputError";
    this.details = details;
  }
};
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function summarizeFailure(result, action) {
  const detail = (result.stderr || result.stdout).trim();
  const code = result.code === null ? "" : ` (exit ${result.code})`;
  return `${action} failed${code}: ${detail || "no output from ntn"}`;
}
function normalizeLimit(limit) {
  const value = limit ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(value)) {
    throw new Error(`limit must be an integer, got ${String(limit)}.`);
  }
  if (value <= 0) {
    throw new Error(`limit must be greater than 0, got ${value}.`);
  }
  return Math.min(value, MAX_QUERY_LIMIT);
}
function normalizeSort(sort) {
  if (sort === void 0) return [];
  const raw = Array.isArray(sort) ? sort : [sort];
  const specs = [];
  for (const item of raw) {
    const spec = item.trim();
    if (!spec) throw new Error("sort entries must be non-empty 'Property asc|desc' strings.");
    specs.push(spec);
  }
  return specs;
}
function buildQueryArgs(target, options) {
  const args = ["datasources", "query", target, "--limit", String(options.limit), "--json"];
  if (options.startCursor) args.push("--start-cursor", options.startCursor);
  if (options.filter !== void 0) args.push("--filter", JSON.stringify(options.filter));
  for (const spec of options.sorts) args.push("--sort", spec);
  return args;
}
function normalizeRow(row, index) {
  if (!isRecord3(row)) {
    throw new Error(`ntn datasources query returned result #${index + 1} that is not an object.`);
  }
  if (typeof row.id !== "string" || !row.id) {
    throw new Error(`ntn datasources query returned result #${index + 1} without an id.`);
  }
  return {
    id: row.id,
    url: typeof row.url === "string" ? row.url : null,
    properties: isRecord3(row.properties) ? row.properties : {}
  };
}
function parseQueryResponse(raw, target) {
  const payload = Array.isArray(raw) ? { results: raw, next_cursor: null, has_more: false } : isRecord3(raw) ? raw : null;
  if (!payload) {
    throw new Error(`ntn datasources query returned no JSON object for ${target}.`);
  }
  if (!Array.isArray(payload.results)) {
    throw new Error(`ntn datasources query response for ${target} has no results array.`);
  }
  const nextCursor = typeof payload.next_cursor === "string" && payload.next_cursor ? payload.next_cursor : null;
  return {
    results: payload.results.map(normalizeRow),
    next_cursor: nextCursor,
    // Trust a cursor even if a CLI version omits has_more: silent truncation is worse than one
    // extra call. Notion itself sets next_cursor to null when has_more is false.
    has_more: payload.has_more === true || nextCursor !== null
  };
}
function describeDataSources(target, dataSources) {
  const lines = dataSources.map((ds) => `- ${ds.id}${ds.name ? ` (${ds.name})` : ""}`);
  return `Database ${target} has ${dataSources.length} data sources. Pass one of these data source IDs as database_or_data_source:
` + lines.join("\n");
}
async function resolveDataSources(target, runner) {
  const resolved = await runner({ args: ["datasources", "resolve", target, "--json"] });
  if (!resolved.ok) return [];
  try {
    return parseResolveDataSources(parseJsonStdout(resolved.stdout));
  } catch {
    return [];
  }
}
async function fetchDataSourceSchema2(runner, dataSourceId) {
  const result = await runner({ args: ["api", `v1/data_sources/${dataSourceId}`] });
  if (!result.ok) return void 0;
  let parsed;
  try {
    parsed = parseJsonStdout(result.stdout);
  } catch {
    return void 0;
  }
  const properties = extractSchemaProperties(parsed);
  if (!properties) return void 0;
  return { dataSourceId: reportedDataSourceId(parsed, dataSourceId), properties };
}
async function schemaForTarget(target, runner) {
  const candidate = extractNotionId(target);
  if (candidate) {
    const direct = await fetchDataSourceSchema2(runner, candidate);
    if (direct) return direct;
  }
  const resolved = await resolveDataSources(candidate ?? target, runner);
  if (resolved.length > 1) {
    throw new QueryInputError(describeDataSources(target, resolved), {
      target,
      data_source_ids: resolved.map((dataSource) => dataSource.id)
    });
  }
  if (resolved.length === 0) {
    throw new QueryInputError(
      `\u65E0\u6CD5\u8BFB\u53D6 ${target} \u7684\u5C5E\u6027 schema\uFF08\u65E0\u6CD5\u76F4\u63A5\u8BFB\u53D6 data source\uFF0Cdatasources resolve \u4E5F\u5931\u8D25\uFF09\u3002under \u9700\u8981 data source schema \u624D\u80FD\u627E\u5230 Parent-item \u5217\uFF1A\u8BF7\u4F20 data source id\uFF0C\u6216\u786E\u8BA4 Integration \u5DF2\u88AB\u9080\u8BF7\u3002`,
      { target }
    );
  }
  const schema = !candidate || !sameNotionId(resolved[0].id, candidate) ? await fetchDataSourceSchema2(runner, resolved[0].id) : void 0;
  if (!schema) {
    throw new QueryInputError(
      `\u65E0\u6CD5\u4ECE data source ${resolved[0].id} \u8BFB\u53D6\u5C5E\u6027\u5217\u8868\uFF08GET v1/data_sources/${resolved[0].id} \u5931\u8D25\uFF09\u3002under \u9700\u8981\u8BE5 schema \u624D\u80FD\u627E\u5230 Parent-item \u5217\uFF1B\u8BF7\u786E\u8BA4 id \u6B63\u786E\u3001Integration \u5DF2\u88AB\u9080\u8BF7\u3002`,
      { target, dataSourceId: resolved[0].id }
    );
  }
  return schema;
}
function collectFilterProperties(filter, out = /* @__PURE__ */ new Set()) {
  if (Array.isArray(filter)) {
    for (const item of filter) collectFilterProperties(item, out);
    return out;
  }
  if (!isRecord3(filter)) return out;
  if (typeof filter.property === "string") out.add(filter.property);
  for (const key of ["and", "or"]) {
    if (filter[key] !== void 0) collectFilterProperties(filter[key], out);
  }
  return out;
}
async function filterUnder(params, target, runner) {
  const raw = params.under;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new QueryInputError("under \u5FC5\u987B\u662F\u7236\u884C id \u6216 Notion URL\uFF08\u975E\u7A7A\u5B57\u7B26\u4E32\uFF09\u3002", { under: raw });
  }
  const underId = extractNotionId(raw);
  if (!underId) {
    throw new QueryInputError(
      `under \u91CC\u6CA1\u6709\u53EF\u8BC6\u522B\u7684 Notion \u884C id\uFF1A${JSON.stringify(raw)}\u3002\u8BF7\u4F20\u7236\u884C id\uFF0832 \u4F4D hex \u6216 UUID\uFF09\u6216\u5176 Notion URL\u3002`,
      { under: raw }
    );
  }
  const schema = await schemaForTarget(target, runner);
  const property = selectParentItemProperty(schema.properties.values(), schema.dataSourceId);
  if (!property) {
    const hints = [...schema.properties.values()].filter((entry) => isWritablePropertyType(entry.type)).map((entry) => ({ name: entry.name, type: entry.type }));
    const relations = [...schema.properties.values()].filter((entry) => entry.type === "relation").map((entry) => entry.name);
    throw new QueryInputError(
      `data source ${schema.dataSourceId} \u6CA1\u6709\u53EF\u7528\u7684 Parent-item / \u81EA\u5173\u8054 relation \u5217\uFF0C\u65E0\u6CD5\u7528 under \u7B5B\u5B50\u884C\uFF08${relations.length ? `\u73B0\u6709 relation \u5217\uFF1A${relations.join(", ")}` : "\u8BE5 data source \u6CA1\u6709\u4EFB\u4F55 relation \u5217"}\uFF09\u3002\u8BF7\u6539\u7528 filter \u663E\u5F0F\u8FC7\u6EE4\uFF0C\u6216\u5148\u4E3A\u8BE5\u5E93\u52A0\u4E00\u4E2A\u6307\u5411\u81EA\u8EAB\u7684 relation \u5C5E\u6027\u3002`,
      {
        target,
        dataSourceId: schema.dataSourceId,
        hint_properties: hints,
        relation_properties: relations
      }
    );
  }
  const underFilter = { property: property.name, relation: { contains: underId } };
  const callerFilter = params.filter;
  if (callerFilter === void 0 || Object.keys(callerFilter).length === 0) {
    return underFilter;
  }
  const referenced = collectFilterProperties(callerFilter);
  if (referenced.has(property.name)) {
    throw new QueryInputError(
      `filter \u5DF2\u7ECF\u5728\u8FC7\u6EE4 ${property.name} \u5217\uFF0C\u800C under \u4E5F\u8981\u7528\u5B83\u7B5B\u7236\u884C ${underId}\uFF1A\u4E24\u4E2A relation \u6761\u4EF6\u4E0D\u80FD\u81EA\u52A8\u5408\u5E76\u3002\u8BF7\u53EA\u7528 under\uFF08\u53BB\u6389 filter \u91CC\u90A3\u4E00\u6761\uFF09\uFF0C\u6216\u4E0D\u7528 under\u3001\u81EA\u5DF1\u5199\u5B8C\u6574\u7684 relation filter\u3002`,
      {
        target,
        dataSourceId: schema.dataSourceId,
        parent_item_property: property.name,
        under_id: underId,
        conflicting_property: property.name
      }
    );
  }
  return { and: [underFilter, callerFilter] };
}
async function attachMarkdown(rows, runner) {
  for (const row of rows) {
    const page = await runner({ args: ["pages", "get", row.id] });
    if (page.ok) {
      row.markdown = page.stdout;
    } else {
      row.markdown_error = summarizeFailure(page, `ntn pages get ${row.id}`);
    }
  }
}
async function queryDataSource(params, runner = runNtn) {
  const target = params.database_or_data_source?.trim();
  if (!target) {
    throw new Error("database_or_data_source must be a non-empty data source/database id or URL.");
  }
  const limit = normalizeLimit(params.limit);
  const sorts = normalizeSort(params.sort);
  const startCursor = params.start_cursor?.trim() || void 0;
  const callerFilter = params.filter;
  if (callerFilter !== void 0 && !isRecord3(callerFilter)) {
    throw new QueryInputError("filter must be a Notion filter JSON object.");
  }
  const underFilter = params.under === void 0 ? void 0 : await filterUnder(params, target, runner);
  const filter = underFilter ?? callerFilter;
  const options = { limit, startCursor, filter, sorts };
  let query = await runner({ args: buildQueryArgs(target, options) });
  if (!query.ok) {
    const resolved = await resolveDataSources(target, runner);
    if (resolved.length > 1) {
      throw new Error(describeDataSources(target, resolved));
    }
    if (resolved.length === 1 && resolved[0].id !== target) {
      const retry = await runner({ args: buildQueryArgs(resolved[0].id, options) });
      if (retry.ok) {
        query = retry;
      } else {
        throw new Error(
          `${summarizeFailure(query, `ntn datasources query ${target}`)}; retry with data source ${resolved[0].id} also failed: ${summarizeFailure(
            retry,
            "ntn datasources query"
          )}`
        );
      }
    } else {
      throw new Error(summarizeFailure(query, `ntn datasources query ${target}`));
    }
  }
  let result;
  try {
    result = parseQueryResponse(parseJsonStdout(query.stdout), target);
  } catch (error) {
    throw new Error(
      `Could not parse ntn datasources query output for ${target}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (params.include_content === true) {
    await attachMarkdown(result.results, runner);
  }
  return result;
}
var QUERY_PARAMETERS = {
  type: "object",
  properties: {
    database_or_data_source: {
      type: "string",
      minLength: 1,
      description: "Notion data source id, database id, or Notion URL. If the database has multiple data sources, pass one data source id explicitly."
    },
    limit: {
      type: "integer",
      description: `Max rows per page (default ${DEFAULT_QUERY_LIMIT}, clamped to ${MAX_QUERY_LIMIT}).`
    },
    start_cursor: {
      oneOf: [{ type: "string" }, { type: "null" }],
      description: "Pagination cursor from a previous response's next_cursor. Omit for the first page."
    },
    filter: {
      type: "object",
      additionalProperties: true,
      description: "Raw Notion filter JSON object, passed through verbatim."
    },
    under: {
      type: "string",
      description: "Only rows linked to this parent row (id or Notion URL), filtered through the data source's Parent-item / self-relation column. Combined with filter via AND; refuses when filter already targets that same relation column."
    },
    sort: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      description: 'Sort spec "Property asc|desc", or an ordered array of specs for multiple sorts.'
    },
    include_content: {
      type: "boolean",
      description: "Also fetch each row's Markdown with ntn pages get (default false; one extra call per row)."
    }
  },
  required: ["database_or_data_source"],
  additionalProperties: false
};
var QUERY_OUTPUT_SCHEMA = {
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
          markdown_error: { type: "string" }
        },
        required: ["id", "url", "properties"],
        additionalProperties: false
      }
    },
    next_cursor: { oneOf: [{ type: "string" }, { type: "null" }] },
    has_more: { type: "boolean" }
  },
  required: ["results", "next_cursor", "has_more"],
  additionalProperties: false
};
function renderQueryResult(result) {
  return JSON.stringify(result, null, 2);
}
function createNotionQueryTool(deps = {}) {
  const runner = deps.runNtn ?? runNtn;
  return defineNotionTool({
    name: "notion_query",
    description: `Query the rows of a known Notion data source (or database) with a Notion filter, sort specs and cursor pagination; returns rows, next_cursor and has_more. This is not keyword search: find the data source with notion_search first when you only know a title, and read its schema with notion_get. Pass filter as a raw Notion filter JSON object and sort as "Property asc|desc" or an array of those. Use under to list only the child rows of one parent row; it filters the data source's Parent-item column and is ANDed with filter, so do not also filter that column in filter. When has_more is true, call again with next_cursor as start_cursor instead of raising limit, which is capped at 100. include_content defaults to false and costs one extra ntn pages get call per row.`,
    timeoutMs: TOOL_TIMEOUTS.query,
    // Read-only: safe to run alongside sibling calls.
    isConcurrencySafe: () => true,
    parameters: QUERY_PARAMETERS,
    output: {
      schema: QUERY_OUTPUT_SCHEMA,
      render: (_args, value) => textBlocks(renderQueryResult(value))
    },
    async execute(args, exec) {
      try {
        if (exec.signal?.aborted) throw abortError();
        return await queryDataSource(
          args,
          bindSignal(runner, exec.signal)
        );
      } catch (error) {
        if (error instanceof QueryInputError) {
          throw new NotionToolError(error.message, { code: NOTION_ERROR_CODES.invalidInput, details: error.details });
        }
        throw error;
      }
    }
  });
}

// src/tools/search.ts
var DEFAULT_LIMIT = 10;
var MAX_LIMIT = 25;
var SEARCH_PATH = "v1/search";
var defaultDeps = { run: runNtn };
function normalizeQuery(query) {
  const value = typeof query === "string" ? query.trim() : "";
  if (!value) {
    throw new Error(
      "notion_search requires a non-empty query: pass a keyword. Notion search matches titles (page/database names), not page body text."
    );
  }
  return value;
}
function normalizeLimit2(limit) {
  if (limit === void 0) return DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new Error(
      `notion_search limit must be a positive integer (got ${String(limit)}). Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`
    );
  }
  const value = Math.trunc(limit);
  if (value <= 0) {
    throw new Error(
      `notion_search limit must be >= 1 (got ${limit}). Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`
    );
  }
  return Math.min(value, MAX_LIMIT);
}
function buildSearchBody(params) {
  const body = { query: params.query, page_size: params.limit };
  if (params.filter_object) {
    body.filter = {
      property: "object",
      // Notion 2025-09 起把 database 改名为 data_source；旧值会被接口判非法。
      value: params.filter_object === "database" ? "data_source" : "page"
    };
  }
  return body;
}
function buildSearchArgs(body) {
  return ["api", SEARCH_PATH, "--data", JSON.stringify(body)];
}
function plainText2(rich) {
  if (typeof rich === "string") return rich;
  if (!Array.isArray(rich)) return "";
  let text2 = "";
  for (const item of rich) {
    if (typeof item === "string") {
      text2 += item;
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item;
    if (typeof record.plain_text === "string") text2 += record.plain_text;
    else if (typeof record.text?.content === "string") text2 += record.text.content;
  }
  return text2;
}
function extractTitle2(object) {
  const properties = object.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const value of Object.values(properties)) {
      if (!value || typeof value !== "object") continue;
      const property = value;
      if (property.type !== "title") continue;
      const text2 = plainText2(property.title).trim();
      if (text2) return text2;
    }
  }
  return plainText2(object.title).trim();
}
function normalizeHit(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const object = raw;
  const id = typeof object.id === "string" ? object.id : "";
  if (!id) return null;
  const rawObject = typeof object.object === "string" ? object.object : "";
  return {
    id,
    title: extractTitle2(object),
    url: typeof object.url === "string" ? object.url : "",
    // 对外统一用 page / database（与 filter_object 同一套词），未知值原样保留
    object: rawObject === "data_source" ? "database" : rawObject || "unknown"
  };
}
function snippet(text2) {
  const trimmed = text2.trim();
  if (!trimmed) return "<empty>";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}\u2026` : trimmed;
}
function parseSearchResponse(stdout) {
  let payload;
  try {
    payload = parseJsonStdout(stdout);
  } catch {
    throw new Error(`notion_search could not parse ntn output as JSON: ${snippet(stdout)}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`notion_search got unexpected ntn output: ${snippet(stdout)}`);
  }
  const record = payload;
  if (record.results !== void 0 && !Array.isArray(record.results)) {
    throw new Error(`notion_search got unexpected ntn output (results is not an array): ${snippet(stdout)}`);
  }
  const rawResults = Array.isArray(record.results) ? record.results : [];
  const results = rawResults.map((item) => normalizeHit(item)).filter((hit) => hit !== null);
  return { results, hasMore: record.has_more === true };
}
var FAILURE_HINTS = [
  {
    match: /not found on PATH|ENOENT/i,
    hint: "Hint: install the Notion CLI with `npm i -g ntn` (or `curl -fsSL https://ntn.dev | bash`), then run `ntn login`."
  },
  // token 那条必须排在 workspace 之前：ntn 的 token 错误文案里**也**带 "run `ntn login`"，
  // 顺序反过来就会被 workspace 提示吞掉，而且 workspace 提示并不解决无效 token。
  {
    match: /api token is invalid|unauthorized|\b401\b/i,
    hint: "Hint: the token was rejected \u2014 set a valid NOTION_API_TOKEN or run `ntn login`, and make sure the target pages/databases are shared with that integration."
  },
  {
    match: /no workspace selected|not logged in|not authenticated/i,
    hint: "Hint: authenticate first \u2014 run `ntn login`, or set NOTION_API_TOKEN (plus NOTION_WORKSPACE_ID). Then share the target pages/databases with that integration."
  }
];
function describeFailure(result) {
  const stderr = result.stderr.trim();
  const status = result.code === null ? "no exit code (timed out or could not start)" : `exit ${result.code}`;
  const hint = FAILURE_HINTS.find((entry) => entry.match.test(stderr))?.hint;
  const detail = stderr ? snippet(stderr) : "ntn printed no error text.";
  return [`notion_search failed: ntn ${status}.`, detail, hint].filter((part) => Boolean(part)).join("\n");
}
async function searchNotion(params, runner = defaultDeps.run) {
  const query = normalizeQuery(params.query);
  const limit = normalizeLimit2(params.limit);
  const body = buildSearchBody({ query, limit, filter_object: params.filter_object });
  const result = await runner({ args: buildSearchArgs(body) });
  if (!result.ok) throw new Error(describeFailure(result));
  const { results, hasMore } = parseSearchResponse(result.stdout);
  return { query, limit, results: results.slice(0, limit), hasMore };
}
function formatOutcome(outcome) {
  const header = `Notion search "${outcome.query}": ${outcome.results.length} result(s) (limit ${outcome.limit}).`;
  const body = outcome.results.length === 0 ? ["No matches. Notion search matches titles only \u2014 try a shorter keyword or another language of the title."] : outcome.results.map((hit, index) => {
    const title = hit.title || "(untitled)";
    const url = hit.url ? `
   ${hit.url}` : "";
    return `${index + 1}. ${hit.object} \xB7 ${title}
   id: ${hit.id}${url}`;
  });
  const footer = outcome.hasMore && outcome.results.length > 0 ? ["More results exist upstream: narrow the query or raise limit (max 25)."] : [];
  return [header, ...body, ...footer].join("\n");
}
function createNotionSearchTool(deps = {}) {
  const runner = deps.run ?? defaultDeps.run;
  return defineNotionTool({
    name: "notion_search",
    description: "Search the Notion workspace by title and return every hit's id, title, URL and object type (page|database). Titles only: page body text is never searched, so pass a short keyword rather than a sentence, and use filter_object to cut noise. Read a hit with notion_get; a returned database's id is a data source id for notion_query. Refine the query instead of raising limit, which is capped at 25.",
    timeoutMs: TOOL_TIMEOUTS.search,
    // Read-only and independent of every other call: safe to run alongside siblings.
    isConcurrencySafe: () => true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Title keyword to match, searched verbatim (not full-text page search)."
        },
        limit: {
          type: "integer",
          description: `Max results (default ${DEFAULT_LIMIT}). Values above ${MAX_LIMIT} are clamped to ${MAX_LIMIT}.`
        },
        filter_object: {
          type: "string",
          enum: ["page", "database"],
          description: "Restrict hits to pages or databases (data sources). Omit to search both."
        }
      },
      required: ["query"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer" },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                url: { type: "string" },
                object: { type: "string" }
              },
              required: ["id", "title", "url", "object"],
              additionalProperties: false
            }
          },
          hasMore: { type: "boolean" }
        },
        required: ["query", "limit", "results", "hasMore"],
        additionalProperties: false
      },
      render: (_args, outcome) => textBlocks(formatOutcome(outcome))
    },
    async execute(args, exec) {
      const params = args;
      try {
        const query = normalizeQuery(params.query);
        const limit = normalizeLimit2(params.limit);
        if (exec.signal?.aborted) throw abortError();
        return await searchNotion(
          { query, limit, filter_object: params.filter_object },
          bindSignal(runner, exec.signal)
        );
      } catch (error) {
        throw codedError(error);
      }
    }
  });
}

// src/dsh/config.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
var PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url));
var DEFAULT_NTN_PATH = "/opt/homebrew/bin/ntn";
var DEFAULT_TIMEOUT_MS = 6e4;
var DEFAULT_TOKEN_FILE = "notion-token";
var PLACEHOLDER = /^(paste|your|replace|todo|secret_xxx$|<)/i;
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
function resolveTokenFile(raw) {
  if (!raw) return join(PLUGIN_ROOT, DEFAULT_TOKEN_FILE);
  if (raw.startsWith("/")) return raw;
  return join(PLUGIN_ROOT, expandHome(raw));
}
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function isPlaceholderToken(value) {
  return PLACEHOLDER.test(value.trim());
}
function readConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const timeout = number(config.timeoutMs);
  return {
    tokenFile: resolveTokenFile(text(config.tokenFile)),
    workspaceId: text(config.workspaceId),
    ntnPath: text(config.ntnPath) || DEFAULT_NTN_PATH,
    timeoutMs: timeout !== void 0 && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS
  };
}
function resolveToken(config) {
  const fromEnv = text(process.env.NOTION_API_TOKEN);
  if (fromEnv && !isPlaceholderToken(fromEnv)) return fromEnv;
  let contents;
  try {
    contents = readFileSync(config.tokenFile, "utf8");
  } catch {
    return "";
  }
  const line = contents.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.length > 0 && !entry.startsWith("#")) ?? "";
  if (!line) return "";
  if (isPlaceholderToken(line)) {
    throw new Error(
      `Notion token is not configured yet: set the NOTION_API_TOKEN environment variable, or edit ${config.tokenFile} and replace the placeholder with your integration token (starts with "secret_" or "ntn_"), or delete that file and run \`ntn login\` instead.`
    );
  }
  return line;
}

// src/dsh/runner.ts
import { existsSync } from "node:fs";
import { dirname } from "node:path";
var KNOWN_NTN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
function ntnDir(config) {
  for (const candidate of [config.ntnPath, ...KNOWN_NTN_DIRS]) {
    if (candidate && existsSync(candidate)) return dirname(candidate);
  }
  return void 0;
}
function makeRunner(getConfig) {
  return async (options) => {
    const config = getConfig();
    const token = resolveToken(config);
    const env = { ...options.env };
    if (token) env.NOTION_API_TOKEN = token;
    if (config.workspaceId) env.NOTION_WORKSPACE_ID = config.workspaceId;
    const binDir = ntnDir(config);
    if (binDir) env.PATH = [binDir, process.env.PATH].filter(Boolean).join(":");
    return runNtn({
      ...options,
      timeoutMs: options.timeoutMs ?? config.timeoutMs,
      env
    });
  };
}

// src/dsh/index.ts
var name = "notion-tools";
var inject = ["tools"];
function apply(ctx, config) {
  const run = makeRunner(() => readConfig(config));
  ctx.tools.register(createNotionSearchTool({ run }));
  ctx.tools.register(createNotionGetTool(run));
  ctx.tools.register(createNotionPageTool({ runNtn: run }));
  ctx.tools.register(createNotionQueryTool({ runNtn: run }));
}
export {
  apply,
  inject,
  name
};
