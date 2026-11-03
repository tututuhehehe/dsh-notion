/**
 * notion_page — create / edit / attach / trash one Notion page through the official `ntn` CLI.
 *
 * Every `ntn` invocation goes through {@link NtnRunner} (default: `src/lib/runNtn.ts`).
 * The model never gets a free-form `ntn api` call: the only API paths used here are
 *   GET   v1/pages/{id}                (classify a bare parent id; read a page's parent)
 *   GET   v1/data_sources/{id}         (property schema; a database has no schema in 2025-09+)
 *   PATCH v1/pages/{id}                (property whitelist + icon; see below)
 *   POST  v1/pages/{id}/move           (attach a page under a page)
 *   `ntn datasources resolve <db-id>`  (database id → its unique data source)
 * and each is built from a validated id, never from raw model text.
 *
 * Reserved `props` keys (never columns):
 *   - `props.body_content` : the page Markdown body.
 *   - `props.icon`         : the page icon. An emoji (`"🎯"`), an http(s) image URL, an
 *                            already-typed Notion icon object, or `null` to clear it.
 *   A data source that really has a column with either name makes any write carrying that
 *   reserved key fail instead of silently writing the column.
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
 * Parent resolution (create/attach):
 *   page:<id>          child page under that page
 *   <bare page id>     same, after checking the id is not a database row
 *   <bare row id>      child row in the row's data source + Parent-item relation set
 *   data-source:<id>   peer row in that data source
 *   database:<id>      resolved through `ntn datasources resolve` to its unique data
 *                      source (several → error listing the ids, never a guess)
 *
 * `attach` (NOT a file upload, and not a rename of `move`): re-parents an existing page.
 *   page → page : POST v1/pages/{id}/move
 *   row  → row  : PATCH the Parent-item / self-relation column of the moved row
 *
 * Attach guards:
 *   - row→row refuses cycles: walk the Parent-item chain up from the prospective parent
 *     inside the same data source; an unreadable ancestor refuses instead of guessing.
 *   - row→row refuses to replace a different existing parent unless `yes: true`; the
 *     overwrite REPLACES the relation. Re-attaching the same parent is a no-op.
 *   - page→page refuses self and already-child; deeper page cycles use a best-effort
 *     `parent.page_id` walk (GET per ancestor) and report `cycle_check`.
 *
 * Create is two writes (pages create + one property/Parent-item/icon PATCH). If the PATCH
 * fails the new page is trashed immediately; the error carries `partial` (false when
 * the workspace is clean again), `created_id`, and `rollback` ("trashed" | "trash_failed"
 * | "unknown_id"). Only a structured JSON page id is ever used as a trash target.
 */
import {
  abortError,
  bindSignal,
  defineNotionTool,
  inputError,
  NOTION_ERROR_CODES,
  NotionToolError,
  readBoolean,
  readEnum,
  textBlocks,
  TOOL_TIMEOUTS,
} from "../dsh/tool.ts";
import type { NotionTool } from "../dsh/tool.ts";
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

type JsonObject = Record<string, unknown>;
type ParentKind = "page" | "database" | "data_source";

/** Reserved props key: the Markdown body, never a column write. */
const BODY_CONTENT_KEY = "body_content";
/** Reserved props key: the page icon (emoji / external URL / null to clear), never a column. */
const ICON_KEY = "icon";

export interface NotionPageParams {
  action: "create" | "edit" | "attach" | "trash";
  id?: string;
  parent?: string;
  title?: string;
  props?: Record<string, unknown>;
  yes?: boolean;
  /**
   * trash only: consent to delete a page together with its child pages. Notion
   * archives the whole subtree, so this must be explicit.
   */
  recursive?: boolean;
  /**
   * edit only: consent to replace a substantial body with text under half its
   * current length. `body_content` REPLACES the page, so this separates "I meant
   * to rewrite it" from "I meant to fix one paragraph".
   */
  confirm_shrink?: boolean;
}

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

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_RE = /^[0-9a-f]{32}$/i;

function isNotionId(value: string): boolean {
  return UUID_RE.test(value) || HEX32_RE.test(value);
}

/** Validation failure the model can correct: reported as the call's error, without a stack. */
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
 * The column `attach`/child-row create writes. The selector itself lives in
 * `src/lib/properties.ts` so `notion_get` advertises exactly the same column.
 */
function findParentItemProperty(
  schema: PropertySchemaSet,
  dataSourceId: string
): PropertySchema | undefined {
  return selectParentItemProperty(schema.properties.values(), dataSourceId);
}

interface NormalizedProps {
  props?: Record<string, unknown>;
  /** Markdown body from the reserved `body_content` key. */
  body?: string;
  /** True when the caller supplied `body_content` at all (even an empty string). */
  hasBody: boolean;
  /** Notion `icon` payload from the reserved `icon` key. */
  icon?: NormalizedIcon;
}

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

