/**
 * notion_page_create / notion_page_edit / notion_page_trash — three tools, one page operation each.
 *
 * Every `ntn` invocation goes through {@link NtnRunner} (default: `src/lib/runNtn.ts`).
 * The model never gets a free-form `ntn api` call: the only API paths used here are
 *   GET   v1/pages/{id}                       (read a page's parent + property values)
 *   GET   v1/data_sources/{id}                (property schema; a database has no schema in 2025-09+)
 *   PATCH v1/pages/{id}                       (property whitelist + icon)
 *   PATCH v1/pages/{id}/markdown              (find-and-replace body text, or append markdown)
 *   POST  v1/pages/{id}/move                  (re-parent a page under a page)
 *   GET   v1/blocks/{id}/children             (enumerate child pages before a trash)
 *   POST  v1/pages, ntn pages create/trash    (via the CLI's own verbs)
 *   `ntn datasources resolve <db-id>`         (database id → its unique data source)
 * and each is built from a validated id, never from raw model text.
 *
 * Three tools rather than one `notion_page` with an `action` parameter: each surfaces only
 * the arguments its operation accepts, so a create cannot carry an `old_str` and an edit
 * cannot carry `recursive` by mistake.
 *
 * Page-level fields are TOP-LEVEL parameters, never `props` keys:
 *   - `icon`         : an emoji ("🎯"), an http(s) image URL, an already-typed Notion icon
 *                      object, or `null` to clear it.
 *   - `body_content` : the page Markdown body.
 *   `props` is ONLY database columns. A data source that really has a column named `icon`
 *   or `body_content` gets that column written when the caller uses `props.icon` /
 *   `props.body_content`; nothing is reserved.
 *
 * Property write rules:
 *   - `props` is an OBJECT map of property NAME → simplified value. Multiple keys
 *     mean multiple properties; `{}` is treated as "omit" (no PATCH).
 *   - The value is converted according to the property TYPE from the parent
 *     database/data-source schema:
 *       title / rich_text : string                    → { title | rich_text: [{type:"text",text:{content}}] }
 *       number            : number | numeric string   → { number }
 *       select / status   : string | { name }         → { select | status: { name } }   ("" or null clears)
 *       multi_select      : string[] (or one string)  → { multi_select: [{ name }, ...] }
 *       date              : "YYYY-MM-DD" | ISO string → { date: { start } }
 *                           | { start, end?, time_zone? } → { date: { start, end?, time_zone? } }
 *       checkbox          : boolean                   → { checkbox }
 *       url/email/phone   : string                    → { url | email | phone_number } ("" or null clears)
 *       people / relation : string[] of ids           → { people | relation: [{ id }, ...] }
 *     Passing null clears the property where Notion allows it. An object that
 *     already contains its own type key (e.g. `{ select: { name: "Done" } }`)
 *     is passed through as-is, as an escape hatch for advanced values.
 *   - Unknown names, read-only types (formula/rollup/created_time/last_edited_*)
 *     and type mismatches are rejected with `hint_properties` (the writable columns).
 *   - No default values are invented (no implicit Status/anything). A regular
 *     page with empty props is fine; a database page still needs a title.
 *
 * Parent resolution (create, and edit's move):
 *   page:<id>          child page under that page
 *   <bare page id>     same, after checking the id is not a database row
 *   <bare row id>      child row in the row's data source + Parent-item relation set
 *   data-source:<id>   peer row in that data source
 *   database:<id>      resolved through `ntn datasources resolve` to its unique data
 *                      source (several → error listing the ids, never a guess)
 *
 * Moving an existing page (edit with `parent`, NOT a file upload, not a rename):
 *   page → page : POST v1/pages/{id}/move
 *   row  → row  : PATCH the Parent-item / self-relation column of the moved row
 *
 * Move guards (survived from the old `attach` action):
 *   - row→row refuses cycles: walk the Parent-item chain up from the prospective parent
 *     inside the same data source; an unreadable ancestor refuses instead of guessing.
 *   - row→row refuses to replace a different existing parent unless `yes: true`; the
 *     overwrite REPLACES the relation. Re-moving to the same parent is a no-op.
 *   - page→page refuses self and already-child; deeper page cycles use a best-effort
 *     `parent.page_id` walk (GET per ancestor) and report `cycle_check`.
 *
 * Edit's content write is FIND-AND-REPLACE (`PATCH .../markdown`, `type: "update_content"`):
 * it never rewrites the whole page, so there is no "did this wipe the page" guard left to
 * run and no shrink confirmation to collect. `body_content` with no `edits` APPENDS.
 *
 * Create is two writes (pages create + one property/Parent-item/icon PATCH or one markdown
 * append). If the follow-up write fails the new page is trashed immediately; the error
 * carries `partial` (false when the workspace is clean again), `created_id`, and
 * `rollback` ("trashed" | "trash_failed" | "unknown_id"). Only a structured JSON page id
 * is ever used as a trash target.
 */
import {
  abortError,
  bindSignal,
  defineNotionTool,
  inputError,
  NOTION_ERROR_CODES,
  NotionToolError,
  readBoolean,
  textBlocks,
  TOOL_TIMEOUTS,
} from "../dsh/tool.ts";
import type { JsonObject, NotionTool } from "../dsh/tool.ts";
import { parseResolveDataSources } from "../lib/datasources.ts";
import { extractNotionId } from "../lib/ids.ts";
import {
  canonicalNotionId,
  isWritablePropertyType,
  sameNotionId,
  selectParentItemProperty,
  READ_ONLY_PROPERTY_TYPES,
} from "../lib/properties.ts";
import { parseJsonStdout, runNtn } from "../lib/runNtn.ts";
import type { RunNtnOptions, RunNtnResult } from "../lib/runNtn.ts";
import {
  extractSchemaProperties,
  reportedDataSourceId,
  type SchemaProperty,
} from "../lib/schema.ts";

export type NtnRunner = (options: RunNtnOptions) => Promise<RunNtnResult>;
export type NotionPageDeps = {
  /** Injected for tests; production always spawns the real `ntn`. */
  runNtn?: NtnRunner;
};

type ParentKind = "page" | "database" | "data_source";

/** Which operation a helper is resolving arguments for; only used in messages. */
type PageOp = "create" | "edit" | "trash";

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_RE = /^[0-9a-f]{32}$/i;

function isNotionId(value: string): boolean {
  return UUID_RE.test(value) || HEX32_RE.test(value);
}

/**
 * Validation failure the model can correct: reported as the call's error, without a stack.
 *
 * Kept as a named subclass (rather than calling {@link inputError} everywhere) so every
 * throw site in this file reads the same and the `InputError` name is preserved in tests.
 */
class InputError extends NotionToolError {
  constructor(message: string, details: JsonObject = {}) {
    super(message, { code: NOTION_ERROR_CODES.invalidInput, details });
    this.name = "InputError";
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return (text ?? String(value)).slice(0, 80);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max = 1200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatParent(parent: ParsedParent): string {
  return `${parent.kind === "data_source" ? "data-source" : parent.kind}:${parent.id}`;
}

/** Reject a parameter this operation does not accept, instead of silently ignoring it. */
function rejectUnexpectedParams(params: JsonObject, allowed: readonly string[], usage: string): void {
  const unexpected = Object.keys(params).filter(
    (key) => params[key] !== undefined && !allowed.includes(key)
  );
  if (unexpected.length > 0) {
    throw new InputError(`${usage} 多余的参数：${unexpected.join(", ")}。`, {
      unexpected_params: unexpected,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Property schema plumbing
 * ------------------------------------------------------------------ */

interface ParsedParent {
  kind: ParentKind;
  id: string;
}

interface ParentSpec {
  bare: boolean;
  kind?: ParentKind;
  id: string;
}

type PropertySchema = SchemaProperty;

interface PropertySchemaSet {
  source: ParentKind;
  properties: Map<string, PropertySchema>;
  /** Present when the schema came from a data source (needed for self-relation checks). */
  dataSourceId?: string;
}

interface PropertyHint {
  name: string;
  type: string;
}

/**
 * Where a create should land, plus the schema needed to map `props`.
 * `row` means the parent is a database row, so the new page is a child row.
 */
type Container =
  | { kind: "page"; createParent: ParsedParent; schema: PropertySchemaSet }
  | {
      kind: "data_source";
      createParent: ParsedParent;
      schema: PropertySchemaSet;
      dataSourceId: string;
    }
  | {
      kind: "row";
      createParent: ParsedParent;
      schema: PropertySchemaSet;
      dataSourceId: string;
      rowParentId: string;
    };

/** Page children only expose their title property. */
const PAGE_SCHEMA: PropertySchemaSet = {
  source: "page",
  properties: new Map([["title", { name: "title", type: "title" }]]),
};

function writableProperties(schema: PropertySchemaSet): PropertyHint[] {
  return [...schema.properties.values()]
    .filter((prop) => isWritablePropertyType(prop.type))
    .map((prop) => ({ name: prop.name, type: prop.type }));
}

function formatHints(hints: PropertyHint[]): string {
  return hints.length ? hints.map((hint) => `${hint.name} (${hint.type})`).join(", ") : "(none)";
}

function titlePropertyName(schema: PropertySchemaSet): string | undefined {
  for (const prop of schema.properties.values()) {
    if (prop.type === "title") return prop.name;
  }
  return undefined;
}

function relationProperties(schema: PropertySchemaSet): PropertySchema[] {
  return [...schema.properties.values()].filter((prop) => prop.type === "relation");
}

/**
 * The column a move/child-row create writes. The selector itself lives in
 * `src/lib/properties.ts` so `notion_get` advertises exactly the same column.
 */
function findParentItemProperty(
  schema: PropertySchemaSet,
  dataSourceId: string
): PropertySchema | undefined {
  return selectParentItemProperty(schema.properties.values(), dataSourceId);
}

/* ------------------------------------------------------------------ *
 * Page-level arguments: icon and body
 * ------------------------------------------------------------------ */

/**
 * The page icon, already shaped the way `PATCH v1/pages/{id}` expects:
 *   "🎯"                 → { type: "emoji", emoji: "🎯" }
 *   "https://…/a.png"    → { type: "external", external: { url } }
 *   null                 → null (clear the icon)
 *   { type: "emoji", … } → passed through (escape hatch for custom_emoji / file icons)
 */
interface NormalizedIcon {
  /** The value to send as `icon`; null clears. */
  payload: JsonObject | null;
  /** Short label for the model-facing result. */
  display: string | null;
}

const HTTP_URL_RE = /^https?:\/\//i;
/** Notion icons are one emoji; anything long is a caller mistake, not an emoji. */
const MAX_EMOJI_LENGTH = 16;

/**
 * Normalize the top-level `icon` parameter.
 *
 * `undefined` means "not provided" (no icon write); `null` means "clear it". The two are
 * kept distinct because clearing is a write and omitting is not.
 */
function normalizeIcon(raw: unknown): NormalizedIcon | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return { payload: null, display: null };

  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) {
      throw new InputError(
        "icon 不能是空字符串：不设置 icon 就省略这个参数，清除已有 icon 请传 null。",
        { field: "icon" }
      );
    }
    if (HTTP_URL_RE.test(value)) {
      return { payload: { type: "external", external: { url: value } }, display: value };
    }
    if ([...value].length > MAX_EMOJI_LENGTH) {
      throw new InputError(
        `icon 看起来既不是 emoji 也不是图片 URL（长度 ${[...value].length}）：${describeValue(value)}。` +
          '请传单个 emoji（如 "🎯"）、http(s) 图片 URL，或 null 清除。',
        { field: "icon", value }
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
          'icon 的 emoji 对象缺少 emoji 文本：需要 { "type": "emoji", "emoji": "🎯" }。',
          { field: "icon" }
        );
      }
      return { payload: { type: "emoji", emoji }, display: emoji };
    }
    if (type === "external") {
      const url = isPlainObject(raw.external) ? raw.external.url : undefined;
      if (typeof url !== "string" || !HTTP_URL_RE.test(url.trim())) {
        throw new InputError(
          'icon 的 external 对象需要一个 http(s) url：' +
            '{ "type": "external", "external": { "url": "https://…/a.png" } }。',
          { field: "icon" }
        );
      }
      return { payload: { type: "external", external: { url: url.trim() } }, display: url.trim() };
    }
    if (type === "custom_emoji" || type === "file") {
      // Escape hatch: a caller that already knows the exact Notion payload wins.
      return { payload: raw, display: `${String(type)} icon` };
    }
    throw new InputError(
      'icon 的对象形式必须带 type：接受 "emoji" / "external" / "custom_emoji" / "file"，' +
        `或直接传 emoji 字符串、图片 URL、null。收到 ${describeValue(raw)}。`,
      { field: "icon", value: raw }
    );
  }

  throw new InputError(
    `icon 必须是 emoji 字符串、http(s) 图片 URL、已构好的 Notion icon 对象，或 null（清除）；` +
      `收到 ${describeValue(raw)}。`,
    { field: "icon", value: raw }
  );
}

/**
 * The top-level `body_content` parameter.
 *
 * `undefined`/`null` mean "not provided". A string is returned as authored: Markdown is
 * whitespace-sensitive, so trimming it would silently change what gets written.
 */
function normalizeBody(raw: unknown, required: boolean): string | undefined {
  if (raw === undefined || raw === null) {
    if (required) {
      throw new InputError("body_content 必须是 Markdown 字符串，不能是 null。", {
        field: "body_content",
      });
    }
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new InputError(`body_content 必须是 Markdown 字符串（页面正文），收到 ${describeValue(raw)}。`, {
      field: "body_content",
    });
  }
  return raw;
}

/**
 * `props` must be an object map of COLUMN → value. `{}`/absent means "no property write".
 * Arrays (the old/naive shape) are rejected explicitly, with the fix in the message.
 *
 * `icon` and `body_content` are NOT split out any more: they are top-level parameters, and
 * a data source column that happens to be named `icon` or `body_content` is an ordinary
 * column here. Nothing in this map is reserved.
 */
function normalizeProps(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    throw new InputError(
      "props 必须是对象 map（{属性名: 值}），不是数组。例如 {\"Status\":\"进行中\",\"标签\":[\"a\",\"b\"]}。"
    );
  }
  if (!isPlainObject(raw)) {
    throw new InputError(`props 必须是对象 map（{属性名: 值}），收到 ${describeValue(raw)}。`);
  }
  const entries = Object.entries(raw).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeTitle(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new InputError("title 必须是字符串。");
  if (/[\r\n]/.test(raw)) throw new InputError("title 不能包含换行。");
  const title = raw.trim();
  return title || undefined;
}

/* ------------------------------------------------------------------ *
 * Ids and parents
 * ------------------------------------------------------------------ */

function parseParentSpec(raw: unknown, op: "create" | "move"): ParentSpec {
  const usage =
    op === "move"
      ? "page:<id>（把页面挂到该页面下）或父行 id（把行挂到父行下）"
      : "page:<id>、database:<id>、data-source:<id>，或数据库行 id（作为子行父级）";
  if (typeof raw !== "string" || !raw.trim()) {
    throw new InputError(`${op === "move" ? "移动页面（parent）" : "create"} 需要 parent：${usage}。`);
  }
  const value = raw.trim();
  const match = /^(page|database|data[_-]?source)\s*:\s*(.+)$/i.exec(value);
  if (!match) {
    if (!isNotionId(value)) {
      throw new InputError(
        `parent 格式无效：${describeValue(raw)}。用法：${usage}。只接受 Notion id（32 位 hex 或 UUID，不要贴整条 URL）。`
      );
    }
    return { bare: true, id: value };
  }
  const kindRaw = match[1].toLowerCase().replace("_", "-");
  const kind: ParentKind = kindRaw === "data-source" ? "data_source" : (kindRaw as ParentKind);
  const id = match[2].trim();
  if (!isNotionId(id)) {
    throw new InputError(
      `parent 里的 id 无效：${describeValue(match[2])}。只接受 Notion id（32 位 hex 或 UUID，不要贴整条 URL），例如 data-source:716f546f-1824-45f0-b73a-481bf8b5f5db。`
    );
  }
  return { bare: false, kind, id };
}

/**
 * Resolve an `id` argument from an id, a bare 32-character hex, or a Notion URL.
 *
 * A caller holding a link hands over the link; that is one intent, not an error,
 * so the id is extracted rather than the call rejected. `extractNotionId` lives in
 * src/lib/ids.ts and already understands every Notion URL shape.
 */
function requireId(raw: unknown, op: PageOp): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new InputError(
      `${op} 需要 id：页面 id（32 位 hex 或带连字符的 UUID）或该页面的 Notion URL。`
    );
  }
  const text = raw.trim();
  if (isNotionId(text)) return text;
  const extracted = extractNotionId(text);
  if (extracted) return extracted;
  throw new InputError(
    `id 无效：${describeValue(raw)}。只接受 Notion 页面 id（32 位 hex / UUID）或该页面的 Notion URL。`
  );
}

/* ------------------------------------------------------------------ *
 * ntn calls
 * ------------------------------------------------------------------ */

function parseJsonMaybe(stdout: string): unknown {
  try {
    return parseJsonStdout(stdout);
  } catch {
    return undefined;
  }
}

function ntnFailure(label: string, result: RunNtnResult, note?: string): NotionToolError {
  const detail = (result.stderr || result.stdout || "").trim();
  const exit = result.code === null ? "" : `（exit ${result.code}）`;
  return new NotionToolError(
    `${note ? `${note}；` : ""}${label} 失败${exit}${detail ? `：${truncate(detail)}` : ""}`,
    {
      code: NOTION_ERROR_CODES.ntnFailed,
      details: {
        stderr: result.stderr.trim(),
        stdout: truncate(result.stdout.trim()),
        code: result.code,
      },
    }
  );
}

async function fetchDataSourceSchema(
  runner: NtnRunner,
  dataSourceId: string
): Promise<PropertySchemaSet> {
  const path = `v1/data_sources/${dataSourceId}`;
  const result = await runner({ args: ["api", path] });
  if (!result.ok) throw ntnFailure(`读取属性 schema (${path})`, result);

  const parsed = parseJsonMaybe(result.stdout);
  const properties = extractSchemaProperties(parsed);
  if (!properties) {
    throw new InputError(
      `无法从 ${path} 读取属性列表：请确认 id 正确、Integration 已被邀请到该数据库，并且 parent 类型匹配（新版数据库用 data-source:<id>）。`,
      { endpoint: path }
    );
  }
  return {
    source: "data_source",
    properties,
    dataSourceId: reportedDataSourceId(parsed, dataSourceId),
  };
}

/** Database id → unique data source id; several → error listing them, never a silent pick. */
async function resolveDatabaseDataSource(runner: NtnRunner, databaseId: string): Promise<string> {
  const result = await runner({ args: ["datasources", "resolve", databaseId, "--json"] });
  if (!result.ok) {
    throw ntnFailure(`解析 database ${databaseId} 的 data source`, result);
  }
  const refs = parseResolveDataSources(parseJsonMaybe(result.stdout));
  if (refs.length === 0) {
    throw new InputError(
      `database ${databaseId} 没有返回任何 data source id。请确认 Integration 已被邀请，并改用 data-source:<id> 指定。`,
      { databaseId }
    );
  }
  if (refs.length > 1) {
    const lines = refs.map((ref) => `- ${ref.id}${ref.name ? ` (${ref.name})` : ""}`);
    throw new InputError(
      `database ${databaseId} 有 ${refs.length} 个 data source，需要唯一一个才能确定 schema。` +
        `请改用 parent: data-source:<id>，可选：\n${lines.join("\n")}`,
      { databaseId, data_source_ids: refs.map((ref) => ref.id) }
    );
  }
  return refs[0].id;
}

/** Parent of an existing page, as returned by GET v1/pages/{id}. */
function parentFromPage(raw: unknown): ParsedParent | undefined {
  if (!isPlainObject(raw)) return undefined;
  const parent = isPlainObject(raw.parent) ? raw.parent : undefined;
  if (!parent) return undefined;

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

  // Older/newer payloads: fall back to whichever id field is present.
  if (typeof parent.data_source_id === "string") {
    return { kind: "data_source", id: parent.data_source_id };
  }
  if (typeof parent.database_id === "string") {
    return { kind: "database", id: parent.database_id };
  }
  if (typeof parent.page_id === "string") {
    return { kind: "page", id: parent.page_id };
  }
  return undefined;
}

/** What a move needs from GET v1/pages/{id}: the parent and the current property values. */
interface PageObject {
  parent?: ParsedParent;
  properties: JsonObject;
}

function pageObjectFrom(raw: unknown): PageObject {
  if (!isPlainObject(raw)) return { properties: {} };
  return {
    ...(parentFromPage(raw) ? { parent: parentFromPage(raw) } : {}),
    properties: isPlainObject(raw.properties) ? raw.properties : {},
  };
}

async function fetchPageObject(runner: NtnRunner, pageId: string): Promise<PageObject> {
  const result = await runner({ args: ["api", `v1/pages/${pageId}`] });
  if (!result.ok) throw ntnFailure(`读取页面 ${pageId}`, result);
  return pageObjectFrom(parseJsonMaybe(result.stdout));
}

async function fetchPageParent(runner: NtnRunner, pageId: string): Promise<ParsedParent | undefined> {
  return (await fetchPageObject(runner, pageId)).parent;
}

/**
 * Memoized page reader for one call: the parent row is fetched once for
 * classification and again by the cycle walk otherwise, wasting a round trip and
 * making the call count depend on how deep the tree happens to be.
 */
function makePageReader(runner: NtnRunner): (pageId: string) => Promise<PageObject> {
  const cache = new Map<string, Promise<PageObject>>();
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

/** Ids a page holds in a relation property (`{ relation: [{id}, ...] }`). */
function relationIdsIn(page: PageObject, propertyName: string): string[] {
  const value = page.properties[propertyName];
  if (!isPlainObject(value) || !Array.isArray(value.relation)) return [];
  return value.relation
    .map((entry) => (isPlainObject(entry) && typeof entry.id === "string" ? entry.id : ""))
    .filter((id) => id !== "");
}

/** Upper bound for walking a parent chain; a real hierarchy is far shallower. */
const MAX_ANCESTOR_WALK = 100;

/**
 * Refuse a row move that would close a Parent-item cycle.
 *
 * Walks up from the prospective parent through the same self-relation column, in the same
 * data source. A parent chain that cannot be read is refused too: the move must not write a
 * relation it could not verify (the alternative is a silent cycle).
 */
async function assertNoRowCycle(
  runner: NtnRunner,
  readPage: (pageId: string) => Promise<PageObject>,
  options: {
    childId: string;
    parentId: string;
    relationName: string;
    dataSourceId: string;
  }
): Promise<void> {
  const { childId, parentId, relationName, dataSourceId } = options;
  const visited = new Set<string>();
  const queue = [parentId];
  // Older payloads report `database_id`; resolve it once per database instead of failing open.
  const databaseDataSources = new Map<string, string>();

  while (queue.length > 0) {
    if (visited.size > MAX_ANCESTOR_WALK) {
      throw new InputError(
        `Parent-item 祖先链超过 ${MAX_ANCESTOR_WALK} 层，无法确认不会形成环；已停止，未写入。`,
        { id: childId, parent: parentId, cycle_check: "too_deep" }
      );
    }
    const current = queue.shift() as string;
    const key = canonicalNotionId(current);
    if (visited.has(key)) continue;
    visited.add(key);

    if (sameNotionId(current, childId)) {
      throw new InputError(
        `行 ${childId} 不能挂到 ${parentId} 下：那会形成 Parent-item 环（${parentId} 的祖先里有 ${childId}）。`,
        {
          id: childId,
          parent: parentId,
          cycle: true,
          cycle_path: [parentId, childId],
          cycle_check: "cycle",
        }
      );
    }

    let page: PageObject;
    try {
      page = await readPage(current);
    } catch (error) {
      throw new InputError(
        `无法读取祖先行 ${current}，因此无法确认把 ${childId} 挂到 ${parentId} 下不会形成环；已在写入前停止。`,
        {
          id: childId,
          parent: parentId,
          ancestor: current,
          cycle_check: "unreadable",
          cause: error instanceof Error ? error.message : String(error),
        }
      );
    }

    // Only rows of the same data source participate in this self-relation chain.
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
            `无法确认祖先行 ${current} 所属的 data source，因此无法确认把 ${childId} 挂到 ${parentId} 下不会形成环；已在写入前停止。`,
            {
              id: childId,
              parent: parentId,
              ancestor: current,
              cycle_check: "unreadable",
              cause: error instanceof Error ? error.message : String(error),
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

type PageCycleCheck = "walked" | "partial";

/**
 * Page→page move only refuses the cheap cases exactly (self, already-child); this walk
 * additionally catches deeper A→B→A cycles. It is best effort on purpose: if an ancestor
 * page cannot be read the move still happens, and the result reports
 * `cycle_check: "partial"` so the caller knows the walk was incomplete.
 */
async function walkPageAncestors(
  readPage: (pageId: string) => Promise<PageObject>,
  options: { childId: string; parentId: string }
): Promise<{ cycle: string[] | null; status: PageCycleCheck }> {
  const { childId, parentId } = options;
  const path: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = parentId;

  while (current && path.length <= MAX_ANCESTOR_WALK) {
    if (sameNotionId(current, childId)) return { cycle: [...path, current], status: "walked" };
    const key = canonicalNotionId(current);
    if (visited.has(key)) break;
    visited.add(key);
    path.push(current);

    let page: PageObject;
    try {
      page = await readPage(current);
    } catch {
      return { cycle: null, status: "partial" };
    }
    if (!page.parent || page.parent.kind !== "page" || !page.parent.id) break;
    current = page.parent.id;
  }
  if (sameNotionId(current, childId)) return { cycle: [...path, current as string], status: "walked" };
  return { cycle: null, status: path.length > MAX_ANCESTOR_WALK ? "partial" : "walked" };
}

async function dataSourceIdForParent(runner: NtnRunner, parent: ParsedParent): Promise<string> {
  return parent.kind === "data_source"
    ? parent.id
    : resolveDatabaseDataSource(runner, parent.id);
}

async function schemaForPage(runner: NtnRunner, pageId: string): Promise<PropertySchemaSet> {
  const parent = await fetchPageParent(runner, pageId);
  if (!parent || parent.kind === "page") return PAGE_SCHEMA;
  const dataSourceId = await dataSourceIdForParent(runner, parent);
  return fetchDataSourceSchema(runner, dataSourceId);
}

type BareTarget =
  | { kind: "page" }
  | { kind: "row"; schemaParent: ParsedParent };

/**
 * A bare id is either a page or a database row. Row ids are globally unique, so
 * looking the object up is the only reliable way to tell them apart.
 */
async function classifyBareParent(
  runner: NtnRunner,
  id: string,
  op: "create" | "move",
  readPage?: (pageId: string) => Promise<PageObject>
): Promise<BareTarget> {
  let page: PageObject;
  try {
    page = readPage ? await readPage(id) : await fetchPageObject(runner, id);
  } catch (error) {
    // Only a "this id is not a page" answer is the caller's mistake. An auth,
    // timeout or spawn failure says nothing about the id, and rewriting it as
    // INVALID_INPUT would send the model to change arguments that were fine —
    // and would nest a second [CODE] prefix inside the first. A coded error
    // passes through untouched so its own kind survives.
    if (error instanceof NotionToolError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new InputError(
      `无法把 ${id} 当作 parent：读取它作为页面失败${detail ? `（${truncate(detail, 300)}）` : ""}。` +
        `${op === "create" ? "create" : "移动页面"} 的裸 id 必须是页面或数据库行；如果它是 database 或 data source，请写成 database:<id> / data-source:<id>。`,
      { parent: id }
    );
  }
  const parent = page.parent;
  if (!parent) {
    throw new InputError(
      `无法把 ${id} 当作 parent：GET v1/pages 没有返回 parent。` +
        `${op === "create" ? "create" : "移动页面"} 的裸 id 必须是页面或数据库行；如果它是 database 或 data source，请写成 database:<id> / data-source:<id>。`,
      { parent: id }
    );
  }
  if (parent.kind === "page") return { kind: "page" };
  return { kind: "row", schemaParent: parent };
}

async function resolveContainer(
  runner: NtnRunner,
  raw: unknown,
  op: "create" | "move",
  readPage?: (pageId: string) => Promise<PageObject>
): Promise<Container> {
  const spec = parseParentSpec(raw, op);

  if (spec.bare) {
    const target = await classifyBareParent(runner, spec.id, op, readPage);
    if (target.kind === "page") {
      return { kind: "page", createParent: { kind: "page", id: spec.id }, schema: PAGE_SCHEMA };
    }
    const dataSourceId = await dataSourceIdForParent(runner, target.schemaParent);
    return {
      kind: "row",
      createParent: { kind: "data_source", id: dataSourceId },
      schema: await fetchDataSourceSchema(runner, dataSourceId),
      dataSourceId,
      rowParentId: spec.id,
    };
  }

  if (spec.kind === "page") {
    return { kind: "page", createParent: { kind: "page", id: spec.id }, schema: PAGE_SCHEMA };
  }

  const dataSourceId =
    spec.kind === "data_source" ? spec.id : await resolveDatabaseDataSource(runner, spec.id);
  return {
    kind: "data_source",
    createParent: { kind: "data_source", id: dataSourceId },
    schema: await fetchDataSourceSchema(runner, dataSourceId),
    dataSourceId,
  };
}



/* ------------------------------------------------------------------ *
 * Simplified value → Notion API property value
 * ------------------------------------------------------------------ */

function richText(content: string): unknown[] {
  return content === "" ? [] : [{ type: "text", text: { content } }];
}

function requireString(prop: PropertySchema, value: unknown): string {
  if (typeof value !== "string") {
    throw new InputError(
      `属性 "${prop.name}" (${prop.type}) 需要字符串，收到 ${describeValue(value)}。`,
      { property: prop.name, expected: prop.type }
    );
  }
  return value;
}

function stringList(prop: PropertySchema, value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return (value as string[]).filter((item) => item.trim() !== "");
  }
  throw new InputError(
    `属性 "${prop.name}" (${prop.type}) 需要 string[]，收到 ${describeValue(value)}。`,
    { property: prop.name, expected: "string[]" }
  );
}

/** Extract plain text from a title/rich_text value (string or raw Notion payload). */
function titleText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        if (!isPlainObject(part) || !isPlainObject(part.text)) return "";
        return typeof part.text.content === "string" ? part.text.content : "";
      })
      .join("");
    return text.trim() || undefined;
  }
  if (isPlainObject(value) && "title" in value) return titleText(value.title);
  return undefined;
}