function normalizeIcon(raw: unknown): NormalizedIcon | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return { payload: null, display: null };

  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) {
      throw new InputError(
        `props.${ICON_KEY} 不能是空字符串：不设置 icon 就省略这个键，清除已有 icon 请传 null。`,
        { property: ICON_KEY }
      );
    }
    if (HTTP_URL_RE.test(value)) {
      return { payload: { type: "external", external: { url: value } }, display: value };
    }
    if ([...value].length > MAX_EMOJI_LENGTH) {
      throw new InputError(
        `props.${ICON_KEY} 看起来既不是 emoji 也不是图片 URL（长度 ${[...value].length}）：` +
          `${describeValue(value)}。请传单个 emoji（如 "🎯"）、http(s) 图片 URL，或 null 清除。`,
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
          `props.${ICON_KEY} 的 emoji 对象缺少 emoji 文本：需要 { "type": "emoji", "emoji": "🎯" }。`,
          { property: ICON_KEY }
        );
      }
      return { payload: { type: "emoji", emoji }, display: emoji };
    }
    if (type === "external") {
      const url = isPlainObject(raw.external) ? raw.external.url : undefined;
      if (typeof url !== "string" || !HTTP_URL_RE.test(url.trim())) {
        throw new InputError(
          `props.${ICON_KEY} 的 external 对象需要一个 http(s) url：` +
            `{ "type": "external", "external": { "url": "https://…/a.png" } }。`,
          { property: ICON_KEY }
        );
      }
      return { payload: { type: "external", external: { url: url.trim() } }, display: url.trim() };
    }
    if (type === "custom_emoji" || type === "file") {
      // Escape hatch: a caller that already knows the exact Notion payload wins.
      return { payload: raw, display: `${String(type)} icon` };
    }
    throw new InputError(
      `props.${ICON_KEY} 的对象形式必须带 type：接受 "emoji" / "external" / "custom_emoji" / "file"，` +
        `或直接传 emoji 字符串、图片 URL、null。收到 ${describeValue(raw)}。`,
      { property: ICON_KEY, value: raw }
    );
  }

  throw new InputError(
    `props.${ICON_KEY} 必须是 emoji 字符串、http(s) 图片 URL、已构好的 Notion icon 对象，或 null（清除）；` +
      `收到 ${describeValue(raw)}。`,
    { property: ICON_KEY, value: raw }
  );
}

/**
 * `props` must be an object map. `{}`/absent means "no property write".
 * Arrays (the old/naive shape) are rejected explicitly, with the fix in the message.
 * `body_content` and `icon` are split out: they are page-level fields, not columns.
 */
function normalizeProps(raw: unknown): NormalizedProps {
  if (raw === undefined || raw === null) return { hasBody: false };
  if (Array.isArray(raw)) {
    throw new InputError(
      "props 必须是对象 map（{属性名: 值}），不是数组。例如 {\"Status\":\"进行中\",\"标签\":[\"a\",\"b\"]}。"
    );
  }
  if (!isPlainObject(raw)) {
    throw new InputError(`props 必须是对象 map（{属性名: 值}），收到 ${describeValue(raw)}。`);
  }

  const rest: Record<string, unknown> = {};
  let body: string | undefined;
  let hasBody = false;
  let icon: NormalizedIcon | undefined;
  for (const [name, value] of Object.entries(raw)) {
    if (name === BODY_CONTENT_KEY) {
      hasBody = true;
      if (value === undefined) continue;
      if (typeof value !== "string") {
        throw new InputError(
          `props.${BODY_CONTENT_KEY} 必须是 Markdown 字符串（页面正文），收到 ${describeValue(value)}。`,
          { property: BODY_CONTENT_KEY }
        );
      }
      body = value;
      continue;
    }
    if (name === ICON_KEY) {
      icon = normalizeIcon(value);
      continue;
    }
    if (value === undefined) continue;
    rest[name] = value;
  }

  const entries = Object.entries(rest);
  return {
    ...(entries.length ? { props: Object.fromEntries(entries) } : {}),
    ...(body !== undefined ? { body } : {}),
    hasBody,
    ...(icon ? { icon } : {}),
  };
}

/**
 * Both reserved keys must not collide with a real column of the same name: guessing
 * whether the caller meant the column or the reserved field would write the wrong thing.
 */
function assertReservedKeysAvailable(
  schema: PropertySchemaSet,
  hasBody: boolean,
  icon: NormalizedIcon | undefined
): void {
  const conflicts = [
    ...(hasBody && schema.properties.has(BODY_CONTENT_KEY) ? [BODY_CONTENT_KEY] : []),
    ...(icon && schema.properties.has(ICON_KEY) ? [ICON_KEY] : []),
  ];
  if (conflicts.length === 0) return;
  const described = conflicts
    .map((name) =>
      name === BODY_CONTENT_KEY ? `"${name}"（保留键：页面正文）` : `"${name}"（保留键：页面 icon）`
    )
    .join("、");
  throw new InputError(
    `data source 里存在名为 ${described} 的真实列，与保留键同名。` +
      `不能同时当作列名写入，请先重命名该列，或不使用该保留键；本次没有写入任何内容。`,
    {
      conflict: true,
      reserved_keys: conflicts,
      ...(schema.dataSourceId ? { dataSourceId: schema.dataSourceId } : {}),
    }
  );
}

function normalizeTitle(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new InputError("title 必须是字符串。");
  if (/[\r\n]/.test(raw)) throw new InputError("title 不能包含换行。");
  const title = raw.trim();
  return title || undefined;
}