function buildPropertyValue(prop: PropertySchema, value: unknown): JsonObject {
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
        throw new InputError(`属性 "${prop.name}" 是标题，不能设为 null。`, { property: prop.name });
      default:
        throw new InputError(`属性 "${prop.name}" (${prop.type}) 不支持用 null 清空。`, {
          property: prop.name,
          expected: prop.type,
        });
    }
  }

  // Escape hatch: caller already wrote the raw Notion payload for this type.
  if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, prop.type)) {
    return { [prop.type]: value[prop.type] };
  }

  switch (prop.type) {
    case "title": {
      const text = requireString(prop, value);
      if (!text.trim()) throw new InputError(`标题属性 "${prop.name}" 不能为空。`, { property: prop.name });
      return { title: richText(text) };
    }
    case "rich_text": {
      let text: string;
      if (typeof value === "string") {
        text = value;
      } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        text = (value as string[]).join("\n");
      } else {
        throw new InputError(
          `属性 "${prop.name}" (rich_text) 需要字符串，收到 ${describeValue(value)}。`,
          { property: prop.name, expected: "string" }
        );
      }
      return { rich_text: richText(text) };
    }
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return { number: value };
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return { number: Number(value) };
      }
      throw new InputError(
        `属性 "${prop.name}" (number) 需要数字，收到 ${describeValue(value)}。`,
        { property: prop.name, expected: "number" }
      );
    }
    case "select":
    case "status": {
      const name =
        typeof value === "string"
          ? value
          : isPlainObject(value) && typeof value.name === "string"
            ? value.name
            : undefined;
      if (name === undefined) {
        throw new InputError(
          `属性 "${prop.name}" (${prop.type}) 需要选项名字符串，收到 ${describeValue(value)}。`,
          { property: prop.name, expected: "string" }
        );
      }
      return { [prop.type]: name.trim() ? { name } : null };
    }
    case "multi_select": {
      return { multi_select: stringList(prop, value).map((name) => ({ name })) };
    }
    case "date": {
      if (typeof value === "string") {
        const start = value.trim();
        return { date: start ? { start } : null };
      }
      if (isPlainObject(value) && typeof value.start === "string" && value.start.trim()) {
        const date: JsonObject = { start: value.start };
        if (typeof value.end === "string" && value.end.trim()) date.end = value.end;
        if (typeof value.time_zone === "string" && value.time_zone.trim()) {
          date.time_zone = value.time_zone;
        }
        return { date };
      }
      throw new InputError(
        `属性 "${prop.name}" (date) 需要日期字符串或 {start,end}，收到 ${describeValue(value)}。`,
        { property: prop.name, expected: "string | {start,end}" }
      );
    }
    case "checkbox": {
      if (typeof value !== "boolean") {
        throw new InputError(
          `属性 "${prop.name}" (checkbox) 需要 true/false，收到 ${describeValue(value)}。`,
          { property: prop.name, expected: "boolean" }
        );
      }
      return { checkbox: value };
    }
    case "url":
    case "email":
    case "phone_number": {
      const text = requireString(prop, value);
      return { [prop.type]: text.trim() ? text : null };
    }
    case "people":
    case "relation": {
      const ids = stringList(prop, value);
      return { [prop.type]: ids.map((id) => ({ id })) };
    }
    default:
      throw new InputError(
        `属性 "${prop.name}" 的类型 ${prop.type} 暂不支持通过简化值写入；可改用 props 里直接给 Notion 原生 payload，例如 {"${prop.name}": {"${prop.type}": ...}}。`,
        { property: prop.name, type: prop.type }
      );
  }
}

function resolveProperty(schema: PropertySchemaSet, name: string): PropertySchema {
  const prop = schema.properties.get(name);
  const hints = writableProperties(schema);
  if (!prop) {
    throw new InputError(
      `未知属性 "${name}"。可用可写属性：${formatHints(hints)}。`,
      { property: name, hint_properties: hints }
    );
  }
  if (READ_ONLY_PROPERTY_TYPES.has(prop.type)) {
    throw new InputError(
      `属性 "${name}" 的类型是 ${prop.type}（只读），不能写入。可写属性：${formatHints(hints)}。`,
      { property: name, type: prop.type, hint_properties: hints }
    );
  }
  return prop;
}

function buildProperties(
  schema: PropertySchemaSet,
  props: Record<string, unknown>
): { properties: JsonObject; names: string[]; title?: string } {
  const properties: JsonObject = {};
  const names: string[] = [];
  let title: string | undefined;

  for (const [name, value] of Object.entries(props)) {
    const prop = resolveProperty(schema, name);
    properties[name] = buildPropertyValue(prop, value);
    names.push(name);
    if (prop.type === "title") title = titleText(value) ?? title;
  }

  return title ? { properties, names, title } : { properties, names };
}

/* ------------------------------------------------------------------ *
 * Markdown title handling (create)
 * ------------------------------------------------------------------ */

function frontmatterTitle(markdown: string): string | undefined {
  const block = FRONTMATTER_RE.exec(markdown);
  if (!block) return undefined;
  const match = /^title\s*:\s*(.+?)\s*$/m.exec(block[1]);
  if (!match) return undefined;
  const raw = match[1].trim();
  if (!raw) return undefined;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return normalizeTitle(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return normalizeTitle(raw.slice(1, -1).replace(/''/g, "'"));
  }
  return normalizeTitle(raw);
}

function leadingH1(markdown: string): { title: string; rest: string } | undefined {
  const match = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(markdown);
  if (!match) return undefined;
  const title = normalizeTitle(match[1].replace(/\s+#+\s*$/, ""));
  if (!title) return undefined;
  const rest = markdown.slice(match[0].length).replace(/^\s*\r?\n/, "");
  return { title, rest };
}

/**
 * `ntn pages create` reads the page title from YAML frontmatter (documented by
 * `ntn pages create --help`). We therefore pass the resolved title that way.
 * A leading H1 is converted to the title (and removed) so the page does not show
 * the same text twice; if the caller wants it as a block, pass title separately.
 */
function withFrontmatterTitle(markdown: string, title: string): string {
  const line = `title: ${JSON.stringify(title)}`;
  const block = FRONTMATTER_RE.exec(markdown);
  if (block) {
    const lines = block[1].split(/\r?\n/);
    const index = lines.findIndex((entry) => /^title\s*:/.test(entry));
    if (index >= 0) lines[index] = line;
    else lines.unshift(line);
    return `---\n${lines.join("\n")}\n---\n\n${markdown.slice(block[0].length)}`;
  }
  return `---\n${line}\n---\n\n${markdown}`;
}

function planContent(
  markdown: string,
  titleHint: string | undefined
): { body: string; title?: string } {
  const existingFrontmatterTitle = frontmatterTitle(markdown);
  const h1 = existingFrontmatterTitle ? undefined : leadingH1(markdown);
  const title = titleHint ?? existingFrontmatterTitle ?? h1?.title;
  let body = markdown;
  // Drop the H1 only when it became (or equals) the page title, to avoid duplication.
  if (h1 && title === h1.title) body = h1.rest;
  if (title) body = withFrontmatterTitle(body, title);
  return title ? { body, title } : { body };
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

function pageUrl(pageId: string): string {
  return `https://app.notion.com/p/${pageId.replace(/-/g, "")}`;
}

function findPageId(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPageId(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;

  for (const key of ["id", "page_id", "pageId"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string" && (UUID_RE.test(candidate) || HEX32_RE.test(candidate))) {
      return candidate;
    }
  }
  for (const key of ["page", "result", "data"] as const) {
    const found = findPageId(value[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findPageIdInText(text: string): string | undefined {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})/i.exec(text);
  return match?.[1];
}

/** `pageUrlFromRaw` only when the payload really carried one; else leave the field unset. */
function pageHasUrl(raw: unknown): boolean {
  return isPlainObject(raw) && typeof raw.url === "string" && raw.url.startsWith("http");
}

function pageUrlFromRaw(raw: unknown, pageId: string): string {
  if (pageHasUrl(raw)) return (raw as JsonObject).url as string;
  return pageUrl(pageId);
}

/** One `warnings` entry from the markdown endpoint, echoed verbatim. */
export type PageWarning = {
  code: string;
  message: string;
};

/**
 * The canonical JSON value of a successful page call. The model-facing text is derived
 * from it by {@link describePageValue}, so the value stays a domain DTO rather than a
 * copy of the rendered content.
 *
 * There is no `action` field: which tool ran already says what the operation was.
 */
export type PageToolValue = {
  ok: true;
  id?: string;
  url?: string;
  title?: string;
  parent?: string;
  /** Names of the properties actually written (empty = none). */
  properties: string[];
  /**
   * What changed, from a closed vocabulary:
   * "body_content" | "properties" | "icon" | "title" | "parent" | "parent_item_relation" | "trashed".
   * Present on every successful value; empty when nothing was written.
   */
  changed: string[];
  /** Icon as sent: an emoji, an image URL, a description, or null when cleared. */
  icon?: string | null;
  /** true on notion_page_create results; an edit never sets it. Drives the headline only. */
  created?: boolean;
  /** create when the parent was a database row. */
  parent_item_row_id?: string;
  parent_item_property?: string;
  /** move: the page/row is already under the requested parent; nothing was written. */
  already_linked?: boolean;
  /** trash: the target was already in the trash, so the call succeeded without a write. */
  already_archived?: boolean;
  /** move row→row: the Parent-item values that were replaced (needs yes:true). */
  replaced_parent_ids?: string[];
  /** move: how far the cycle check got ("walked" | "partial"). */
  cycle_check?: string;

  /* ---- edit: find-and-replace / append, straight from the markdown endpoint ---- */

  /** Notion's `warnings`, verbatim. OMITTED entirely when the API returned none. */
  warnings?: PageWarning[];
  /**
   * edit: true when body_content was APPENDED (edits empty). Produced only by
   * notion_page_edit's append path; an edit that find-replaced sets edits_sent instead.
   */
  appended?: boolean;
  /** edit: content updates sent in this call. */
  edits_sent?: number;
  /** edit: updates Notion reports as applied (`edits_sent` minus `no_match` warnings). */
  edits_applied?: number;
  /** edit: updates Notion reports as matching nothing (the `no_match` warnings). */
  edits_missed?: number;
  /**
   * edit: true when the returned markdown was truncated, i.e. it is NOT the full page.
   * Only the fact that it is truncated is kept: the full body would repeat the whole page
   * into the model's context on every edit.
   */
  truncated?: boolean;
};

/**
 * Model-facing text for a canonical page value.
 *
 * `changed` is the source of truth for WHAT happened: an empty list means the call was a
 * deliberate no-op (already in the trash, already under that parent), and that is said out
 * loud rather than dressed up as a successful write.
 */
export function describePageValue(value: PageToolValue): string {
  const lines: string[] = [];

  if (value.changed.includes("trashed")) {
    lines.push(`已把页面 ${value.id} 移入回收站`);
    if (value.url) lines.push(`URL: ${value.url}`);
    return lines.join("\n");
  }

  if (value.already_archived) {
    lines.push(`页面 ${value.id} 本来就在回收站里，本次没有执行删除`);
    if (value.url) lines.push(`URL: ${value.url}`);
    lines.push("changed: (none)");
    return lines.join("\n");
  }

  if (value.already_linked) {
    lines.push(
      value.parent_item_property
        ? `行 ${value.id} 已经在父行 ${value.parent_item_row_id} 下（Parent-item 列：${value.parent_item_property}），无需改动`
        : `页面 ${value.id} 已经挂在 ${value.parent} 下，无需改动`
    );
    if (value.url) lines.push(`URL: ${value.url}`);
    lines.push("changed: (none)");
    return lines.join("\n");
  }

  // Headline: what this call was.
  if (value.created) {
    lines.push(`已创建页面${value.title ? ` "${value.title}"` : ""}：${value.id ?? "(id 未返回)"}`);
  } else if (value.changed.length === 0) {
    lines.push(`页面 ${value.id} 没有改动（changed: none）`);
  } else {
    const what = describeChanges(value.changed);
    lines.push(`已更新页面 ${value.id} 的${what}`);
  }

  if (value.url) lines.push(`URL: ${value.url}`);
  if (value.parent) lines.push(`parent: ${value.parent}`);
  if (value.parent_item_row_id) lines.push(`Parent-item → ${value.parent_item_row_id}`);
  if (value.parent_item_property) lines.push(`Parent-item 列：${value.parent_item_property}`);
  if (value.replaced_parent_ids?.length) {
    lines.push(`替换了原来的父级：${value.replaced_parent_ids.join(", ")}`);
  }
  if (value.cycle_check === "partial") {
    lines.push("注意：页面祖先链未能完整读取，深层环检查为 best-effort（cycle_check: partial）");
  }
  if (value.properties.length) lines.push(`已写入列：${value.properties.join(", ")}`);
  if (value.icon !== undefined) lines.push(`icon: ${value.icon ?? "（已清除）"}`);

  if (value.edits_sent !== undefined) {
    lines.push(
      `edits: ${value.edits_applied ?? 0}/${value.edits_sent} 条已应用` +
        ((value.edits_missed ?? 0) > 0
          ? `，${value.edits_missed} 条 old_str 没有匹配（页面其余部分未改动，见 warnings）`
          : "，全部匹配")
    );
  } else if (value.appended) {
    lines.push("正文已追加到页面末尾（edits 为空 + body_content）");
  }

  if (value.warnings) {
    for (const warning of value.warnings) lines.push(`warning [${warning.code}]: ${warning.message}`);
  }
  if (value.truncated) {
    lines.push(
      "注意：Notion 返回的 markdown 被截断（truncated: true），它不是完整页面；下一次 old_str 不要以它为准。"
    );
  }
  return lines.join("\n");
}

/** "内容、属性、icon" — the `changed` vocabulary in words, in a stable order. */
function describeChanges(changed: string[]): string {
  const words: Record<string, string> = {
    body_content: "内容",
    title: "标题",
    properties: "属性",
    icon: "icon",
    parent: "父级",
    parent_item_relation: "Parent-item 链接",
  };
  const ordered = ["body_content", "title", "properties", "icon", "parent", "parent_item_relation"];
  const described = ordered.filter((key) => changed.includes(key)).map((key) => words[key]);
  return described.length ? described.join("、") : changed.join("、");
}

/**
 * Shape a canonical value. `changed` is always present (possibly empty): it is what the
 * caller reads to tell "this wrote three things" from "this was a no-op".
 */
function pageValue(
  fields: Omit<PageToolValue, "ok" | "properties" | "changed"> & {
    properties?: string[];
    changed: string[];
  }
): PageToolValue {
  return { ok: true, properties: [], ...fields };
}

/* ------------------------------------------------------------------ *
 * Markdown endpoint (find-and-replace / append)
 * ------------------------------------------------------------------ */

/** One `update_content` operation, as Notion defines it. */
export type ContentEdit = {
  old_str: string;
  new_str: string;
  replace_all_matches?: boolean;
};

/** Notion accepts at most this many `content_updates` per request. */
const MAX_CONTENT_UPDATES = 100;

/**
 * Request defaults shared by every `PATCH v1/pages/{id}/markdown` call.
 *
 * `markdown_version: "v2"` is pinned deliberately: Notion recommends Notion-flavored
 * Markdown and documents that the default (`v1`, enhanced markdown) is deprecated and will
 * be REJECTED by the next Notion-Version. Pinning it on the write path keeps the parser
 * from changing under us.
 *
 * `allow_deleting_content` is deliberately NOT sent, i.e. it stays at Notion's default
 * `false`. That flag governs deleting the child PAGES / DATABASES nested in the page — not
 * text: a plain `new_str: ""` deletes text without it. It is the one guard left that stops
 * an over-broad `old_str` from swallowing a `<page url="...">title</page>` block and wiping
 * a whole subtree, so enabling it (or silently passing it through from the caller) would
 * trade a guard for nothing. When the API refuses such an edit the refusal is surfaced to
 * the model verbatim (see {@link markdownDeletionRefusal}) instead of being overridden.
 */
const MARKDOWN_REQUEST_DEFAULTS: JsonObject = {
  markdown_version: "v2",
};

/** Read one edit object from the `edits` array. */
function readContentEdit(raw: unknown, index: number): ContentEdit {
  const path = `edits[${index}]`;
  if (!isPlainObject(raw)) {
    throw new InputError(
      `${path} 必须是 { old_str, new_str, replace_all_matches? }，收到 ${describeValue(raw)}。`,
      { field: path, value: raw }
    );
  }
  const unexpected = Object.keys(raw).filter(
    (key) => raw[key] !== undefined && !["old_str", "new_str", "replace_all_matches"].includes(key)
  );
  if (unexpected.length > 0) {
    throw new InputError(
      `${path} 只接受 old_str / new_str / replace_all_matches，多余字段：${unexpected.join(", ")}。`,
      { field: path, unexpected_params: unexpected }
    );
  }
  if (typeof raw.old_str !== "string") {
    throw new InputError(
      `${path}.old_str 必须是字符串（要查找的原文），收到 ${describeValue(raw.old_str)}。`,
      { field: `${path}.old_str`, value: raw.old_str }
    );
  }
  if (raw.old_str === "") {
    throw new InputError(
      `${path}.old_str 不能是空字符串：Notion 会拒绝空 old_str。要追加内容请用 body_content 且不传 edits。`,
      { field: `${path}.old_str` }
    );
  }
  if (raw.new_str === undefined) {
    throw new InputError(
      `${path}.new_str 是必填的：替换成什么就写什么，想删除这段文字请传 ""（空字符串）。`,
      { field: `${path}.new_str`, value: raw.new_str }
    );
  }
  if (typeof raw.new_str !== "string") {
    throw new InputError(
      `${path}.new_str 必须是字符串，收到 ${describeValue(raw.new_str)}。`,
      { field: `${path}.new_str`, value: raw.new_str }
    );
  }
  return {
    old_str: raw.old_str,
    new_str: raw.new_str,
    ...(raw.replace_all_matches === undefined
      ? {}
      : { replace_all_matches: readBoolean(raw.replace_all_matches, `${path}.replace_all_matches`) }),
  };
}

function readContentEdits(raw: unknown): ContentEdit[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new InputError(
      `edits 必须是数组：[{ old_str, new_str, replace_all_matches? }, ...]，收到 ${describeValue(raw)}。` +
        `要追加内容请改用 body_content（不传 edits）。`,
      { field: "edits", value: raw }
    );
  }
  if (raw.length > MAX_CONTENT_UPDATES) {
    throw new InputError(
      `edits 最多 ${MAX_CONTENT_UPDATES} 条（Notion 限制），收到 ${raw.length} 条。请拆成多次 notion_page_edit 调用。`,
      { field: "edits", count: raw.length, max: MAX_CONTENT_UPDATES }
    );
  }
  return raw.map((entry, index) => readContentEdit(entry, index));
}

/**
 * Fold the compat alias `props.block_update` into `edits`.
 *
 * `block_update` was the pre-split spelling of the same list. It is only accepted when
 * `edits` is absent: passing both is genuinely ambiguous (which list wins?), and guessing
 * could silently drop one of the two sets of writes — same reasoning the old
 * `content`-vs-`props.body_content` clash used.
 */
function withEditAlias(
  edits: ContentEdit[],
  props: Record<string, unknown> | undefined
): { edits: ContentEdit[]; props: Record<string, unknown> | undefined } {
  if (!props || !("block_update" in props)) return { edits, props };
  if (edits.length > 0) {
    throw new InputError(
      "edits 和 props.block_update 是同一个东西（查找替换列表），不要同时传；请统一用 edits。本次没有写入任何内容。",
      { conflict: true, fields: ["edits", "props.block_update"] }
    );
  }
  const used = { ...props };
  const rawAlias = used.block_update;
  delete used.block_update;
  const aliasEdits = readContentEdits(rawAlias);
  const rest = Object.keys(used).length ? used : undefined;
  return { edits: aliasEdits, props: rest };
}

type MarkdownOutcome = {
  /** Everything the response carried that the model needs, already flattened. */
  warnings?: PageWarning[];
  truncated?: boolean;
};

/** `warnings` from a markdown response, verbatim, or undefined when there were none. */
function readMarkdownWarnings(raw: unknown): PageWarning[] | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (!Array.isArray(raw.warnings)) return undefined;
  const warnings = raw.warnings.flatMap((entry): PageWarning[] => {
    if (!isPlainObject(entry)) return [];
    const code = typeof entry.code === "string" ? entry.code : "unknown";
    const message = typeof entry.message === "string" ? entry.message : describeValue(entry);
    return [{ code, message }];
  });
  return warnings.length ? warnings : undefined;
}

/** `truncated` from a markdown response; only reported when it is actually true. */
function readMarkdownTruncated(raw: unknown): boolean | undefined {
  return isPlainObject(raw) && raw.truncated === true ? true : undefined;
}

/**
 * How many of the edits the caller sent Notion reports as unmatched.
 *
 * The endpoint's own contract is the source: "Operations that match are applied, and each
 * one that matches nothing is reported in `warnings`" (`code: "no_match"`). So the warning
 * count IS the miss count, and applied = sent − missed. `warnings` can also carry
 * non-matching categories (`unsupported_tag`), which are counted separately and never
 * folded into the edit tally.
 */
function countNoMatchWarnings(warnings: PageWarning[] | undefined): number {
  if (!warnings) return 0;
  return warnings.filter((warning) => warning.code === "no_match").length;
}

/**
 * A refusal that says an edit would have deleted a child page or database.
 *
 * `allow_deleting_content` stays false on purpose (see {@link MARKDOWN_REQUEST_DEFAULTS}),
 * so this is the guard firing: the message tells the model how to make the edit land
 * instead of leaving it to guess that the request was malformed.
 */
const DELETION_REFUSAL_RE =
  /allow_deleting_content|delete (?:a )?child|child pages? or databases|archived? child/i;

function markdownFailure(pageId: string, result: RunNtnResult): NotionToolError {
  const detail = (result.stderr || result.stdout || "").trim();
  if (DELETION_REFUSAL_RE.test(detail)) {
    return new NotionToolError(
      `这次编辑会删除页面 ${pageId} 里的子页面或子数据库，Notion 因此拒绝执行（本次没有写入任何内容）。` +
        "old_str 匹配的是整段文本，很容易连带覆盖 `<page url=\"...\">…</page>` 或 `<database ...>` 这类块。" +
        "请把 old_str 缩小到那段文字本身（不要包含子页面/子数据库块），或先在 Notion 里把子页面移走再改。" +
        `ntn 输出：${truncate(detail, 600)}`,
      {
        code: NOTION_ERROR_CODES.ntnFailed,
        details: {
          id: pageId,
          refused: "deleting_child_content",
          stderr: result.stderr.trim(),
          stdout: truncate(result.stdout.trim()),
          code: result.code,
        },
      }
    );
  }
  return ntnFailure(`更新页面 ${pageId} 的 Markdown 内容`, result);
}

/** `PATCH v1/pages/{id}/markdown` with a body, returning the parsed response. */
async function patchPageMarkdown(
  runner: NtnRunner,
  pageId: string,
  body: JsonObject
): Promise<MarkdownOutcome> {
  const path = `v1/pages/${pageId}/markdown`;
  const result = await runner({
    args: ["api", path, "-X", "PATCH", "--data", JSON.stringify({ ...MARKDOWN_REQUEST_DEFAULTS, ...body })],
  });
  if (!result.ok) throw markdownFailure(pageId, result);
  const parsed = parseJsonMaybe(result.stdout);
  const warnings = readMarkdownWarnings(parsed);
  const truncated = readMarkdownTruncated(parsed);
  return {
    ...(warnings ? { warnings } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

/** Apply find-and-replace edits in one `update_content` request (they run server-side, in order). */
async function applyContentEdits(
  runner: NtnRunner,
  pageId: string,
  edits: ContentEdit[]
): Promise<MarkdownOutcome & { edits_sent: number; edits_applied: number; edits_missed: number }> {
  const outcome = await patchPageMarkdown(runner, pageId, {
    type: "update_content",
    update_content: { content_updates: edits },
  });
  const missed = countNoMatchWarnings(outcome.warnings);
  return {
    ...outcome,
    edits_sent: edits.length,
    edits_applied: Math.max(edits.length - missed, 0),
    edits_missed: missed,
  };
}

/** Append Markdown at the end of a page, via `insert_content` with an explicit position. */
async function appendPageContent(
  runner: NtnRunner,
  pageId: string,
  content: string
): Promise<MarkdownOutcome> {
  return patchPageMarkdown(runner, pageId, {
    type: "insert_content",
    insert_content: { content, position: { type: "end" } },
  });
}

/* ------------------------------------------------------------------ *
 * Shared writes
 * ------------------------------------------------------------------ */

/**
 * `PATCH v1/pages/{id}`: property writes and/or the icon, in one request.
 * An empty property map is omitted so an icon-only write stays icon-only.
 */
function patchArgs(pageId: string, properties: JsonObject, icon?: NormalizedIcon): string[] {
  const body: JsonObject = {};
  if (Object.keys(properties).length > 0) body.properties = properties;
  if (icon) body.icon = icon.payload;
  return ["api", `v1/pages/${pageId}`, "-X", "PATCH", "--data", JSON.stringify(body)];
}

/**
 * Map `props` (columns only) plus the top-level `title` into the Notion property payload of
 * one PATCH. Shared by create and edit so the two cannot drift.
 *
 * `changes` says what this write touched, using the `changed` vocabulary: "title" only when
 * the explicit `title` argument set the title column, "properties" whenever any column was
 * written. The caller adds "icon" itself because the icon is not a column.
 */
function buildPropertyWrite(
  schema: PropertySchemaSet,
  props: Record<string, unknown> | undefined,
  title: string | undefined,
  context: { pageId?: string; source: string }
): { properties: JsonObject; names: string[]; title?: string; changes: string[] } {
  const properties: JsonObject = {};
  const names: string[] = [];
  let titleFromProps: string | undefined;

  if (props) {
    const built = buildProperties(schema, props);
    Object.assign(properties, built.properties);
    names.push(...built.names);
    titleFromProps = built.title;
  }

  // The explicit `title` argument wins over a value for the title property in props.
  let titleWritten = false;
  if (title) {
    const titleName = titlePropertyName(schema);
    if (!titleName) {
      throw new InputError(
        context.pageId
          ? `无法确定页面 ${context.pageId} 的标题属性，不能用 title 改标题；请改用 props 并指定标题属性名。`
          : `无法确定 ${context.source} 的标题属性，不能用 title 指定标题；请改用 props 并指定标题属性名。`
      );
    }
    properties[titleName] = { title: richText(title) };
    if (!names.includes(titleName)) names.push(titleName);
    titleWritten = true;
  }

  const changes: string[] = [];
  if (titleWritten) changes.push("title");
  if (names.length > 0 && !titleWritten) changes.push("properties");
  return {
    properties,
    names,
    ...(titleFromProps ? { title: titleFromProps } : {}),
    changes,
  };
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

/** Unresolved Parent-item relation: say exactly what is missing and which columns exist. */
function parentItemError(schema: PropertySchemaSet, dataSourceId: string): InputError {
  const relations = relationProperties(schema);
  const hints = writableProperties(schema);
  const detail = relations.length
    ? `现有 relation 列：${relations
        .map((prop) =>
          prop.relationDataSourceId ? `${prop.name} → ${prop.relationDataSourceId}` : prop.name
        )
        .join(", ")}`
    : "该 data source 没有任何 relation 列";
  return new InputError(
    `data source ${dataSourceId} 没有可用的 Parent-item / 自关联 relation 列，无法把行挂到父行下（${detail}）。` +
      "请在 Notion 里为这个库加一个指向自身的 relation 属性（默认名 Parent-item），或用 notion_get 查看现有列后重试。",
    {
      dataSourceId,
      hint_properties: hints,
      relation_properties: relations.map((prop) => prop.name),
    }
  );
}

/** Add the parent-row link to a property map (merging a relation the caller already set). */
function withRowParentRelation(
  properties: JsonObject,
  prop: PropertySchema,
  parentRowId: string
): void {
  const current = properties[prop.name];
  const existing: unknown[] =
    isPlainObject(current) && Array.isArray(current["relation"]) ? current["relation"] : [];
  const merged = [...existing, { id: parentRowId }];
  properties[prop.name] = { relation: merged };
}

/**
 * Undo a create whose follow-up write failed: trash the just-created page so the
 * caller is not left with an orphan row/page (or a row missing its Parent-item link).
 *
 * The returned error always says whether the workspace is clean again:
 *   partial: false + created_id + rollback: "trashed"
 *                                              trash succeeded, nothing was left behind
 *   partial: true  + created_id + rollback: "trash_failed"
 *                                              the page still exists and needs manual trash
 */
async function rollbackCreatedPage(
  runner: NtnRunner,
  pageId: string,
  cause: NotionToolError
): Promise<NotionToolError> {
  // Production runNtn never rejects, but an injected runner may; never lose the create failure.
  let trash: RunNtnResult;
  try {
    trash = await runner({ args: ["pages", "trash", pageId, "--yes"] });
  } catch (error) {
    trash = {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: null,
    };
  }
  const detail = (trash.stderr || trash.stdout || "").trim();
  const partial = !trash.ok;
  const rollbackLine = partial
    ? `\n回滚失败：ntn pages trash ${pageId} 也失败了${detail ? `（${truncate(detail, 300)}）` : ""}，` +
      `该页面/行仍然存在（partial: true）。请手动清理：notion_page_trash { id: "${pageId}", yes: true }。`
    : `\n已回滚：新页面 ${pageId} 已移入回收站（partial: false），没有留下半成品。`;

  // A failed cleanup leaves a page behind: the model must act on that differently from
  // "the arguments were rejected", so it gets its own code. A clean rollback keeps the
  // code that actually failed (NTN_FAILED / INVALID_INPUT), not PARTIAL_WRITE.
  const details: JsonObject = {
    ...cause.details,
    partial,
    created_id: pageId,
    rollback: partial ? "trash_failed" : "trashed",
    rollback_code: trash.code,
    ...(detail ? { rollback_error: truncate(detail, 600) } : {}),
  };
  return new NotionToolError(`${cause.detail}${rollbackLine}`, {
    code: partial ? NOTION_ERROR_CODES.partialWrite : cause.code,
    details,
  });
}

/** `notion_page_create` arguments, after validation. */
type CreateParams = {
  parent: unknown;
  title?: string;
  props?: Record<string, unknown>;
  icon?: NormalizedIcon;
  body?: string;
};

async function createPage(params: CreateParams, runner: NtnRunner): Promise<PageToolValue> {
  // Resolving the container also resolves the schema (C4: via data source, not database).
  // The reader memoizes GET v1/pages so a bare row parent is fetched once.
  const readPage = makePageReader(runner);
  const container = await resolveContainer(runner, params.parent, "create", readPage);

  const markdown = params.body ?? "";
  const {
    properties,
    names,
    title: propsTitle,
    changes,
  } = buildPropertyWrite(container.schema, params.props, params.title, {
    source: container.schema.source,
  });
  const propertyNames = [...names];
  const explicitTitle = params.title;

  const draft = planContent(markdown, explicitTitle ?? propsTitle);
  const title = draft.title;

  if (container.kind !== "page" && !title) {
    const hints = writableProperties(container.schema);
    throw new InputError(
      `在 ${container.kind === "row" ? `行 ${container.rowParentId} 所在 data source` : container.kind} 中创建页面需要标题：` +
        `请传 title、在 props 里写标题属性（${titlePropertyName(container.schema) ?? "title"}），` +
        `或让 body_content 以 "# 标题" 开头。可写属性：${formatHints(hints)}。`,
      { parent: formatParent(container.createParent), hint_properties: hints }
    );
  }

  // `ntn pages create` rejects empty Markdown ("Markdown content cannot be empty.")
  // with exit 5. A title-only create is fine because frontmatter makes the body
  // non-empty, but a bare `parent` with no title cannot create a page.
  if (!draft.body.trim()) {
    throw new InputError(
      "create 需要 body_content 或 title：ntn pages create 不接受空 Markdown，只有 parent 无法创建空白页面。"
    );
  }

  // A row parent means the new page is a child row: link it with the Parent-item column.
  let rowRelationName: string | undefined;
  if (container.kind === "row") {
    const relation = findParentItemProperty(container.schema, container.dataSourceId);
    if (!relation) throw parentItemError(container.schema, container.dataSourceId);
    rowRelationName = relation.name;
    withRowParentRelation(properties, relation, container.rowParentId);
    if (!propertyNames.includes(relation.name)) propertyNames.push(relation.name);
  }

  // Use `--content=<markdown>` as one argv element: clap would otherwise treat a
  // value starting with `---` (our frontmatter) or `-` (bullet lists) as a flag.
  const createResult = await runner({
    args: [
      "pages",
      "create",
      "--json",
      "--parent",
      formatParent(container.createParent),
      `--content=${draft.body}`,
    ],
  });
  if (!createResult.ok) throw ntnFailure("ntn pages create", createResult);

  const created = parseJsonMaybe(createResult.stdout);
  // A text-scraped id is only a hint: it must never become a trash target, because guessing
  // wrong would delete an unrelated page. Structured JSON ids are trusted for rollback.
  const structuredId = findPageId(created);
  const textId = structuredId ? undefined : findPageIdInText(createResult.stdout);
  const pageId = structuredId ?? textId;
  const url = pageId ? pageUrlFromRaw(created, pageId) : undefined;
  const icon = params.icon;

  /** Fail before any follow-up write when there is no trusted id to write to. */
  const requireTrustedId = (what: string): string => {
    if (structuredId) return structuredId;
    throw new InputError(
      `页面已创建（parent ${formatParent(container.createParent)}），但没有从 ntn 的结构化输出里取到页面 id，` +
        `${what}未写入。` +
        `没有可信 id 就不自动 trash（避免误删），请用 notion_search/notion_get 找到该页面后，` +
        `用 notion_page_edit 写入，或 notion_page_trash 删除（partial: true，rollback: unknown_id）。`,
      {
        parent: formatParent(container.createParent),
        partial: true,
        rollback: "unknown_id",
        ...(pageId ? { id_candidate: pageId } : {}),
        stdout: truncate(createResult.stdout.trim()),
      }
    );
  };

  const needsPatch = propertyNames.length > 0 || icon !== undefined;
  if (needsPatch) {
    const targetId = requireTrustedId("props/icon");
    // The follow-up PATCH is one request that carries every property plus the icon, so a
    // page created with only an icon still gets its icon (no properties were written).
    const patchResult = await runner({ args: patchArgs(targetId, properties, icon) });
    if (!patchResult.ok) {
      throw await rollbackCreatedPage(
        runner,
        targetId,
        ntnFailure(
          "PATCH 页面属性/icon",
          patchResult,
          container.kind === "row"
            ? `子行已创建（id ${targetId}），但属性/Parent-item relation/icon 未写入`
            : `页面已创建（id ${targetId}），但属性/icon 未写入`
        )
      );
    }
    // `changes` already carries "title" or "properties" from buildPropertyWrite.
    if (icon) changes.push("icon");
  }

  // `pages create` always writes the Markdown body, so the body is always part of what
  // this call changed; the columns/icon PATCH adds its own entries above.
  changes.unshift("body_content");

  return pageValue({
    created: true,
    ...(pageId ? { id: pageId } : {}),
    ...(url ? { url } : {}),
    parent: formatParent(container.createParent),
    ...(title ? { title } : {}),
    ...(container.kind === "row"
      ? {
          parent_item_row_id: container.rowParentId,
          ...(rowRelationName ? { parent_item_property: rowRelationName } : {}),
        }
      : {}),
    ...(icon ? { icon: icon.display } : {}),
    properties: propertyNames,
    changed: changes,
  });
}

/* ------------------------------------------------------------------ *
 * Edit: content (find-and-replace / append) + properties/title/icon + move
 * ------------------------------------------------------------------ */

type EditParams = {
  id: string;
  edits: ContentEdit[];
  body?: string;
  props?: Record<string, unknown>;
  title?: string;
  icon?: NormalizedIcon;
  parent?: unknown;
  yes: boolean;
};

/** Shared state threaded through the three writes of one edit call. */
type EditResult = {
  changes: string[];
  properties: string[];
  outcome: MarkdownOutcome & {
    edits_sent?: number;
    edits_applied?: number;
    edits_missed?: number;
  };
  /** True when the content write was an append rather than find-and-replace. */
  appended?: boolean;
  /** Latest URL a response carried; none of the write endpoints is required to return one. */
  url?: string;
  move?: MoveOutcome;
};

type MoveOutcome = {
  parent: string;
  parent_item_row_id?: string;
  parent_item_property?: string;
  already_linked?: boolean;
  replaced_parent_ids?: string[];
  cycle_check?: PageCycleCheck;
  change: "parent" | "parent_item_relation" | null;
  /** The move's own response (page→page carries the page url). */
  url?: string;
};

/**
 * A later write failed after an earlier one landed. The caller has to know that a retry
 * would apply the first write a second time, so the error says so in words AND in
 * structured details (`partial`, `applied`).
 */
function partialEditError(
  cause: NotionToolError,
  applied: string[],
  failedStep: string
): NotionToolError {
  return new NotionToolError(
    `${cause.detail}\n已经生效的部分：${applied.join("、")}（已写入，不会回滚）。` +
      `失败的是：${failedStep}。重试前请先 notion_get 确认页面当前状态，避免重复应用。`,
    {
      code: cause.code,
      details: { ...cause.details, partial: true, applied, failed_step: failedStep },
    }
  );
}

async function editPage(params: EditParams, runner: NtnRunner): Promise<PageToolValue> {
  const { id, edits } = params;
  const result: EditResult = { changes: [], properties: [], outcome: {} };

  // ORDER, and it is deliberately this order: (1) content, (2) properties/title/icon,
  // (3) the move. Content first because a caller that "fixes the text and then files the
  // page somewhere else" reads its own intent that way, and because a move that lands
  // before the content would make the content edit's failure look like a failed move.
  // Each later step reports what the earlier ones already wrote if it fails.
  const applied: string[] = [];
  if (edits.length > 0) {
    const appliedEdits = await applyContentEdits(runner, id, edits);
    result.outcome = appliedEdits;
    result.changes.push("body_content");
    applied.push(
      `内容（${appliedEdits.edits_applied}/${appliedEdits.edits_sent} 条 edits）`
    );
  } else if (params.body !== undefined && params.body.trim() !== "") {
    result.outcome = await appendPageContent(runner, id, params.body);
    result.appended = true;
    result.changes.push("body_content");
    applied.push("追加的正文内容");
  }

  const needsPatch =
    params.props !== undefined || params.title !== undefined || params.icon !== undefined;
  if (needsPatch) {
    const schema = await schemaForPage(runner, id);
    const { properties, names, changes } = buildPropertyWrite(schema, params.props, params.title, {
      pageId: id,
      source: schema.source,
    });
    const patchResult = await runner({ args: patchArgs(id, properties, params.icon) });
    if (!patchResult.ok) {
      const cause = ntnFailure("PATCH 页面属性/icon", patchResult);
      throw applied.length > 0
        ? partialEditError(cause, applied, "属性/标题/icon（PATCH 页面属性/icon）")
        : cause;
    }
    const patched = parseJsonMaybe(patchResult.stdout);
    if (pageHasUrl(patched)) result.url = pageUrlFromRaw(patched, id);
    result.properties = names;
    result.changes.push(...changes);
    if (params.icon !== undefined) result.changes.push("icon");
    if (names.length > 0) applied.push(`属性（${names.join(", ")}）`);
    if (params.icon !== undefined) applied.push("icon");
  }

  if (params.parent !== undefined) {
    let move: MoveOutcome;
    try {
      move = await movePage(runner, { id, parent: params.parent, yes: params.yes });
    } catch (error) {
      const cause = error instanceof NotionToolError ? error : ntnFailure("移动页面", {
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        code: null,
      });
      throw applied.length > 0 ? partialEditError(cause, applied, "移动页面（parent）") : cause;
    }
    result.move = move;
    if (move.change) result.changes.push(move.change);
  }

  const { outcome, move } = result;
  return pageValue({
    id,
    url: result.url ?? move?.url ?? pageUrl(id),
    ...(move?.parent ? { parent: move.parent } : {}),
    ...(move?.parent_item_row_id ? { parent_item_row_id: move.parent_item_row_id } : {}),
    ...(move?.parent_item_property ? { parent_item_property: move.parent_item_property } : {}),
    ...(move?.already_linked ? { already_linked: true } : {}),
    ...(move?.replaced_parent_ids ? { replaced_parent_ids: move.replaced_parent_ids } : {}),
    ...(move?.cycle_check ? { cycle_check: move.cycle_check } : {}),
    ...(params.icon !== undefined ? { icon: params.icon.display } : {}),
    properties: result.properties,
    changed: result.changes,
    ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
    ...(outcome.truncated ? { truncated: true } : {}),
    ...(result.appended ? { appended: true } : {}),
    ...(outcome.edits_sent !== undefined
      ? {
          edits_sent: outcome.edits_sent,
          edits_applied: outcome.edits_applied,
          edits_missed: outcome.edits_missed,
        }
      : {}),
  });
}

/**
 * Re-parent one page (the old `attach` action).
 *
 *   page → page : POST v1/pages/{id}/move
 *   row  → row  : PATCH the Parent-item / self-relation column of the moved row
 */
async function movePage(
  runner: NtnRunner,
  options: { id: string; parent: unknown; yes: boolean }
): Promise<MoveOutcome & { url?: string }> {
  const { id } = options;

  // Reject database/data-source parents before spending an ntn call on them.
  const spec = parseParentSpec(options.parent, "move");
  if (!spec.bare && spec.kind !== "page") {
    throw new InputError(
      "edit 的 parent（移动页面）只支持 page:<id> 或（裸）行 id：页面挂到页面下用 POST /v1/pages/{id}/move，行挂到行下用 Parent-item relation。" +
        "要把页面放进某个 data source，请用 notion_page_create。"
    );
  }

  const readPage = makePageReader(runner);
  const container = await resolveContainer(runner, options.parent, "move", readPage);
  const childPage = await readPage(id);
  const childParent = childPage.parent;
  if (!childParent) {
    throw new InputError(
      `无法确定页面 ${id} 的当前父级（GET v1/pages 未返回 parent）。移动页面不会在没有确认的情况下执行。`,
      { id }
    );
  }

  if (container.kind === "page") {
    const targetParentId = container.createParent.id;
    if (sameNotionId(id, targetParentId)) {
      throw new InputError(`页面 ${id} 不能挂到自己下面。`, { id, parent: targetParentId });
    }
    if (childParent.kind === "page" && sameNotionId(childParent.id, targetParentId)) {
      throw new InputError(`页面 ${id} 已经是 ${targetParentId} 的子页面，无需移动。`, { id });
    }

    // Deeper page-tree cycles (A→B→A) are checked best effort: one GET per ancestor.
    const cycle = await walkPageAncestors(readPage, { childId: id, parentId: targetParentId });
    if (cycle.cycle) {
      throw new InputError(
        `页面 ${id} 不能挂到页面 ${targetParentId} 下：会形成环（${cycle.cycle.join(" → ")}）。`,
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
        JSON.stringify({ parent: { page_id: targetParentId } }),
      ],
    });
    if (!result.ok) throw ntnFailure(`把页面 ${id} 挂到 ${targetParentId} 下`, result);

    const moved = parseJsonMaybe(result.stdout);
    return {
      parent: formatParent(container.createParent),
      cycle_check: cycle.status,
      change: "parent",
      ...(pageHasUrl(moved) ? { url: pageUrlFromRaw(moved, id) } : {}),
    };
  }

  if (container.kind !== "row") {
    // Unreachable: database/data-source parents are rejected above. Kept so the
    // row-only fields below are type-safe instead of a cast.
    throw new InputError("无法把页面挂到 data source 容器下；请改用 notion_page_create。");
  }

  // Parent is a row: only a row can be re-linked with a self-relation.
  if (childParent.kind === "page") {
    throw new InputError(
      `页面 ${id} 不在数据库里（父级是页面${childParent.id ? ` ${childParent.id}` : ""}），` +
        `不能用 Parent-item relation 挂到行 ${container.rowParentId} 下；行→行的移动只适用于同一库内的行。`,
      { id, parentRowId: container.rowParentId }
    );
  }
  if (sameNotionId(id, container.rowParentId)) {
    throw new InputError(`行 ${id} 不能挂到自己下面。`, { id });
  }

  const childDataSourceId = await dataSourceIdForParent(runner, childParent);
  if (!sameNotionId(childDataSourceId, container.dataSourceId)) {
    throw new InputError(
      `行 ${id} 属于 data source ${childDataSourceId}，父行 ${container.rowParentId} 属于 ${container.dataSourceId}；` +
        "自关联 Parent-item 只能在同一 data source 内使用，跨库请改用 page 父级或 notion_page_create。",
      { id, childDataSourceId, parentDataSourceId: container.dataSourceId }
    );
  }

  const relation = findParentItemProperty(container.schema, container.dataSourceId);
  if (!relation) throw parentItemError(container.schema, container.dataSourceId);

  const currentParents = relationIdsIn(childPage, relation.name);
  const parentAlreadySet = currentParents.some((existing) =>
    sameNotionId(existing, container.rowParentId)
  );
  // Idempotent only when the requested link is the WHOLE relation. `[P, X]` + move to P
  // still holds a second, different parent, so it needs yes:true and a real replace PATCH.
  if (parentAlreadySet && currentParents.length === 1) {
    return {
      parent: formatParent(container.createParent),
      parent_item_property: relation.name,
      parent_item_row_id: container.rowParentId,
      already_linked: true,
      change: null,
    };
  }
  if (currentParents.length > 0 && options.yes !== true) {
    throw new InputError(
      `行 ${id} 的 ${relation.name}（Parent-item）已经指向 ${currentParents.join(", ")}，` +
        `移到 ${container.rowParentId} 下会覆盖这个链接。确认要改父级请传 yes: true；本次没有写入。`,
      {
        id,
        parent: formatParent(container.createParent),
        parent_item_property: relation.name,
        current_parent_ids: currentParents,
        overwrite: true,
      }
    );
  }

  // Cycle check before writing. It runs after the no-op/consent checks so an idempotent
  // re-move (which writes nothing) can never fail on an unreadable ancestor.
  await assertNoRowCycle(runner, readPage, {
    childId: id,
    parentId: container.rowParentId,
    relationName: relation.name,
    dataSourceId: container.dataSourceId,
  });

  // Overwrite replaces the link (caller consented with yes:true when one existed).
  const properties: JsonObject = { [relation.name]: { relation: [{ id: container.rowParentId }] } };
  const patchResult = await runner({ args: patchArgs(id, properties) });
  if (!patchResult.ok) throw ntnFailure(`设置 ${relation.name}（Parent-item）relation`, patchResult);

  const patched = parseJsonMaybe(patchResult.stdout);
  return {
    parent: formatParent(container.createParent),
    parent_item_property: relation.name,
    parent_item_row_id: container.rowParentId,
    ...(currentParents.length > 0 ? { replaced_parent_ids: currentParents } : {}),
    cycle_check: "walked",
    change: "parent_item_relation",
    ...(pageHasUrl(patched) ? { url: pageUrlFromRaw(patched, id) } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Trash
 * ------------------------------------------------------------------ */

/**
 * What a trash target turned out to be. `canonicalNotionId` probing is not usable
 * here: page and data-source ids are both plain UUIDs, so the type comes from an
 * API read, not from the string.
 */
type TrashTarget =
  | { kind: "page"; archived: boolean }
  | { kind: "database" }
  /** No probe claimed the id, so it is not an object this token can see. */
  | { kind: "missing" }
  /**
   * A probe failed for a reason other than "not found" (auth, timeout, 5xx). The
   * type is unknowable, and proceeding could delete something we could not even
   * read, so trash stops here instead of guessing.
   */
  | { kind: "unreadable"; reason: string };

/**
 * Whether an ntn failure means "this id is not that kind of object".
 *
 * Two shapes count: a 404 (nothing with this id is visible) and Notion's 400
 * "Provided ID X is a database, not a page" — the id is real but is a different
 * object kind, which is exactly what the next probe should try. Anything else
 * (401, timeout, 5xx) is NOT this, because continuing would delete an object we
 * could not read.
 */
function isNotFound(res: RunNtnResult): boolean {
  if (res.ok) return false;
  const text = `${res.stderr}\n${res.stdout}`;
  return /404|not_found|object_not_found|Could not find|is a (database|data source|page), not a/i.test(
    text
  );
}

/** Classify a trash target by asking the API; never guesses from the id string. */
async function classifyTrashTarget(runner: NtnRunner, id: string): Promise<TrashTarget> {
  const probes: { kind: "page" | "database"; path: string }[] = [
    { kind: "page", path: `v1/pages/${id}` },
    { kind: "database", path: `v1/databases/${id}` },
    { kind: "database", path: `v1/data_sources/${id}` },
  ];
  for (const probe of probes) {
    const res = await runner({ args: ["api", probe.path] });
    if (res.ok) {
      if (probe.kind === "database") return { kind: "database" };
      const raw = parseJsonMaybe(res.stdout);
      const archived = isPlainObject(raw) && (raw.archived === true || raw.in_trash === true);
      return { kind: "page", archived };
    }
    // A non-404 failure says nothing about the target's type, and a later probe
    // would only replace a useful error with a misleading 404.
    if (!isNotFound(res)) {
      return { kind: "unreadable", reason: (res.stderr || res.stdout).trim() };
    }
  }
  return { kind: "missing" };
}

/**
 * Block types that can nest a page or database inside a page.
 *
 * Deliberately narrow: `has_children` is set by structural blocks too (tables and
 * their rows), and treating all of them as subtree content would refuse to delete
 * any page containing a table. These are the containers a page can hide behind.
 */
const NESTING_BLOCK_TYPES = new Set([
  "toggle",
  "column_list",
  "column",
  "synced_block",
  "link_to_page",
  "template",
  "callout",
]);

/** How many block pages to walk before refusing; a page would need 10_000 blocks to hit it. */
const MAX_BLOCK_PAGES = 100;

/**
 * Direct child pages of one page, from `GET v1/blocks/{id}/children`.
 *
 * The walk follows EVERY page of the child list, not a fixed count: the default page
 * returns 100 BLOCKS (not 100 child pages), so a page with many paragraphs can hide child
 * pages on a later page. Stopping early would under-report the subtree and let the guard
 * approve a delete that removes children it never listed. The bound is a runaway guard
 * only, and reaching it refuses instead of guessing.
 *
 * One exception is deliberate: once a page has been found, a later block page that cannot
 * be READ stops the walk and reports what was found. The guard only needs a non-empty list
 * to refuse the delete (and it refuses before the caller can consent), so continuing to
 * spend round trips on a list whose verdict is already decided serves nothing.
 */
async function listChildPages(
  runner: NtnRunner,
  pageId: string,
  options: { failOnUnreadable: boolean }
): Promise<{ id: string; title: string }[]> {
  const children: { id: string; title: string }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_BLOCK_PAGES; page += 1) {
    const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : "";
    const result = await runner({ args: ["api", `v1/blocks/${pageId}/children${query}`] });
    if (!result.ok) {
      if (!options.failOnUnreadable && children.length > 0) return children;
      throw ntnFailure(`列出页面 ${pageId} 的子块`, result);
    }
    const parsed = parseJsonMaybe(result.stdout);
    if (!isPlainObject(parsed)) {
      if (!options.failOnUnreadable && children.length > 0) return children;
      // The child list is the ONLY evidence this guard has. An unparseable response
      // is "I could not enumerate", not "there are no children": treating it as empty
      // would approve a subtree delete blind, so refuse instead.
      throw inputError(
        `页面 ${pageId} 的子块列表无法解析，不能确认它有多少子页面，因此拒绝删除。` +
          `ntn 输出：${truncate((result.stdout || "").trim(), 200)}`,
        { id: pageId, enumerable: false }
      );
    }
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    for (const block of results) {
      if (!isPlainObject(block)) continue;
      if (typeof block.id !== "string") continue;
      if (block.type === "child_page") {
        const title =
          isPlainObject(block.child_page) && typeof block.child_page.title === "string"
            ? block.child_page.title
            : "(untitled)";
        children.push({ id: block.id, title });
        continue;
      }
      // An inline database is its own object with rows; it is archived with the page.
      if (block.type === "child_database") {
        const title =
          isPlainObject(block.child_database) && typeof block.child_database.title === "string"
            ? block.child_database.title
            : "(untitled database)";
        children.push({ id: block.id, title });
        continue;
      }
      // Only container types that can actually hold a page or database are walked.
      // `has_children` alone is far too broad: every table and table_row reports it,
      // which would make ordinary pages permanently undeletable. Toggles, columns,
      // synced blocks and links can nest a page, so they are reported.
      if (block.has_children === true && NESTING_BLOCK_TYPES.has(String(block.type))) {
        const type = String(block.type);
        const payload = isPlainObject(block[type]) ? block[type] : undefined;
        const title =
          payload && typeof payload.title === "string"
            ? payload.title
            : `(${type} block with nested content)`;
        children.push({ id: block.id, title });
      }
    }
    const hasMore = parsed.has_more === true;
    const next = typeof parsed.next_cursor === "string" ? parsed.next_cursor : undefined;
    if (!hasMore) return children;
    if (!next) {
      if (!options.failOnUnreadable && children.length > 0) return children;
      // More blocks exist but no cursor was offered: the enumeration is incomplete.
      throw inputError(
        `页面 ${pageId} 的子块报告 has_more=true 却没有 next_cursor，无法读完子页面列表，因此拒绝删除。`,
        { id: pageId, enumerable: false }
      );
    }
    cursor = next;
    if (page === MAX_BLOCK_PAGES - 1) {
      if (!options.failOnUnreadable && children.length > 0) return children;
      // Refuse rather than approve a delete over a subtree we could not enumerate.
      throw inputError(
        `页面 ${pageId} 的子块超过 ${MAX_BLOCK_PAGES} 页仍未列完，无法确认它有多少子页面，因此拒绝删除。` +
          "请在 Notion 里手动确认并删除。",
        { id: pageId, children_enumerated: children.length, enumerable: false }
      );
    }
  }
  return children;
}

/**
 * Trash one page, with three guards that a bare `ntn pages trash` does not give us.
 *
 *   1. A database or data source is refused outright: deleting one is far more
 *      destructive than deleting a page, so it stays a human decision.
 *   2. An already-archived page reports success instead of failing: Notion answers
 *      400 "Can't edit block that is archived", which reads like a fault and makes
 *      a retry look broken. Trash is naturally idempotent.
 *   3. A page with child pages is refused unless `recursive: true`, because Notion
 *      archives the whole subtree — the caller has to see what else would go.
 */
async function trashPage(
  params: { id: string; recursive: boolean },
  runner: NtnRunner
): Promise<PageToolValue> {
  const { id } = params;
  const target = await classifyTrashTarget(runner, id);
  if (target.kind === "unreadable") {
    throw ntnFailure(`确认页面 ${id} 的类型（page / database / data source）`, {
      ok: false,
      stdout: "",
      stderr: target.reason,
      code: null,
    });
  }
  if (target.kind === "missing") {
    throw new InputError(
      `页面 ${id} 不存在，或没有被当前的 Notion integration 共享（••• → Connections），因此无法删除。` +
        "请先用 notion_search 确认 id 正确。",
      { id, target: "missing" }
    );
  }
  if (target.kind === "database") {
    // Notion refusal here is a policy choice of the plugin, not a malformed argument,
    // so `inputError`'s "fix your arguments" framing would be misleading. Keep it
    // visible to the model as an unusable request.
    throw new InputError(
      `notion_page_trash cannot delete a database (id ${id}). Removing a database, its data ` +
        "sources and every row in them is far more destructive than deleting a page, so " +
        "this tool refuses even with yes: true. Ask the user to delete it in Notion " +
        "(••• → Delete) if that is really intended.",
      { id, target: "database", refused: "database_delete" }
    );
  }

  if (target.kind === "page" && target.archived) {
    // Nothing was written: the page was already in the trash. Saying "trashed" here
    // would claim an effect that did not happen and hide that from the caller.
    return pageValue({
      id,
      url: pageUrl(id),
      already_archived: true,
      properties: [],
      changed: [],
    });
  }

  if (target.kind === "page") {
    const children = await listChildPages(runner, id, { failOnUnreadable: !params.recursive });
    if (children.length > 0 && !params.recursive) {
      throw new InputError(
        `页面 ${id} 有 ${children.length} 个子页面。Notion 会连带归档整棵子树，` +
          "所以默认拒绝。确认要一起删除请加 recursive: true；只想删父页面请先在 Notion 里移走子页面。",
        {
          id,
          children: children.map((child) => child.id),
          child_pages: children,
          recursive_required: true,
        }
      );
    }
  }

  const result = await runner({ args: ["pages", "trash", id, "--yes"] });
  if (!result.ok) throw ntnFailure("ntn pages trash", result);

  return pageValue({ id, url: pageUrl(id), properties: [], changed: ["trashed"] });
}

/* ------------------------------------------------------------------ *
 * Parameter schemas (enforced DSH JSON Schema subset only)
 *
 * Allowed keywords: type / oneOf / properties / required / additionalProperties /
 * items / enum / const + description/title. NOT minLength, pattern, minimum,
 * maximum or format — the registry rejects those.
 * ------------------------------------------------------------------ */

/** Shared description of the `props` map; identical on create and edit. */
const PROPS_DESCRIPTION =
  "Object map of database column NAME → simplified value (e.g. {\"Status\":\"进行中\",\"标签\":[\"a\",\"b\"],\"截止日期\":\"2025-01-31\",\"Done\":true}); {} = no property write. " +
  "The value is converted by the column TYPE from the parent data source's schema: title/rich_text string; number number|numeric string; select/status string or {name} (\"\"/null clears); multi_select string[]; date \"YYYY-MM-DD\" | ISO string | {start,end?,time_zone?}; checkbox boolean; url/email/phone string (\"\"/null clears); people/relation string[] of ids. " +
  "null clears a property where Notion allows it, and an object carrying its own type key (e.g. {\"select\":{\"name\":\"Done\"}}) is sent as-is. " +
  "Unknown names and read-only columns (formula/rollup/created_time/…) are rejected with hint_properties. " +
  "COLUMNS ONLY: the page icon is the top-level icon parameter and the page body is the top-level body_content parameter, not props keys. No default property values are invented.";

const ICON_PARAMETERS = [
  { type: "string", description: "An emoji (\"🎯\") or an http(s) image URL." },
  { type: "object", additionalProperties: true, description: "An already-typed Notion icon object, e.g. {\"type\":\"emoji\",\"emoji\":\"🎯\"} or {\"type\":\"external\",\"external\":{\"url\":\"https://…/a.png\"}}." },
  { type: "null", description: "null clears the icon." },
];

/** Notion rejects an empty `old_str`; that is enforced in readContentEdits, not in the schema. */
const EDIT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    old_str: {
      type: "string",
      description:
        "Required, non-empty. The existing text to find. It matches the block's PLAIN TEXT, not its markdown: to find text shown as **bold** write `text` without the asterisks, and write a plain `$` where notion_get returned `\\$`. Cross-block matches use \\n or \\n\\n.",
    },
    new_str: {
      type: "string",
      description:
        "Required. The replacement text. \"\" DELETES old_str. It is markdown: a new_str containing \\n\\n creates separate blocks.",
    },
    replace_all_matches: {
      type: "boolean",
      description:
        "Default false: if old_str matches more than one place the whole call fails and NOTHING is written. Set true to replace every occurrence. This is detected by Notion, not locally, so the tool cannot say which of your edits was ambiguous in advance — narrow the old_str or set this flag.",
    },
  },
  required: ["old_str", "new_str"],
  additionalProperties: false,
};

const CREATE_PARAMETERS = {
  type: "object",
  properties: {
    parent: {
      type: "string",
      description:
        "Required. Where the page goes: page:<id> (child page), database:<id> | data-source:<id> (database row), or a bare page/row id (a bare ROW id means a child row, linked through that data source's Parent-item / self-relation column).",
    },
    title: {
      type: "string",
      description:
        "Page title. A row in a database needs one (here, or as the title property in props, or as a leading \"# Heading\" in body_content).",
    },
    props: { type: "object", additionalProperties: true, description: PROPS_DESCRIPTION },
    icon: { oneOf: ICON_PARAMETERS, description: "The page icon." },
    body_content: {
      type: "string",
      description: "The page body as Markdown. A leading \"# Heading\" becomes the title when title is absent.",
    },
  },
  required: ["parent"],
  additionalProperties: false,
};

const EDIT_PARAMETERS = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "Required. The page id (32 hex or dashed UUID) or its Notion URL.",
    },
    edits: {
      type: "array",
      items: EDIT_ITEM_SCHEMA,
      description:
        "Find-and-replace operations, applied in order (edit[i+1] sees edit[i]'s result). Max 100. " +
        "replace_all_matches belongs on the INDIVIDUAL edit object, not on the call. " +
        "THREE outcomes, do not conflate them: " +
        "(a) every edit matches -> call succeeds, `warnings` absent; " +
        "(b) SOME edit matches -> call SUCCEEDS (HTTP 200), the matched edits are applied, and each unmatched one comes back in `warnings` (code \"no_match\") with edits_applied/edits_missed carrying the tally — nothing is rolled back, so re-read the page before assuming what it contains; " +
        "(c) NO edit matches -> the call FAILS with a validation_error from Notion and nothing is written (this is Notion's rule, not a local pre-check) — treat it as \"my old_str were wrong\", re-read the page with notion_get and build new ones from that. " +
        "A MULTIPLE match is a different hard error: nothing is written at all unless that one edit sets replace_all_matches:true. " +
        "Omit `edits` and pass body_content to APPEND instead.",
    },
    body_content: {
      type: "string",
      description:
        "Markdown to APPEND at the end of the page. Only used when `edits` is empty or absent — this is the ONLY way to add new content, and edit never replaces the whole page. Passing body_content TOGETHER with a non-empty edits is an INVALID_INPUT error (nothing is written): append and find-replace cannot be combined in one call.",
    },
    props: { type: "object", additionalProperties: true, description: PROPS_DESCRIPTION },
    title: { type: "string", description: "New page title (writes the title property)." },
    icon: { oneOf: ICON_PARAMETERS, description: "New page icon; null clears it." },
    parent: {
      type: "string",
      description:
        "Move the page: page:<id> (under that page), or a bare PAGE id, or a bare ROW id (re-link the Parent-item relation of that row). Database/data source parents are not accepted — use notion_page_create to add a row.",
    },
    yes: {
      type: "boolean",
      description:
        "Only for a row→row move: consent to REPLACE the row's existing Parent-item link, which otherwise refuses with the current parent ids. Ignored nowhere else — passing it without parent is an error.",
    },
  },
  required: ["id"],
  additionalProperties: false,
};

const TRASH_PARAMETERS = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "Required. The page id (32 hex or dashed UUID) or its Notion URL.",
    },
    yes: {
      type: "boolean",
      description:
        "Required true. Without it the tool refuses without calling ntn, so a trash is never a guess.",
    },
    recursive: {
      type: "boolean",
      description:
        "Consent to delete the page together with its child pages (Notion archives the whole subtree). Without it a page that has child pages is refused with the child ids.",
    },
  },
  required: ["id", "yes"],
  additionalProperties: false,
};

/** Output schema: every field optional except ok; `changed` and `properties` are always sent. */
const PAGE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean", const: true },
    id: { type: "string" },
    url: { type: "string" },
    title: { type: "string" },
    parent: { type: "string" },
    properties: { type: "array", items: { type: "string" } },
    changed: { type: "array", items: { type: "string" } },
    icon: { oneOf: [{ type: "string" }, { type: "null" }] },
    created: { type: "boolean", const: true },
    parent_item_row_id: { type: "string" },
    parent_item_property: { type: "string" },
    already_linked: { type: "boolean" },
    already_archived: { type: "boolean" },
    replaced_parent_ids: { type: "array", items: { type: "string" } },
    cycle_check: { type: "string" },
    warnings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["code", "message"],
        additionalProperties: false,
      },
    },
    appended: { type: "boolean", const: true },
    edits_sent: { type: "integer" },
    edits_applied: { type: "integer" },
    edits_missed: { type: "integer" },
    truncated: { type: "boolean", const: true },
  },
  required: ["ok", "properties", "changed"],
  additionalProperties: false,
};

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/** `notion_page_create` — one page (or database row), with its columns, icon and body. */
export function createNotionPageCreateTool(deps: NotionPageDeps = {}): NotionTool<PageToolValue> {
  const runner: NtnRunner = deps.runNtn ?? runNtn;

  return defineNotionTool<PageToolValue>({
    name: "notion_page_create",
    description:
      "Create one Notion page or database row. " +
      "parent is required: page:<id> (child page), database:<id> | data-source:<id> (a row in that database), " +
      "or a bare page/row id (a bare ROW id means a child row, linked through that data source's Parent-item / " +
      "self-relation column). " +
      "body_content is the page Markdown and icon is the page icon — both are TOP-LEVEL parameters, not props keys. " +
      "props carries database COLUMNS only (name → simplified value), converted by the parent's column types; " +
      "unknown names and read-only columns are rejected with the writable ones in hint_properties. " +
      "A page inside a database still needs a title (the title parameter, the title property in props, or a " +
      "leading \"# Heading\" in body_content). " +
      "The columns and icon are written by a second request; if that request fails the new page is trashed so no " +
      "half-made page is left behind, and the error says whether cleanup worked (rollback: trashed | trash_failed | " +
      "unknown_id; partial:true means something was left behind). " +
      "To add content later use notion_page_edit (find-and-replace or append); this tool never edits an existing page.",
    timeoutMs: TOOL_TIMEOUTS.page,
    // Every operation here can write, so page calls stay exclusive: never overlap two.
    isConcurrencySafe: () => false,
    parameters: CREATE_PARAMETERS as unknown as JsonObject,
    output: {
      schema: PAGE_OUTPUT_SCHEMA as unknown as JsonObject,
      render: (_args, value) => textBlocks(describePageValue(value)),
    },

    async execute(args, exec) {
      rejectUnexpectedParams(
        args,
        ["parent", "title", "props", "icon", "body_content"],
        "notion_page_create 只接受 { parent, title, props, icon, body_content }。"
      );
      if (exec.signal?.aborted) throw abortError();

      // Read every argument once and keep the normalized value: parsing twice would let
      // the two parses disagree on what `undefined` vs "provided" means.
      const title = normalizeTitle(args.title);
      const props = normalizeProps(args.props);
      const icon = normalizeIcon(args.icon);
      const body = normalizeBody(args.body_content, false);
      const params: CreateParams = {
        parent: args.parent,
        ...(title ? { title } : {}),
        ...(props ? { props } : {}),
        ...(icon ? { icon } : {}),
        ...(body === undefined ? {} : { body }),
      };
      // Every ntn spawn of this call observes the call's cancellation signal.
      return await createPage(params, bindSignal(runner, exec.signal));
    },
  });
}