function parseParentSpec(raw: unknown, action: "create" | "attach"): ParentSpec {
  const usage =
    action === "attach"
      ? "page:<id>（把页面挂到该页面下）或父行 id（把行挂到父行下）"
      : "page:<id>、database:<id>、data-source:<id>，或数据库行 id（作为子行父级）";
  if (typeof raw !== "string" || !raw.trim()) {
    throw new InputError(`${action} 需要 parent：${usage}。`);
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
function requireId(raw: unknown, action: "edit" | "attach" | "trash"): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new InputError(
      `${action} 需要 id：页面 id（32 位 hex 或带连字符的 UUID）或该页面的 Notion URL。`
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

/**
 * Read the tolerated scalar arguments once, so every action sees a normalized shape.
 *
 * `yes` arrives as `true`, `"true"`, `"yes"`, `1` or `"1"` depending on the caller;
 * all of them mean consent, and only an explicit falsy value means no consent.
 * `title` keeps its own validation (no newlines) so it is left as authored.
 */
/**
 * Fold the top-level `content` alias into `props.body_content`.
 *
 * `content` is the name a caller reaches for first — body text is not a column, so
 * looking for it under `props` is unintuitive. Accepting it costs nothing and saves
 * the round trip a rejection would cause. Passing both is genuinely ambiguous, so
 * that case is refused rather than picking one.
 */
function withBodyAlias(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const props = raw.props;
  if (raw.content === undefined) return props === undefined ? undefined : (props as Record<string, unknown>);
  if (!isPlainObject(props)) {
    if (props !== undefined) return props as Record<string, unknown>;
    return { body_content: raw.content };
  }
  if (props.body_content !== undefined) {
    throw inputError(
      "content 和 props.body_content 是同一个东西，不要同时传（把正文写在其中一个里即可）。",
      { content: raw.content }
    );
  }
  return { ...props, body_content: raw.content };
}

function normalizePageArgs(raw: Record<string, unknown>, action: Action): NotionPageParams {
  const yes = raw.yes === undefined ? undefined : readBoolean(raw.yes, "yes");
  const props = withBodyAlias(raw);
  if (action === "trash" && yes !== true) {
    throw inputError(
      'trash 会删除（移入回收站）页面，必须显式传 yes: true（或 "true" / "yes" / 1）才会调用 ntn；本次没有调用 ntn。',
      { action, yes: raw.yes }
    );
  }
  return {
    action,
    ...(raw.id === undefined ? {} : { id: raw.id as string }),
    ...(raw.parent === undefined ? {} : { parent: raw.parent as string }),
    ...(raw.title === undefined ? {} : { title: raw.title as string }),
    ...(props === undefined ? {} : { props: props as Record<string, unknown> }),
    ...(yes === undefined ? {} : { yes }),
    ...(raw.recursive === undefined
      ? {}
      : { recursive: readBoolean(raw.recursive, "recursive") }),
    ...(raw.confirm_shrink === undefined
      ? {}
      : { confirm_shrink: readBoolean(raw.confirm_shrink, "confirm_shrink") }),
  };
}

/** Parameters each action may carry; anything else is a caller mistake, not something to ignore. */
const ALLOWED_PARAMS: Record<Action, readonly string[]> = {
  create: ["action", "parent", "title", "props"],
  edit: ["action", "id", "title", "props", "confirm_shrink"],
  attach: ["action", "id", "parent", "yes"],
  trash: ["action", "id", "yes", "recursive"],
};

const UNEXPECTED_PARAMS_MESSAGE: Record<Action, string> = {
  create: "create 只接受 { action, parent, title, props }（正文写在 props.body_content）。",
  edit: "edit 只接受 { action, id, title, props, confirm_shrink }（正文写在 props.body_content）。",
  attach:
    "attach 只接受 { action, id, parent, yes }，不接受 props/title（也就没有 body_content）；改内容或标题请用 edit。yes 只用于同意覆盖已有的 Parent-item 链接。",
  trash: "trash 只接受 { action, id, yes, recursive }。",
};

/** Top-level parameters accepted as aliases for a reserved props key. */
const TOP_LEVEL_BODY_ALIAS = "content";

function rejectUnexpectedParams(params: Record<string, unknown>, action: Action): void {
  const allowed = [...ALLOWED_PARAMS[action], TOP_LEVEL_BODY_ALIAS];
  const unexpected = Object.keys(params).filter(
    (key) => params[key] !== undefined && !allowed.includes(key)
  );
  if (unexpected.length > 0) {
    throw new InputError(
      `${UNEXPECTED_PARAMS_MESSAGE[action]} 多余的参数：${unexpected.join(", ")}。`,
      { unexpected_params: unexpected }
    );
  }
}

/* ------------------------------------------------------------------ *
 * Schema resolution (C4: never read properties from v1/databases)
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

/** What attach needs from GET v1/pages/{id}: the parent and the current property values. */
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
 * Memoized page reader for one attach call: the parent row is fetched once for
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
 * Refuse a row attach that would close a Parent-item cycle.
 *
 * Walks up from the prospective parent through the same self-relation column, in the same
 * data source. A parent chain that cannot be read is refused too: attach must not write a
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
 * Page→page attach only refuses the cheap cases exactly (self, already-child); this walk
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
  action: "create" | "attach",
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
        `${action} 的裸 id 必须是页面或数据库行；如果它是 database 或 data source，请写成 database:<id> / data-source:<id>。`,
      { parent: id }
    );
  }
  const parent = page.parent;
  if (!parent) {
    throw new InputError(
      `无法把 ${id} 当作 parent：GET v1/pages 没有返回 parent。` +
        `${action} 的裸 id 必须是页面或数据库行；如果它是 database 或 data source，请写成 database:<id> / data-source:<id>。`,
      { parent: id }
    );
  }
  if (parent.kind === "page") return { kind: "page" };
  return { kind: "row", schemaParent: parent };
}