/** `notion_page_edit` — find-and-replace body text, append, change columns/title/icon, move. */
export function createNotionPageEditTool(deps: NotionPageDeps = {}): NotionTool<PageToolValue> {
  const runner: NtnRunner = deps.runNtn ?? runNtn;

  return defineNotionTool<PageToolValue>({
    name: "notion_page_edit",
    description:
      "Change an existing Notion page: find-and-replace its text, append Markdown, update title/columns/icon, " +
      "and/or move it. A single call may combine all of these; they are applied in this fixed order — " +
      "(1) body content, (2) title/props/icon, (3) parent move — and `changed` reports each one that happened. " +
      "CONTENT: `edits` is a list of {old_str, new_str} operations applied in order, so edit[i+1] sees edit[i]'s " +
      "result. old_str matches the block's PLAIN TEXT, not its markdown: write `text` for **text**, and a plain $ " +
      "where notion_get showed \\$; a match can span blocks with \\n. new_str \"\" DELETES the matched text. " +
      "MATCH OUTCOMES, three distinct cases — do not conflate them. " +
      "(a) EVERY edit matches: call succeeds, `warnings` is absent. " +
      "(b) SOME edit matches: the call SUCCEEDS, the matching edits stay applied, the unmatched ones come back in " +
      "`warnings` (code \"no_match\") and edits_applied/edits_missed give the tally — nothing is rolled back, so " +
      "re-read the page before assuming what it now contains; `warnings` is ABSENT when nothing missed (it is never " +
      "an empty array). " +
      "(c) NO edit matches: the call FAILS with Notion's validation_error and nothing is written. That is Notion's " +
      "rule, not a local pre-check — treat it as \"my old_str were wrong\": re-read the page with notion_get and " +
      "build new old_str from what it actually says. " +
      "SEPARATELY, an old_str matching MORE THAN ONE place is also a hard error with nothing written, unless THAT " +
      "edit sets replace_all_matches:true. " +
      "There is NO whole-page replace: when `edits` is empty or absent and body_content is present, body_content is " +
      "APPENDED to the end of the page (passing both edits and body_content is an error — do it in two calls). " +
      "FIELDS: icon and body_content are TOP-LEVEL parameters, not props keys; props carries database COLUMNS " +
      "only (name → simplified value, converted by column type). " +
      "MOVE: parent page:<id> (or a bare page id) re-parents the page via POST /v1/pages/{id}/move; a bare ROW id " +
      "re-links that row's Parent-item relation. Re-linking a row that already has a different parent needs " +
      "yes:true (otherwise it refuses and shows the current parent ids); cycle-forming moves are refused. " +
      "If step (2) or (3) fails after content was already written, the error says exactly what already landed — " +
      "read it before retrying. When the returned body was truncated the result says so: truncated markdown is NOT " +
      "the full page, so do not derive the next old_str from it.",
    timeoutMs: TOOL_TIMEOUTS.page,
    isConcurrencySafe: () => false,
    parameters: EDIT_PARAMETERS as unknown as JsonObject,
    output: {
      schema: PAGE_OUTPUT_SCHEMA as unknown as JsonObject,
      render: (_args, value) => textBlocks(describePageValue(value)),
    },

    async execute(args, exec) {
      rejectUnexpectedParams(
        args,
        ["id", "edits", "body_content", "props", "title", "icon", "parent", "yes"],
        "notion_page_edit 只接受 { id, edits, body_content, props, title, icon, parent, yes }。"
      );
      if (exec.signal?.aborted) throw abortError();
      const id = requireId(args.id, "edit");

      const normalizedProps = normalizeProps(args.props);
      const { edits, props } = withEditAlias(readContentEdits(args.edits), normalizedProps);
      const body = normalizeBody(args.body_content, false);
      const icon = normalizeIcon(args.icon);
      const title = normalizeTitle(args.title);

      // `yes` is consent for ONE thing (replacing a row's Parent-item link). Without a
      // parent there is nothing it could consent to, and accepting it silently would let a
      // caller believe it authorized something it did not.
      const hasYes = args.yes !== undefined;
      const yes = hasYes ? readBoolean(args.yes, "yes") : false;
      if (hasYes && args.parent === undefined) {
        throw new InputError(
          "yes 只用于「行→行移动时覆盖已有 Parent-item 链接」，没有 parent 时传 yes 没有意义；请去掉 yes。本次没有写入。",
          { field: "yes" }
        );
      }

      const appends = body !== undefined && body.trim() !== "";
      // `edits` and `body_content` are two different content operations (find-and-replace
      // vs append). Running one and silently dropping the other would report success for a
      // write that never happened, so the combination is refused instead of guessed.
      if (edits.length > 0 && body !== undefined) {
        throw new InputError(
          "edits（查找替换）和 body_content（追加到末尾）不能同时传：二选一。" +
            "需要既改又追加时请分两次调用 notion_page_edit。本次没有写入。",
          { conflict: true, fields: ["edits", "body_content"] }
        );
      }
      if (edits.length === 0 && !appends && props === undefined && title === undefined && icon === undefined && args.parent === undefined) {
        throw new InputError(
          "notion_page_edit 需要 edits、body_content、props、title、icon、parent 至少一项；空调用不会修改页面。" +
            (body !== undefined
              ? "body_content 是空白：追加空白内容不会修改页面。"
              : "要追加内容请传 body_content（不传 edits）。")
        );
      }

      const params: EditParams = {
        id,
        edits,
        ...(appends ? { body } : {}),
        ...(props ? { props } : {}),
        ...(title ? { title } : {}),
        ...(icon ? { icon } : {}),
        ...(args.parent === undefined ? {} : { parent: args.parent }),
        yes,
      };
      return await editPage(params, bindSignal(runner, exec.signal));
    },
  });
}

/** `notion_page_trash` — delete one page (or row), with the three guards. */
export function createNotionPageTrashTool(deps: NotionPageDeps = {}): NotionTool<PageToolValue> {
  const runner: NtnRunner = deps.runNtn ?? runNtn;

  return defineNotionTool<PageToolValue>({
    name: "notion_page_trash",
    description:
      "Move one Notion page or database row to the trash. " +
      "yes:true is required, otherwise nothing is called. " +
      "Three guards a bare delete does not give you: a database or data source is refused even with yes:true " +
      "(deleting one destroys its rows too — ask the user to do it in Notion); a page that is already in the trash " +
      "returns success with already_archived:true instead of an error; and a page with child pages is refused " +
      "unless recursive:true, because Notion archives the whole subtree — the error lists the child ids so you can " +
      "show the user exactly what else would go. Trash is idempotent: calling it twice is safe.",
    timeoutMs: TOOL_TIMEOUTS.page,
    isConcurrencySafe: () => false,
    parameters: TRASH_PARAMETERS as unknown as JsonObject,
    output: {
      schema: PAGE_OUTPUT_SCHEMA as unknown as JsonObject,
      render: (_args, value) => textBlocks(describePageValue(value)),
    },

    async execute(args, exec) {
      rejectUnexpectedParams(
        args,
        ["id", "yes", "recursive"],
        "notion_page_trash 只接受 { id, yes, recursive }。"
      );
      if (exec.signal?.aborted) throw abortError();
      if (args.yes === undefined || !readBoolean(args.yes, "yes")) {
        throw new InputError(
          'notion_page_trash 会删除（移入回收站）页面，必须显式传 yes: true（或 "true" / "yes" / 1）才会调用 ntn；本次没有调用 ntn。',
          { yes: args.yes }
        );
      }
      const params = {
        id: requireId(args.id, "trash"),
        recursive: args.recursive === undefined ? false : readBoolean(args.recursive, "recursive"),
      };
      return await trashPage(params, bindSignal(runner, exec.signal));
    },
  });
}