async function resolveContainer(
  runner: NtnRunner,
  raw: unknown,
  action: "create" | "attach",
  readPage?: (pageId: string) => Promise<PageObject>
): Promise<Container> {
  const spec = parseParentSpec(raw, action);

  if (spec.bare) {
    const target = await classifyBareParent(runner, spec.id, action, readPage);
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
 * Markdown title handling
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

function pageUrlFromRaw(raw: unknown, pageId: string): string {
  if (isPlainObject(raw) && typeof raw.url === "string" && raw.url.startsWith("http")) return raw.url;
  return pageUrl(pageId);
}

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

type Action = "create" | "edit" | "attach" | "trash";

/**
 * The canonical JSON value of a successful `notion_page` call. The model-facing text is
 * derived from it by {@link describePageValue}, so the value stays a domain DTO rather
 * than a copy of the rendered content.
 */
export type PageToolValue = {
  ok: true;
  action: Action;
  id?: string;
  url?: string;
  title?: string;
  parent?: string;
  /** Names of the properties actually written (empty = none). */
  properties: string[];
  /** What changed: "body_content" | "properties" | "parent" | "parent_item_relation" | "trashed" */
  changed: string[];
  /** Icon as sent: an emoji, an image URL, a description, or null when cleared. */
  icon?: string | null;
  /**
   * edit with `body_content`: how much text the page had before and after.
   *
   * `ntn pages edit --content` REPLACES the whole body, so this is the only
   * signal that distinguishes "I edited one section" from "I deleted every other
   * section". Always present when the body was replaced.
   */
  body_chars_before?: number;
  body_chars_after?: number;
  /** create when the parent was a database row. */
  parent_item_row_id?: string;
  parent_item_property?: string;
  /** attach: the page/row is already under the requested parent; nothing was written. */
  already_linked?: boolean;
  /** trash: the target was already in the trash, so the call succeeded without a write. */
  already_archived?: boolean;
  /** attach row→row: the Parent-item values that were replaced. */
  replaced_parent_ids?: string[];
  /** attach: how far the cycle check got ("walked" | "partial" | "cycle"). */
  cycle_check?: string;
};

/** Model-facing text for a canonical create/edit/attach/trash value. */
export function describePageValue(value: PageToolValue): string {
  const props = value.properties.join(", ");
  if (value.action === "create") {
    return [
      `已创建页面${value.title ? ` "${value.title}"` : ""}${value.id ? `：${value.id}` : ""}`,
      value.url ? `URL: ${value.url}` : "",
      value.parent ? `parent: ${value.parent}` : "",
      value.parent_item_row_id ? `Parent-item → ${value.parent_item_row_id}` : "",
      value.properties.length ? `已写入属性：${props}` : "未写入属性（props 为空）",
      value.icon !== undefined ? `icon: ${value.icon ?? "（已清除）"}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (value.action === "edit") {
    const what = value.changed.includes("body_content") ? "内容" : "属性";
    const size =
      value.body_chars_before !== undefined && value.body_chars_after !== undefined
        ? `正文已整页替换：${value.body_chars_before} 字 → ${value.body_chars_after} 字`
        : "";
    return [
      `已更新页面 ${value.id} 的${what}`,
      size,
      value.url ? `URL: ${value.url}` : "",
      value.changed.includes("body_content") && value.changed.includes("properties")
        ? `已写入属性：${props}`
        : value.properties.length
          ? `属性：${props}`
          : "",
      value.icon !== undefined ? `icon: ${value.icon ?? "（已清除）"}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (value.action === "attach") {
    if (value.already_linked) {
      return [
        `行 ${value.id} 已经在父行 ${value.parent_item_row_id} 下（Parent-item 列：${value.parent_item_property}），无需改动`,
        value.url ? `URL: ${value.url}` : "",
        "changed: (none)",
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (value.parent_item_property) {
      return [
        `已把行 ${value.id} 挂到父行 ${value.parent_item_row_id} 下`,
        `Parent-item 列：${value.parent_item_property}`,
        value.replaced_parent_ids?.length
          ? `替换了原来的父级：${value.replaced_parent_ids.join(", ")}`
          : "",
        value.url ? `URL: ${value.url}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    return [
      `已把页面 ${value.id} 挂到 ${value.parent} 下`,
      value.url ? `URL: ${value.url}` : "",
      value.cycle_check === "partial"
        ? "注意：页面祖先链未能完整读取，深层环检查为 best-effort（cycle_check: partial）"
        : "",
      "changed: parent",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (value.already_archived) {
    return [
      `页面 ${value.id} 本来就在回收站里，本次没有执行删除`,
      value.url ? `URL: ${value.url}` : "",
      "changed: (none)",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [`已把页面 ${value.id} 移入回收站`, value.url ? `URL: ${value.url}` : ""]
    .filter(Boolean)
    .join("\n");
}

/** Build the canonical value of a successful action. */
function pageValue(
  action: Action,
  fields: Omit<PageToolValue, "ok" | "action" | "properties" | "changed"> & {
    properties?: string[];
    changed: string[];
  }
): PageToolValue {
  return { ok: true, action, properties: [], ...fields };
}

/* ------------------------------------------------------------------ *
 * Actions (deps.runNtn is the only way ntn is spawned)
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
      `该页面/行仍然存在（partial: true）。请手动清理：notion_page { action: "trash", id: "${pageId}", yes: true }。`
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

async function createPage(
  params: NotionPageParams,
  runner: NtnRunner
): Promise<PageToolValue> {
  const { props, body, hasBody, icon } = normalizeProps(params.props);
  const explicitTitle = normalizeTitle(params.title);

  // Resolving the container also resolves the schema (C4: via data source, not database).
  // The reader memoizes GET v1/pages so a bare row parent is fetched once.
  const readPage = makePageReader(runner);
  const container = await resolveContainer(runner, params.parent, "create", readPage);
  assertReservedKeysAvailable(container.schema, hasBody, icon);

  const markdown = body ?? "";

  let properties: JsonObject = {};
  let propertyNames: string[] = [];
  let propsTitle: string | undefined;
  if (props) {
    const built = buildProperties(container.schema, props);
    properties = built.properties;
    propertyNames = built.names;
    propsTitle = built.title;
    // The explicit `title` argument wins over a value for the title property in props.
    if (explicitTitle) {
      const titleName = titlePropertyName(container.schema);
      if (!titleName) {
        throw new InputError(
          `无法确定 ${container.schema.source} 的标题属性，不能用 title 指定标题；请改用 props 并指定标题属性名。`
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
      `在 ${container.kind === "row" ? `行 ${container.rowParentId} 所在 data source` : container.kind} 中创建页面需要标题：` +
        `请传 title、在 props 里写标题属性（${titlePropertyName(container.schema) ?? "title"}），` +
        `或让 props.body_content 以 "# 标题" 开头。可写属性：${formatHints(hints)}。`,
      { parent: formatParent(container.createParent), hint_properties: hints }
    );
  }

  // `ntn pages create` rejects empty Markdown ("Markdown content cannot be empty.")
  // with exit 5. A title-only create is fine because frontmatter makes the body
  // non-empty, but a bare `parent` with no title cannot create a page.
  if (!draft.body.trim()) {
    throw new InputError(
      "create 需要 props.body_content 或 title：ntn pages create 不接受空 Markdown，只有 parent 无法创建空白页面。"
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

  // The follow-up PATCH is one request that carries every property plus the icon, so a
  // page created with only an icon still gets its icon (no properties were written).
  const needsPatch = propertyNames.length > 0 || icon !== undefined;
  if (needsPatch) {
    if (!structuredId) {
      throw new InputError(
        `页面已创建（parent ${formatParent(container.createParent)}），但没有从 ntn 的结构化输出里取到页面 id，` +
          `${propertyNames.length > 0 ? "props 和 icon 都" : "icon"}未写入。` +
          `没有可信 id 就不自动 trash（避免误删），请用 notion_search/notion_get 找到该页面后，` +
          `用 notion_page edit 写入，或 notion_page trash 删除（partial: true，rollback: unknown_id）。`,
        {
          parent: formatParent(container.createParent),
          partial: true,
          rollback: "unknown_id",
          ...(pageId ? { id_candidate: pageId } : {}),
          stdout: truncate(createResult.stdout.trim()),
        }
      );
    }
    const patchResult = await runner({ args: patchArgs(structuredId, properties, icon) });
    if (!patchResult.ok) {
      throw await rollbackCreatedPage(
        runner,
        structuredId,
        ntnFailure(
          "PATCH 页面属性/icon",
          patchResult,
          container.kind === "row"
            ? `子行已创建（id ${structuredId}），但属性/Parent-item relation/icon 未写入`
            : `页面已创建（id ${structuredId}），但属性/icon 未写入`
        )
      );
    }
  }

  return pageValue("create", {
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
    changed: [
      ...(propertyNames.length > 0 || container.kind === "row" ? ["properties"] : []),
      ...(icon ? ["icon"] : []),
    ],
  });
}

async function editPage(
  params: NotionPageParams,
  runner: NtnRunner
): Promise<PageToolValue> {
  const id = requireId(params.id, "edit");
  const { props, body, hasBody, icon } = normalizeProps(params.props);
  const explicitTitle = normalizeTitle(params.title);
  // Whitespace-only body is treated as "not provided": `pages edit --content ""`
  // would otherwise silently replace the page with nothing.
  const markdown = body !== undefined && body.trim() !== "" ? body : undefined;

  if (!markdown && !props && !explicitTitle && icon === undefined) {
    throw new InputError(
      "edit 需要 props（含 props.body_content / props.icon）、title 或 props.icon 至少一项；空调用不会修改页面。"
    );
  }

  // Needed to map props, resolve the title column, and check the reserved keys.
  const schema = await schemaForPage(runner, id);
  assertReservedKeysAvailable(schema, hasBody, icon);

  let properties: JsonObject = {};
  const propertyNames: string[] = [];

  if (props) {
    const built = buildProperties(schema, props);
    Object.assign(properties, built.properties);
    propertyNames.push(...built.names);
  }
  if (explicitTitle) {
    const titleName = titlePropertyName(schema);
    if (!titleName) {
      throw new InputError(
        `无法确定页面 ${id} 的标题属性，不能用 title 改标题；请改用 props 并指定标题属性名。`
      );
    }
    properties[titleName] = { title: richText(explicitTitle) };
    if (!propertyNames.includes(titleName)) propertyNames.push(titleName);
  }

  if (markdown) {
    // `pages edit --content` replaces the whole body. Measure what is there first so
    // the caller is told what it is about to lose, and so an accidental one-section
    // "fix" cannot pass silently.
    const beforeChars = await pageTextLength(runner, id);
    const afterChars = markdown.length;
    if (
      beforeChars !== undefined &&
      beforeChars >= SHRINK_GUARD_MIN_CHARS &&
      afterChars < beforeChars * SHRINK_CONFIRM_RATIO &&
      params.confirm_shrink !== true
    ) {
      const pct = Math.round((1 - afterChars / beforeChars) * 100);
      throw new InputError(
        `edit 的 body_content 会【整页替换】现有正文，不是追加、不是局部修改。` +
          `这次替换会让正文从约 ${beforeChars} 字变成 ${afterChars} 字（减少 ${pct}%）。` +
          `为避免误删，确认要整页覆盖请加 confirm_shrink: true；` +
          `只想改一小段的话，请重发完整正文内容（或改标题/属性/icon 时不要传 body_content）。`,
        {
          id,
          body_chars_before: beforeChars,
          body_chars_after: afterChars,
          shrink_ratio: Number((afterChars / beforeChars).toFixed(3)),
          confirm_required: "confirm_shrink",
        }
      );
    }

    const editResult = await runner({ args: ["pages", "edit", id, `--content=${markdown}`, "--json"] });
    if (!editResult.ok) throw ntnFailure("ntn pages edit", editResult);

    const edited = parseJsonMaybe(editResult.stdout);
    if (propertyNames.length > 0 || icon !== undefined) {
      const patchResult = await runner({ args: patchArgs(id, properties, icon) });
      if (!patchResult.ok) {
        throw ntnFailure(
          "PATCH 页面属性/icon",
          patchResult,
          `页面 ${id} 内容已更新，但${propertyNames.length > 0 ? "属性" : ""}${
            propertyNames.length > 0 && icon ? "和 icon" : icon ? "icon" : ""
          }未写入`
        );
      }
    }
    const url = pageUrlFromRaw(edited, id);
    return pageValue("edit", {
      id,
      ...(url ? { url } : {}),
      ...(icon ? { icon: icon.display } : {}),
      properties: propertyNames,
      ...(beforeChars !== undefined
        ? { body_chars_before: beforeChars, body_chars_after: afterChars }
        : {}),
      changed: [
        "body_content",
        ...(propertyNames.length > 0 ? ["properties"] : []),
        ...(icon ? ["icon"] : []),
      ],
    });
  }

  // Icon-only edit: one PATCH, no property map, no content rewrite.
  if (propertyNames.length === 0 && icon !== undefined) {
    const iconOnly = await runner({ args: patchArgs(id, {}, icon) });
    if (!iconOnly.ok) throw ntnFailure("PATCH 页面 icon", iconOnly);
    const patchedIcon = parseJsonMaybe(iconOnly.stdout);
    const url = pageUrlFromRaw(patchedIcon, id);
    return pageValue("edit", {
      id,
      ...(url ? { url } : {}),
      icon: icon.display,
      properties: [],
      changed: ["icon"],
    });
  }

  const patchResult = await runner({ args: patchArgs(id, properties, icon) });
  if (!patchResult.ok) throw ntnFailure("PATCH 页面属性/icon", patchResult);
  const patched = parseJsonMaybe(patchResult.stdout);
  const url = pageUrlFromRaw(patched, id);

  return pageValue("edit", {
    id,
    ...(url ? { url } : {}),
    ...(icon ? { icon: icon.display } : {}),
    properties: propertyNames,
    changed: [...(propertyNames.length > 0 ? ["properties"] : []), ...(icon ? ["icon"] : [])],
  });
}

async function attachPage(
  params: NotionPageParams,
  runner: NtnRunner
): Promise<PageToolValue> {
  const id = requireId(params.id, "attach");

  // Reject database/data-source parents before spending an ntn call on them.
  const spec = parseParentSpec(params.parent, "attach");
  if (!spec.bare && spec.kind !== "page") {
    throw new InputError(
      "attach 的 parent 只支持 page:<id> 或（裸）行 id：页面挂到页面下用 POST /v1/pages/{id}/move，行挂到行下用 Parent-item relation。" +
        "要把页面放进某个 data source，请用 notion_page create。"
    );
  }

  const readPage = makePageReader(runner);
  const container = await resolveContainer(runner, params.parent, "attach", readPage);
  const childPage = await readPage(id);
  const childParent = childPage.parent;
  if (!childParent) {
    throw new InputError(
      `无法确定页面 ${id} 的当前父级（GET v1/pages 未返回 parent）。attach 不会在没有确认的情况下移动页面。`,
      { id }
    );
  }

  if (container.kind === "page") {
    const targetParentId = container.createParent.id;
    if (sameNotionId(id, targetParentId)) {
      throw new InputError(`页面 ${id} 不能挂到自己下面。`, { id, parent: targetParentId });
    }
    if (childParent.kind === "page" && sameNotionId(childParent.id, targetParentId)) {
      throw new InputError(`页面 ${id} 已经是 ${targetParentId} 的子页面，无需 attach。`, {
        id,
      });
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
    const url = pageUrlFromRaw(moved, id);
    return pageValue("attach", {
      id,
      url,
      parent: formatParent(container.createParent),
      cycle_check: cycle.status,
      properties: [],
      changed: ["parent"],
    });
  }

  if (container.kind !== "row") {
    // Unreachable: attach rejects database/data-source parents above. Kept so the
    // row-only fields below are type-safe instead of a cast.
    throw new InputError("attach 无法把页面挂到 data source 容器下；请改用 create。");
  }

  // Parent is a row: only a row can be re-linked with a self-relation.
  if (childParent.kind === "page") {
    throw new InputError(
      `页面 ${id} 不在数据库里（父级是页面${childParent.id ? ` ${childParent.id}` : ""}），` +
        `不能用 Parent-item relation 挂到行 ${container.rowParentId} 下；attach 行只适用于同一库内的行。`,
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
        "自关联 Parent-item 只能在同一 data source 内使用，跨库请改用 page 父级或 create。",
      { id, childDataSourceId, parentDataSourceId: container.dataSourceId }
    );
  }

  const relation = findParentItemProperty(container.schema, container.dataSourceId);
  if (!relation) throw parentItemError(container.schema, container.dataSourceId);

  const currentParents = relationIdsIn(childPage, relation.name);
  const parentAlreadySet = currentParents.some((existing) =>
    sameNotionId(existing, container.rowParentId)
  );
  // Idempotent only when the requested link is the WHOLE relation. `[P, X]` + attach to P
  // still holds a second, different parent, so it needs yes:true and a real replace PATCH.
  if (parentAlreadySet && currentParents.length === 1) {
    return pageValue("attach", {
      id,
      url: pageUrl(id),
      parent: formatParent(container.createParent),
      parent_item_property: relation.name,
      parent_item_row_id: container.rowParentId,
      already_linked: true,
      properties: [],
      changed: [],
    });
  }
  if (currentParents.length > 0 && params.yes !== true) {
    throw new InputError(
      `行 ${id} 的 ${relation.name}（Parent-item）已经指向 ${currentParents.join(", ")}，` +
        `attach 到 ${container.rowParentId} 会覆盖这个链接。确认要改父级请传 yes: true；本次没有写入。`,
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
  // re-attach (which writes nothing) can never fail on an unreadable ancestor.
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
  const url = pageUrlFromRaw(patched, id);
  return pageValue("attach", {
    id,
    url,
    parent: formatParent(container.createParent),
    parent_item_property: relation.name,
    parent_item_row_id: container.rowParentId,
    ...(currentParents.length > 0 ? { replaced_parent_ids: currentParents } : {}),
    cycle_check: "walked",
    properties: [],
    changed: ["parent_item_relation"],
  });
}

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
async function classifyTrashTarget(
  runner: NtnRunner,
  id: string
): Promise<TrashTarget> {
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
      const archived =
        isPlainObject(raw) && (raw.archived === true || raw.in_trash === true);
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

/** Direct child pages of one page, from `GET v1/blocks/{id}/children`. */
async function listChildPages(
  runner: NtnRunner,
  pageId: string
): Promise<{ id: string; title: string }[]> {
  const children: { id: string; title: string }[] = [];
  let cursor: string | undefined;
  // Walk the whole child list, not a fixed page count: the default page returns
  // 100 BLOCKS (not 100 child pages), so a page with many paragraphs can hide
  // child pages on a later page. Stopping early would under-report the subtree
  // and let the guard approve a delete that removes children it never listed.
  // The bound is a runaway guard only (a page would need 10_000 blocks to hit it),
  // and reaching it refuses instead of guessing.
  const MAX_PAGES = 100;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : "";
    const result = await runner({ args: ["api", `v1/blocks/${pageId}/children${query}`] });
    if (!result.ok) {
      throw ntnFailure(`列出页面 ${pageId} 的子块`, result);
    }
    const parsed = parseJsonMaybe(result.stdout);
    if (!isPlainObject(parsed)) {
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
      if (
        block.has_children === true &&
        NESTING_BLOCK_TYPES.has(String(block.type))
      ) {
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
      // More blocks exist but no cursor was offered: the enumeration is incomplete.
      throw inputError(
        `页面 ${pageId} 的子块报告 has_more=true 却没有 next_cursor，无法读完子页面列表，因此拒绝删除。`,
        { id: pageId, enumerable: false }
      );
    }
    cursor = next;
    if (page === MAX_PAGES - 1) {
      // Refuse rather than approve a delete over a subtree we could not enumerate.
      throw inputError(
        `页面 ${pageId} 的子块超过 ${MAX_PAGES} 页仍未列完，无法确认它有多少子页面，因此拒绝删除。` +
          "请在 Notion 里手动确认并删除。",
        { id: pageId, children_enumerated: children.length, enumerable: false }
      );
    }
  }
  return children;
}

/**
 * How much text a page currently holds, in characters.
 *
 * Read from the page's own blocks rather than from `pages get` output, because the
 * returned Markdown carries a frontmatter header that would inflate the "before"
 * number. Returns undefined when the page cannot be read, so callers can degrade to
 * "size unknown" instead of claiming a transition they did not measure.
 */
async function pageTextLength(runner: NtnRunner, pageId: string): Promise<number | undefined> {
  let total = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : "";
    const result = await runner({ args: ["api", `v1/blocks/${pageId}/children${query}`] });
    if (!result.ok) return undefined;
    const parsed = parseJsonMaybe(result.stdout);
    if (!isPlainObject(parsed)) return undefined;
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    for (const block of results) {
      if (!isPlainObject(block)) continue;
      const payload = block[String(block.type)];
      if (!isPlainObject(payload)) continue;
      if (Array.isArray(payload.rich_text)) {
        for (const item of payload.rich_text) {
          if (isPlainObject(item) && typeof item.plain_text === "string") {
            total += item.plain_text.length;
          }
        }
      }
      if (typeof payload.expression === "string") total += payload.expression.length;
    }
    const hasMore = parsed.has_more === true;
    const next = typeof parsed.next_cursor === "string" ? parsed.next_cursor : undefined;
    if (!hasMore || !next) return total;
    cursor = next;
  }
  return undefined;
}

/**
 * A body replacement that removes a large share of the page.
 *
 * `ntn pages edit --content` replaces the ENTIRE body. A model that means "fix one
 * paragraph" and passes only that paragraph silently destroys the rest; the CLI
 * reports success, so nothing surfaces the loss. This guard makes the destructive
 * case require an explicit opt-in instead of being the quiet default.
 */
const SHRINK_CONFIRM_RATIO = 0.5;
/** Below this many characters there is nothing meaningful to protect. */
const SHRINK_GUARD_MIN_CHARS = 200;

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
  params: NotionPageParams,
  runner: NtnRunner
): Promise<PageToolValue> {
  const id = requireId(params.id, "trash");
  if (params.yes !== true) {
    throw new InputError(
      'trash 会删除（移入回收站）页面，必须显式传 yes: true（或 "true" / "yes" / 1）才会调用 ntn；本次没有调用 ntn。'
    );
  }

  const target = await classifyTrashTarget(runner, id);
  if (target.kind === "unreadable") {
    throw ntnFailure(
      `确认页面 ${id} 的类型（page / database / data source）`,
      { ok: false, stdout: "", stderr: target.reason, code: null }
    );
  }
  if (target.kind === "missing") {
    throw new InputError(
      `页面 ${id} 不存在，或没有被当前的 Notion integration 共享（••• → Connections），因此无法删除。` +
        "请先用 notion_search 确认 id 正确。",
      { id, target: "missing" }
    );
  }
  if (target.kind === "database") {
    // Use the global default: Notion refusal here is a policy choice of the plugin,
    // not a malformed argument, so `inputError`'s "fix your arguments" framing
    // would be misleading. Keep it visible to the model as an unusable request.
    throw new InputError(
      `notion_page cannot delete a database (id ${id}). Removing a database, its data ` +
        "sources and every row in them is far more destructive than deleting a page, so " +
        "this tool refuses even with yes: true. Ask the user to delete it in Notion " +
        "(••• → Delete) if that is really intended.",
      { id, target: "database", refused: "database_delete" }
    );
  }

  if (target.kind === "page" && target.archived) {
    // Nothing was written: the page was already in the trash. Saying "trashed" here
    // would claim an effect that did not happen and hide that from the caller.
    return pageValue("trash", {
      id,
      url: pageUrl(id),
      properties: [],
      changed: [],
      already_archived: true,
    });
  }

  if (target.kind === "page") {
    const children = await listChildPages(runner, id);
    if (children.length > 0 && params.recursive !== true) {
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

  return pageValue("trash", {
    id,
    url: pageUrl(id),
    properties: [],
    changed: ["trashed"],
  });
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/** The model-facing parameters, in the enforced DSH JSON Schema subset. */
const PAGE_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["create", "edit", "attach", "trash"],
      description: "create | edit | attach | trash",
    },
    id: {
      type: "string",
      description:
        "Page or row id (required for edit/attach/trash; create takes its container from parent).",
    },
    parent: {
      type: "string",
      description:
        "create/attach: page:<id> | database:<id> | data-source:<id>, or a bare page/row id (a row id means a child row under that row). Attach only accepts page:<id> or a row id.",
    },
    title: {
      type: "string",
      description:
        "Page title. create: sets the title (also used when props carry the title property). edit: updates the title property.",
    },
    content: {
      type: "string",
      description:
        "Page body Markdown. Alias for props.body_content; use one or the other, not both. edit with a body REPLACES the whole page (see the description).",
    },
    props: {
      type: "object",
      additionalProperties: true,
      description:
        'Object map of property name → simplified value ({} = omit). Two reserved keys are page fields, not columns: body_content is the page Markdown body, and icon is the page icon (an emoji like "🎯", an http(s) image URL, or null to clear it). Examples: {"body_content":"# 标题\\n\\n正文","Status":"进行中","标签":["a","b"],"截止日期":"2025-01-31","Done":true} and {"icon":"🎯"}.',
    },
    yes: {
      type: "boolean",
      description:
        "trash: must be true, otherwise the tool refuses without calling ntn. attach (row→row): consent to replacing an existing Parent-item link that points at a different parent.",
    },
    confirm_shrink: {
      type: "boolean",
      description:
        "edit on a page with substantial body: consent to replacing the whole body with text that is much shorter (under half). edit's body_content REPLACES the page, so this guard exists to stop a one-section fix from erasing everything else.",
    },
    recursive: {
      type: "boolean",
      description:
        "trash only: consent to delete a page together with its child pages (Notion archives the whole subtree). Without it a page that has child pages is refused with the child ids.",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

const PAGE_OUTPUT_SCHEMA = {
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
    body_chars_before: { type: "integer" },
    body_chars_after: { type: "integer" },
    parent_item_row_id: { type: "string" },
    parent_item_property: { type: "string" },
    already_linked: { type: "boolean" },
    already_archived: { type: "boolean" },
    replaced_parent_ids: { type: "array", items: { type: "string" } },
    cycle_check: { type: "string" },
  },
  required: ["ok", "action", "properties", "changed"],
  additionalProperties: false,
} as const;

/**
 * Build the `notion_page` tool definition.
 * `deps` exists for tests: injecting a fake runner replaces `runNtn`.
 */
export function createNotionPageTool(deps: NotionPageDeps = {}): NotionTool<PageToolValue> {
  const runner: NtnRunner = deps.runNtn ?? runNtn;

  return defineNotionTool<PageToolValue>({
    name: "notion_page",
    description:
      "Create, edit, attach (re-parent) or trash one Notion page. " +
      "put the page Markdown in props.body_content and the page icon in props.icon; there is no top-level " +
      "content or icon parameter. " +
      "action=create needs parent: page:<id> | database:<id> | data-source:<id>, or a bare database row id " +
      "(a child row, linked through the data source's Parent-item / self-relation column); props are applied " +
      "by a second request, and a page in a database also needs a title (the title parameter, the title " +
      "property in props, or a leading \"# Heading\" in props.body_content). If that second request fails the " +
      "new page is trashed so no half-made page is left behind, and the error says whether cleanup " +
      "succeeded: rollback reports trashed, trash_failed or unknown_id, and partial:true means something " +
      "was left behind. " +
      "action=edit needs id plus at least one of props (body_content / icon / columns) or title. " +
      "WARNING: props.body_content in an edit REPLACES the entire page body — it is not append and " +
      "not a partial edit, so anything not included in it is deleted. To change one section, resend " +
      "the complete body; to change only title/properties/icon, do not pass body_content at all. A " +
      "replacement that leaves under half the previous text is refused unless confirm_shrink:true. " +
      "action=attach needs id and parent and only re-parents: page→page moves the page, row→row sets the " +
      "Parent-item relation, and it is not a file upload; it refuses cycle-forming moves and refuses to " +
      "replace a different existing parent unless yes:true (the same parent is a no-op). " +
      "action=trash needs id and yes:true, otherwise nothing is called. " +
      "props is an object map keyed by property NAME (several keys = several properties, {} = no change), " +
      "and its values are converted by the column type: unknown names and read-only columns are rejected " +
      "with the writable columns in hint_properties. No default property values are invented.",
    timeoutMs: TOOL_TIMEOUTS.page,
    // Every action can write (create/edit/attach/trash mutate the workspace), so
    // page calls stay exclusive: never overlap two of them.
    isConcurrencySafe: () => false,
    parameters: PAGE_PARAMETERS as unknown as Record<string, unknown>,
    output: {
      schema: PAGE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      render: (_args, value) => textBlocks(describePageValue(value)),
    },

    async execute(args, exec) {
      const raw = args;
      // Synonyms name the same intent, so they are accepted; a different WORD or a
      // typo is not snapped to the nearest action, because doing so could perform a
      // write the caller never asked for.
      const action = readEnum(raw.action, "action", [
        { value: "create" as const, aliases: ["new", "add", "make", "insert"] },
        { value: "edit" as const, aliases: ["update", "modify", "change", "set", "patch"] },
        { value: "attach" as const, aliases: ["move", "reparent", "re-parent", "link"] },
        { value: "trash" as const, aliases: ["delete", "remove", "archive", "destroy", "trash"] },
      ]);
      if (exec.signal?.aborted) throw abortError();
      const typedAction = action as Action;
      rejectUnexpectedParams(raw, typedAction);
      const typed = normalizePageArgs(raw, typedAction);
      // Every ntn spawn of this call observes the call's cancellation signal.
      const run = bindSignal(runner, exec.signal);
      if (typedAction === "create") return await createPage(typed, run);
      if (typedAction === "edit") return await editPage(typed, run);
      if (typedAction === "attach") return await attachPage(typed, run);
      return await trashPage(typed, run);
    },
  });
}
