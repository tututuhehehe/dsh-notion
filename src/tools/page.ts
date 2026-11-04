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
 * Trash is the one destructive operation, and it is the only one that can be INTERRUPTED:
 * a page with child pages is not deleted on the call that names it — the call returns a
 * `pending` value listing every child that would go with it, and the model has to answer it
 * in a later step through the optional doublecheck service (see ../dsh/doublecheck.ts).
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
import { checkpoint, readDoublecheck } from "../dsh/doublecheck.ts";
import type { PendingValue, RiskSnapshot } from "../dsh/doublecheck.ts";
import { PAGE_RESULT_TEXT } from "../text/results.ts";
import { PAGE_ERRORS } from "../text/errors.ts";
import { TRASH_CHECKS, TRASH_PENDING_OUTPUT_TEXT, TRASH_PENDING_TEXT, TRASH_RISK_CODES } from "../text/checks.ts";
import {
  CREATE_PARAMS,
  EDIT_ITEM_TEXT,
  EDIT_PARAMS,
  ICON_PARAMETER_TEXT_CREATE,
  ICON_PARAMETER_TEXT_EDIT,
  ICON_TEXT,
  PROPS_DESCRIPTION,
  TRASH_PARAMS,
} from "../text/params.ts";
import { TOOL_DESCRIPTIONS } from "../text/tools.ts";
import { parseResolveDataSources } from "../lib/datasources.ts";
import { failureHint, failureStatus, snippet } from "../lib/failures.ts";
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
  /**
   * Reads the OPTIONAL doublecheck service (`ctx.get("doublecheck")`).
   *
   * Optional on purpose: dsh-notion works without the plugin, and a leaf delete never needs
   * a review. Only a delete that would take child pages with it is gated, and that gate
   * fails closed when this returns undefined.
   */
  getDoublecheck?: () => unknown;
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
    throw new InputError(PAGE_ERRORS.rejectUnexpectedParams_1({ usage: usage, join: unexpected.join(", ") }), {
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
  /**
   * No parent given. Notion puts such a page at the WORKSPACE ROOT
   * (`parent: {type:"workspace"}`), which is a first-class location, not an error —
   * `ntn pages create` documents `--parent` as optional and the API accepts the call.
   * It only has the title property, so `props` may carry nothing else.
   */
  | { kind: "workspace"; schema: PropertySchemaSet }
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

/**
 * Where a container lives, as one label for argv/messages/details.
 * `undefined` for the workspace root, which has no id to print.
 */
function containerParentLabel(container: Container): string | undefined {
  return container.kind === "workspace" ? undefined : formatParent(container.createParent);
}

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
      throw new InputError(PAGE_ERRORS.normalizeIcon_1,
        { field: "icon" }
      );
    }
    if (HTTP_URL_RE.test(value)) {
      return { payload: { type: "external", external: { url: value } }, display: value };
    }
    if ([...value].length > MAX_EMOJI_LENGTH) {
      throw new InputError(PAGE_ERRORS.normalizeIcon_2({ length: [...value].length, value: describeValue(value) }),
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
        throw new InputError(PAGE_ERRORS.normalizeIcon_3,
          { field: "icon" }
        );
      }
      return { payload: { type: "emoji", emoji }, display: emoji };
    }
    if (type === "external") {
      const url = isPlainObject(raw.external) ? raw.external.url : undefined;
      if (typeof url !== "string" || !HTTP_URL_RE.test(url.trim())) {
        throw new InputError(PAGE_ERRORS.normalizeIcon_4,
          { field: "icon" }
        );
      }
      return { payload: { type: "external", external: { url: url.trim() } }, display: url.trim() };
    }
    if (type === "custom_emoji" || type === "file") {
      // Escape hatch: a caller that already knows the exact Notion payload wins.
      return { payload: raw, display: `${String(type)} icon` };
    }
    throw new InputError(PAGE_ERRORS.normalizeIcon_5({ raw: describeValue(raw) }),
      { field: "icon", value: raw }
    );
  }

  throw new InputError(PAGE_ERRORS.normalizeIcon_6({ raw: describeValue(raw) }),
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
      throw new InputError(PAGE_ERRORS.normalizeBody_1, {
        field: "body_content",
      });
    }
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new InputError(PAGE_ERRORS.normalizeBody_2({ raw: describeValue(raw) }), {
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
    throw new InputError(PAGE_ERRORS.normalizeProps_1);
  }
  if (!isPlainObject(raw)) {
    throw new InputError(PAGE_ERRORS.normalizeProps_2({ raw: describeValue(raw) }));
  }
  const entries = Object.entries(raw).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeTitle(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new InputError(PAGE_ERRORS.normalizeTitle_1);
  // A newline is NOT rejected: Notion accepts one in a title and normalises it to a space
  // (verified live: "a\nb" is stored as "a b"). Refusing it would reject input the API takes.
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
    throw new InputError(PAGE_ERRORS.parseParentSpec_1({ create: op === "move" ? "移动页面（parent）" : "create", usage: usage }));
  }
  const value = raw.trim();
  const match = /^(page|database|data[_-]?source)\s*:\s*(.+)$/i.exec(value);
  if (!match) {
    // A caller holding a link hands over the link — same tolerance `id` already has
    // (`requireId`), so the two cannot disagree about whether a URL is acceptable.
    const bare = isNotionId(value) ? value : extractNotionId(value);
    if (!bare) {
      throw new InputError(PAGE_ERRORS.parseParentSpec_2({ raw: describeValue(raw), usage: usage }));
    }
    return { bare: true, id: bare };
  }
  const kindRaw = match[1].toLowerCase().replace("_", "-");
  const kind: ParentKind = kindRaw === "data-source" ? "data_source" : (kindRaw as ParentKind);
  const rawId = match[2].trim();
  const id = isNotionId(rawId) ? rawId : extractNotionId(rawId);
  if (!id) {
    throw new InputError(PAGE_ERRORS.parseParentSpec_3({ match: describeValue(match[2]) }));
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
    throw new InputError(PAGE_ERRORS.requireId_1({ op: op }));
  }
  const text = raw.trim();
  if (isNotionId(text)) return text;
  const extracted = extractNotionId(text);
  if (extracted) return extracted;
  throw new InputError(PAGE_ERRORS.requireId_2({ raw: describeValue(raw) }));
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
  // The hint is attached ONLY when the text identifies the cause (see lib/failures.ts);
  // an unrecognised failure stays as ntn worded it rather than getting a confident guess.
  // `no exit code` means the child never exited — our own timeout, or it could not start.
  const hint = failureHint(result);
  const status =
    result.code === null && !detail
      ? `（${failureStatus(result)}）`
      : exit;
  return new NotionToolError(PAGE_ERRORS.ntnFailure_1({ note: note ? `${note}；` : "", label, status, detail: detail ? `：${truncate(detail)}` : "", hint }),
    {
      code: NOTION_ERROR_CODES.ntnFailed,
      details: {
        stderr: snippet(result.stderr),
        stdout: truncate(result.stdout.trim()),
        code: result.code,
        ...(hint ? { hint } : {}),
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
    throw new InputError(PAGE_ERRORS.fetchDataSourceSchema_1({ path: path }),
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
    throw new InputError(PAGE_ERRORS.resolveDatabaseDataSource_1({ databaseId: databaseId }),
      { databaseId }
    );
  }
  if (refs.length > 1) {
    const lines = refs.map((ref) => `- ${ref.id}${ref.name ? ` (${ref.name})` : ""}`);
    throw new InputError(PAGE_ERRORS.resolveDatabaseDataSource_2({ databaseId: databaseId, length: refs.length, n: lines.join("\n") }),
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
      throw new InputError(PAGE_ERRORS.assertNoRowCycle_1({ MAX_ANCESTOR_WALK: MAX_ANCESTOR_WALK }),
        { id: childId, parent: parentId, cycle_check: "too_deep" }
      );
    }
    const current = queue.shift() as string;
    const key = canonicalNotionId(current);
    if (visited.has(key)) continue;
    visited.add(key);

    if (sameNotionId(current, childId)) {
      throw new InputError(PAGE_ERRORS.assertNoRowCycle_2({ childId: childId, parentId: parentId, parentId2: parentId, childId2: childId }),
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
      throw new InputError(PAGE_ERRORS.assertNoRowCycle_3({ current: current, childId: childId, parentId: parentId }),
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
          throw new InputError(PAGE_ERRORS.assertNoRowCycle_4({ current: current, childId: childId, parentId: parentId }),
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
    throw new InputError(PAGE_ERRORS.classifyBareParent_1({ id: id, detail: detail ? `（${truncate(detail, 300)}）` : "", create: op === "create" ? "create" : "移动页面" }),
      { parent: id }
    );
  }
  const parent = page.parent;
  if (!parent) {
    throw new InputError(PAGE_ERRORS.classifyBareParent_2({ id: id, create: op === "create" ? "create" : "移动页面" }),
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
    throw new InputError(PAGE_ERRORS.requireString_1({ name: prop.name, type: prop.type, value: describeValue(value) }),
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
  throw new InputError(PAGE_ERRORS.stringList_1({ name: prop.name, type: prop.type, value: describeValue(value) }),
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
        throw new InputError(PAGE_ERRORS.buildPropertyValue_1({ name: prop.name }), { property: prop.name });
      default:
        throw new InputError(PAGE_ERRORS.buildPropertyValue_2({ name: prop.name, type: prop.type }), {
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
      if (!text.trim()) throw new InputError(PAGE_ERRORS.buildPropertyValue_3({ name: prop.name }), { property: prop.name });
      return { title: richText(text) };
    }
    case "rich_text": {
      let text: string;
      if (typeof value === "string") {
        text = value;
      } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        text = (value as string[]).join("\n");
      } else {
        throw new InputError(PAGE_ERRORS.buildPropertyValue_4({ name: prop.name, value: describeValue(value) }),
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
      throw new InputError(PAGE_ERRORS.buildPropertyValue_5({ name: prop.name, value: describeValue(value) }),
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
        throw new InputError(PAGE_ERRORS.buildPropertyValue_6({ name: prop.name, type: prop.type, value: describeValue(value) }),
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
      throw new InputError(PAGE_ERRORS.buildPropertyValue_7({ name: prop.name, value: describeValue(value) }),
        { property: prop.name, expected: "string | {start,end}" }
      );
    }
    case "checkbox": {
      if (typeof value !== "boolean") {
        throw new InputError(PAGE_ERRORS.buildPropertyValue_8({ name: prop.name, value: describeValue(value) }),
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
      throw new InputError(PAGE_ERRORS.buildPropertyValue_9({ name: prop.name, type: prop.type, name2: prop.name, type2: prop.type }),
        { property: prop.name, type: prop.type }
      );
  }
}

function resolveProperty(schema: PropertySchemaSet, name: string): PropertySchema {
  const prop = schema.properties.get(name);
  const hints = writableProperties(schema);
  if (!prop) {
    throw new InputError(PAGE_ERRORS.resolveProperty_1({ name: name, hints: formatHints(hints) }),
      { property: name, hint_properties: hints }
    );
  }
  if (READ_ONLY_PROPERTY_TYPES.has(prop.type)) {
    throw new InputError(PAGE_ERRORS.resolveProperty_2({ name: name, type: prop.type, hints: formatHints(hints) }),
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
  else if (h1 && existingFrontmatterTitle === undefined) {
    // The requested title DIFFERS from a leading H1. `ntn pages create` silently
    // swallows an H1 that follows frontmatter (verified: the heading disappears and
    // only the rest of the body lands), while a direct API call keeps it. Sending the
    // H1 as a heading would lose content with a success status, so it is demoted to
    // plain text: the user's words survive, which is what they can then fix.
    body = `\\# ${h1.title}\n\n${h1.rest}`;
  }
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
  /**
   * create: how many characters of body this call actually wrote.
   *
   * A create always sends the body, but "已写入列：title" told a caller nothing about it —
   * it could not tell whether the Markdown landed or only the columns did. Reporting the
   * count answers that without echoing the whole body back into the context.
   */
  body_chars?: number;
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
        ? PAGE_RESULT_TEXT.alreadyLinked({
            hasParentItem: true,
            id: value.id as string,
            parentItemRowId: value.parent_item_row_id as string,
            parentItemProperty: value.parent_item_property as string,
            parent: value.parent as string,
          })
        : PAGE_RESULT_TEXT.alreadyLinked({
            hasParentItem: false,
            id: value.id as string,
            parentItemRowId: "",
            parentItemProperty: "",
            parent: value.parent as string,
          })
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
    lines.push(PAGE_RESULT_TEXT.cycleCheckPartial);
  }
  // Report each kind of write separately. A create used to print only "已写入列：title",
  // which left the caller unable to tell whether the Markdown body had landed too.
  if (value.created) {
    if (value.title) lines.push(`标题：${value.title}`);
    lines.push(
      value.body_chars
        ? PAGE_RESULT_TEXT.bodyWritten({ chars: value.body_chars })
        : PAGE_RESULT_TEXT.bodyNotProvided
    );
  }
  if (value.properties.length) lines.push(`已写入列：${value.properties.join(", ")}`);
  if (value.icon !== undefined) lines.push(`icon: ${value.icon ?? "（已清除）"}`);

  if (value.edits_sent !== undefined) {
    lines.push(
      PAGE_RESULT_TEXT.editTally({
        applied: value.edits_applied ?? 0,
        sent: value.edits_sent,
        missed: value.edits_missed ?? 0,
      })
    );
  } else if (value.appended) {
    lines.push(PAGE_RESULT_TEXT.appended);
  }

  if (value.warnings) {
    for (const warning of value.warnings) lines.push(`warning [${warning.code}]: ${warning.message}`);
  }
  if (value.truncated) {
    lines.push(
      PAGE_RESULT_TEXT.truncated
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
    throw new InputError(PAGE_ERRORS.readContentEdit_1({ path: path, raw: describeValue(raw) }),
      { field: path, value: raw }
    );
  }
  const unexpected = Object.keys(raw).filter(
    (key) => raw[key] !== undefined && !["old_str", "new_str", "replace_all_matches"].includes(key)
  );
  if (unexpected.length > 0) {
    throw new InputError(PAGE_ERRORS.readContentEdit_2({ path: path, join: unexpected.join(", ") }),
      { field: path, unexpected_params: unexpected }
    );
  }
  if (typeof raw.old_str !== "string") {
    throw new InputError(PAGE_ERRORS.readContentEdit_3({ path: path, old_str: describeValue(raw.old_str) }),
      { field: `${path}.old_str`, value: raw.old_str }
    );
  }
  if (raw.old_str === "") {
    throw new InputError(PAGE_ERRORS.readContentEdit_4({ path: path }),
      { field: `${path}.old_str` }
    );
  }
  if (raw.new_str === undefined) {
    throw new InputError(PAGE_ERRORS.readContentEdit_5({ path: path }),
      { field: `${path}.new_str`, value: raw.new_str }
    );
  }
  if (typeof raw.new_str !== "string") {
    throw new InputError(PAGE_ERRORS.readContentEdit_6({ path: path, new_str: describeValue(raw.new_str) }),
      { field: `${path}.new_str`, value: raw.new_str }
    );
  }
  return {
    old_str: raw.old_str,
    new_str: unescapeDollar(raw.new_str),
    ...(raw.replace_all_matches === undefined
      ? {}
      : { replace_all_matches: readBoolean(raw.replace_all_matches, `${path}.replace_all_matches`) }),
  };
}

/**
 * Undo Notion's markdown escaping of `$` in `new_str`.
 *
 * `notion_get` renders a stored `$` as `\$`, so a caller that copies what it read sends
 * `\$` — and Notion stores that escape LITERALLY, visibly corrupting the text (verified
 * live: a page ended up containing a backslash that was never typed). `old_str` accepts
 * either form, so only `new_str` needs normalising. Doing it here means the asymmetry
 * never has to be remembered by the caller.
 *
 * A caller who genuinely wants a literal backslash-dollar cannot express it through this
 * tool. That is the deliberate trade: the escape is overwhelmingly a copy-paste artefact,
 * and silently corrupting a page is much worse than being unable to produce that byte.
 */
function unescapeDollar(text: string): string {
  return text.replace(/\\\$/g, "$");
}

function readContentEdits(raw: unknown): ContentEdit[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new InputError(PAGE_ERRORS.readContentEdits_1({ raw: describeValue(raw) }),
      { field: "edits", value: raw }
    );
  }
  if (raw.length > MAX_CONTENT_UPDATES) {
    throw new InputError(PAGE_ERRORS.readContentEdits_2({ MAX_CONTENT_UPDATES: MAX_CONTENT_UPDATES, length: raw.length }),
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
    throw new InputError(PAGE_ERRORS.withEditAlias_1,
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
    return new NotionToolError(PAGE_ERRORS.markdownFailure_1({ pageId: pageId, detail: truncate(detail, 600) }),
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
      throw new InputError(PAGE_ERRORS.buildPropertyWrite_1({ pageId: context.pageId, source: context.source }));
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
  return new InputError(PAGE_ERRORS.parentItemError_1({ dataSourceId: dataSourceId, detail: detail }),
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
    ? PAGE_ERRORS.rollbackCreatedPage_3({ pageId: pageId, detail: detail ? truncate(detail, 300) : "" })
    : PAGE_ERRORS.rollbackCreatedPage_2({ pageId: pageId });

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
  return new NotionToolError(PAGE_ERRORS.rollbackCreatedPage_1({ detail: cause.detail, rollbackLine: rollbackLine }), {
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
  // No parent is a valid request, not a missing argument: `ntn pages create` documents
  // `--parent` as optional and Notion creates the page at the workspace root. Refusing it
  // would be a restriction the API does not have.
  const container: Container =
    params.parent === undefined
      ? { kind: "workspace", schema: PAGE_SCHEMA }
      : await resolveContainer(runner, params.parent, "create", readPage);
  const parentLabel = containerParentLabel(container);

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

  // A database row needs a title (it is the row's identity in the table). A page — child
  // or workspace-level — does not: Notion happily creates an untitled page whose body
  // carries the content, and `create` already rejects a call with neither title nor body.
  if (container.kind !== "page" && container.kind !== "workspace" && !title) {
    const hints = writableProperties(container.schema);
    throw new InputError(PAGE_ERRORS.createPage_1({ kind: container.kind === "row" ? `行 ${container.rowParentId} 所在 data source` : container.kind, title: titlePropertyName(container.schema) ?? "title", hints: formatHints(hints) }),
      { ...(parentLabel ? { parent: parentLabel } : { parent: "workspace" }), hint_properties: hints }
    );
  }

  // `ntn pages create` rejects empty Markdown ("Markdown content cannot be empty.")
  // with exit 5. A title-only create is fine because frontmatter makes the body
  // non-empty, but a bare `parent` with no title cannot create a page.
  if (!draft.body.trim()) {
    throw new InputError(PAGE_ERRORS.createPage_2);
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
      ...(parentLabel === undefined ? [] : ["--parent", parentLabel]),
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
    throw new InputError(PAGE_ERRORS.createPage_3({ workspace: parentLabel ?? "workspace", what: what }),
      {
        parent: parentLabel ?? "workspace",
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
    parent: parentLabel ?? "workspace",
    ...(title ? { title } : {}),
    // The body is what `pages create --content` sent; its size is the only evidence the
    // caller gets that the Markdown landed, without echoing the whole thing back.
    body_chars: draft.body.length,
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

/** One `notion_page_edit` step that did not land; `error` is whatever it threw. */
type AppliedFailure = { step: string; error: unknown };

/** Normalize a caught value into the NotionToolError the model should read. */
function asToolError(error: unknown, label: string): NotionToolError {
  if (error instanceof NotionToolError) return error;
  return ntnFailure(label, {
    ok: false,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    code: null,
  });
}

/**
 * Report an edit where some steps landed and some did not.
 *
 * This is deliberately an ERROR rather than a success carrying warnings: at least one
 * thing the caller explicitly asked for did not happen, and DSH renders a thrown error
 * in a way a model reliably acts on. What must NOT happen is the model concluding that
 * NOTHING happened — that is what makes it retry and double-apply the steps that did
 * succeed. So the message leads with what landed, names each failure, and says the
 * successful parts will not be rolled back.
 *
 * `applied` is empty only when every requested step failed, in which case there is no
 * debt and the first failure is surfaced as a plain error (no misleading "already
 * written" text).
 */
function editWithFailures(
  failed: AppliedFailure[],
  applied: string[],
  result: EditResult
): NotionToolError {
  const causes = failed.map((failure) => ({
    step: failure.step,
    cause: asToolError(failure.error, failure.step),
  }));
  const failedSteps = causes.map((entry) => entry.step);
  if (applied.length === 0) {
    // Nothing landed: keep the original error's meaning and details untouched.
    const primary = causes[0]!;
    return primary.cause;
  }
  const reported = causes
    .map((entry) => `  - ${entry.step}：${entry.cause.detail}`)
    .join("\n");
  return new NotionToolError(PAGE_ERRORS.editWithFailures_1({ join: applied.join("、"), reported: reported }),
    {
      code: causes[0]!.cause.code,
      details: {
        partial: true,
        applied,
        failed_steps: failedSteps,
        failures: causes.map((entry) => ({
          step: entry.step,
          code: entry.cause.code,
          message: entry.cause.detail,
          ...entry.cause.details,
        })),
        changed: result.changes,
      },
    }
  );
}

async function editPage(params: EditParams, runner: NtnRunner): Promise<PageToolValue> {
  const { id, edits } = params;
  const result: EditResult = { changes: [], properties: [], outcome: {} };

  // ORDER and INDEPENDENCE, both deliberate:
  //
  // Order is (1) content, (2) properties/title/icon, (3) the move, because a caller that
  // "fixes the text and then files the page elsewhere" reads its own intent that way.
  //
  // INDEPENDENCE is the more important half: the three steps do not depend on each
  // other, so a failure in one must NOT cancel the others. An old_str that matches
  // nothing is a bad argument, not a broken page — refusing to apply a valid title or
  // a valid move because of it would leave the caller with neither, and the natural
  // retry (with a corrected old_str) would then re-apply the very steps that had
  // already succeeded. So every step runs, failures are COLLECTED, and the call reports
  // exactly what landed and what did not.
  const applied: string[] = [];
  const failed: AppliedFailure[] = [];
  if (edits.length > 0) {
    try {
      const appliedEdits = await applyContentEdits(runner, id, edits);
      result.outcome = appliedEdits;
      result.changes.push("body_content");
      applied.push(
        `内容（${appliedEdits.edits_applied}/${appliedEdits.edits_sent} 条 edits）`
      );
    } catch (error) {
      failed.push({ step: "正文（edits）", error });
    }
  } else if (params.body !== undefined && params.body.trim() !== "") {
    try {
      result.outcome = await appendPageContent(runner, id, params.body);
      result.appended = true;
      result.changes.push("body_content");
      applied.push("追加的正文内容");
    } catch (error) {
      failed.push({ step: "追加正文（body_content）", error });
    }
  }

  const needsPatch =
    params.props !== undefined || params.title !== undefined || params.icon !== undefined;
  if (needsPatch) {
    // Everything in this block can fail AFTER the content edit already landed —
    // including the LOCAL validators (`schemaForPage`, `buildPropertyWrite`), not just
    // the network PATCH. Wrapping the whole block is what makes the disclosure
    // reliable: a caller that sent a valid edit plus a bad property would otherwise be
    // told only "bad argument", retry with a fixed argument, and double-apply (or get a
    // confusing "No matches found" from an old_str that had in fact already succeeded).
    // Step 3 below needs no such wrapper because `movePage` is already the try body.
    let patchResult;
    try {
      const schema = await schemaForPage(runner, id);
      const { properties, names, changes } = buildPropertyWrite(schema, params.props, params.title, {
        pageId: id,
        source: schema.source,
      });
      patchResult = await runner({ args: patchArgs(id, properties, params.icon) });
      if (!patchResult.ok) throw ntnFailure("PATCH 页面属性/icon", patchResult);
      const patched = parseJsonMaybe(patchResult.stdout);
      if (pageHasUrl(patched)) result.url = pageUrlFromRaw(patched, id);
      result.properties = names;
      result.changes.push(...changes);
      if (params.icon !== undefined) result.changes.push("icon");
      if (names.length > 0) applied.push(`属性（${names.join(", ")}）`);
      if (params.icon !== undefined) applied.push("icon");
    } catch (error) {
      failed.push({ step: "属性/标题/icon（PATCH 页面属性/icon）", error });
    }
  }

  if (params.parent !== undefined) {
    try {
      const move = await movePage(runner, { id, parent: params.parent, yes: params.yes });
      result.move = move;
      if (move.change) result.changes.push(move.change);
    } catch (error) {
      failed.push({ step: "移动页面（parent）", error });
    }
  }

  // Every step has run. If any of them failed, the call still reports what DID land —
  // see `AppliedFailure` for why a partial edit is success-with-debt, not a plain error.
  if (failed.length > 0) throw editWithFailures(failed, applied, result);

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
    throw new InputError(PAGE_ERRORS.movePage_1);
  }

  const readPage = makePageReader(runner);
  const container = await resolveContainer(runner, options.parent, "move", readPage);
  const childPage = await readPage(id);
  const childParent = childPage.parent;
  if (!childParent) {
    throw new InputError(PAGE_ERRORS.movePage_2({ id: id }),
      { id }
    );
  }

  if (container.kind === "page") {
    const targetParentId = container.createParent.id;
    if (sameNotionId(id, targetParentId)) {
      throw new InputError(PAGE_ERRORS.movePage_3({ id: id }), { id, parent: targetParentId });
    }
    if (childParent.kind === "page" && sameNotionId(childParent.id, targetParentId)) {
      throw new InputError(PAGE_ERRORS.movePage_4({ id: id, targetParentId: targetParentId }), { id });
    }

    // Deeper page-tree cycles (A→B→A) are checked best effort: one GET per ancestor.
    const cycle = await walkPageAncestors(readPage, { childId: id, parentId: targetParentId });
    if (cycle.cycle) {
      throw new InputError(PAGE_ERRORS.movePage_5({ id: id, targetParentId: targetParentId, join: cycle.cycle.join(" → ") }),
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
    throw new InputError(PAGE_ERRORS.movePage_6);
  }

  // Parent is a row: only a row can be re-linked with a self-relation.
  if (childParent.kind === "page") {
    throw new InputError(PAGE_ERRORS.movePage_7({ id: id, id2: childParent.id ? ` ${childParent.id}` : "", rowParentId: container.rowParentId }),
      { id, parentRowId: container.rowParentId }
    );
  }
  if (sameNotionId(id, container.rowParentId)) {
    throw new InputError(PAGE_ERRORS.movePage_8({ id: id }), { id });
  }

  const childDataSourceId = await dataSourceIdForParent(runner, childParent);
  if (!sameNotionId(childDataSourceId, container.dataSourceId)) {
    throw new InputError(PAGE_ERRORS.movePage_9({ id: id, childDataSourceId: childDataSourceId, rowParentId: container.rowParentId, dataSourceId: container.dataSourceId }),
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
    throw new InputError(PAGE_ERRORS.movePage_10({ id: id, name: relation.name, join: currentParents.join(", "), rowParentId: container.rowParentId }),
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
  | {
      kind: "page";
      archived: boolean;
      /** Title read from the same probe response; absent when it is empty or unreadable. */
      title?: string;
      /** Parent identity, only what a reviewer needs to tell two pages apart. */
      parent?: { type: string; id: string };
    }
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
      // The title and parent come from the response that was already fetched to classify
      // the target: a reviewer that has to tell two pages apart needs both, and paying a
      // second read for them would double the cost of every trash.
      const title = isPlainObject(raw) ? pageTitleOf(raw) : undefined;
      const parent = isPlainObject(raw) ? pageParentOf(raw) : undefined;
      return {
        kind: "page",
        archived,
        ...(title === undefined ? {} : { title }),
        ...(parent === undefined ? {} : { parent }),
      };
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
 * How many child pages to name in the review reason.
 *
 * The list exists so a reviewer can see what it is about to delete, so it has to be long
 * enough to be useful and short enough to stay readable; the remainder is summarized with
 * its count rather than silently dropped.
 */
const MAX_LISTED_CHILDREN = 20;

/**
 * How many children to keep in the risk `details`.
 *
 * `details` is machine evidence, not prose: it is what a later audit (or a retry that
 * recomputes the risk) compares. It is capped because doublecheck caps a whole risk
 * snapshot at 32 KiB, and a page can have hundreds of children.
 */
const MAX_RISK_CHILDREN = 50;

/**
 * How long a title may be inside the review reason.
 *
 * doublecheck rejects a risk whose `reason` exceeds 2048 characters, and a fail-closed
 * "review unavailable" for a page with long titles would make the page undeletable. The
 * cap keeps 20 listed children plus the page title well inside that budget; the full
 * title stays in the page itself and in `details`.
 */
const MAX_LISTED_TITLE = 40;
const MAX_LISTED_CHILD_TITLE = 24;

/** One child that would go down with the page. */
type TrashChild = {
  id: string;
  /** What to show: a title for a page/database, the block type for a nesting container. */
  label: string;
  kind: "page" | "database" | "container";
};

/**
 * Direct child pages of one page, from `GET v1/blocks/{id}/children`.
 *
 * The walk follows EVERY page of the child list, not a fixed count: the default page
 * returns 100 BLOCKS (not 100 child pages), so a page with many paragraphs can hide child
 * pages on a later page. Stopping early would under-report the subtree and let the caller
 * approve a delete that removes children it never saw. The bound is a runaway guard only,
 * and reaching it refuses instead of guessing.
 *
 * A partial list is never returned: since this list is the ONLY thing that states the scope
 * of a subtree delete, "I could not finish enumerating" has to mean "refuse", not "delete
 * what I happened to see".
 */
async function listChildPages(runner: NtnRunner, pageId: string): Promise<TrashChild[]> {
  const children: TrashChild[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_BLOCK_PAGES; page += 1) {
    const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : "";
    const result = await runner({ args: ["api", `v1/blocks/${pageId}/children${query}`] });
    if (!result.ok) throw ntnFailure(`列出页面 ${pageId} 的子块`, result);
    const parsed = parseJsonMaybe(result.stdout);
    if (!isPlainObject(parsed)) {
      // The child list is the ONLY evidence this guard has. An unparseable response
      // is "I could not enumerate", not "there are no children": treating it as empty
      // would approve a subtree delete blind, so refuse instead.
      throw inputError(PAGE_ERRORS.listChildPages_1({ pageId: pageId, trim: truncate((result.stdout || "").trim(), 200) }),
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
        children.push({ id: block.id, label: title, kind: "page" });
        continue;
      }
      // An inline database is its own object with rows; it is archived with the page.
      if (block.type === "child_database") {
        const title =
          isPlainObject(block.child_database) && typeof block.child_database.title === "string"
            ? block.child_database.title
            : "(untitled database)";
        children.push({ id: block.id, label: title, kind: "database" });
        continue;
      }
      // Only container types that can actually hold a page or database are walked.
      // `has_children` alone is far too broad: every table and table_row reports it,
      // which would make ordinary pages permanently undeletable. Toggles, columns,
      // synced blocks and links can nest a page, so they are reported.
      if (block.has_children === true && NESTING_BLOCK_TYPES.has(String(block.type))) {
        children.push({ id: block.id, label: String(block.type), kind: "container" });
      }
    }
    const hasMore = parsed.has_more === true;
    const next = typeof parsed.next_cursor === "string" ? parsed.next_cursor : undefined;
    if (!hasMore) return children;
    if (!next) {
      // More blocks exist but no cursor was offered: the enumeration is incomplete.
      throw inputError(PAGE_ERRORS.listChildPages_2({ pageId: pageId }),
        { id: pageId, enumerable: false }
      );
    }
    cursor = next;
    if (page === MAX_BLOCK_PAGES - 1) {
      // Refuse rather than approve a delete over a subtree we could not enumerate.
      throw inputError(PAGE_ERRORS.listChildPages_3({ pageId: pageId, MAX_BLOCK_PAGES: MAX_BLOCK_PAGES }),
        { id: pageId, children_enumerated: children.length, enumerable: false }
      );
    }
  }
  return children;
}

/**
 * Trash one page: the only operation in this file that cannot be undone by calling the tool
 * again with different arguments.
 *
 *   1. A database or data source is refused outright: deleting one is far more destructive
 *      than deleting a page, so it stays a human decision in Notion — a review cannot
 *      authorize it.
 *   2. An already-archived page reports success instead of failing: Notion answers
 *      400 "Can't edit block that is archived", which reads like a fault and makes a retry
 *      look broken. Trash is naturally idempotent.
 *   3. A page with child pages is NOT deleted here. The child list is read first, and the
 *      call returns a `pending` value that states the exact scope; deleting needs a second
 *      step (doublecheck) so the scope is seen before it is destroyed. A leaf page is
 *      deleted by this one call — nothing else goes with it, so there is nothing to review.
 */
async function trashPage(
  params: { id: string },
  runner: NtnRunner,
  deps: TrashDeps
): Promise<PageToolValue | PendingValue> {
  const { id } = params;
  const signal = (deps.exec as { signal?: AbortSignal } | undefined)?.signal;
  if (signal?.aborted) throw abortError();

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
    throw new InputError(PAGE_ERRORS.trashPage_1({ id: id }),
      { id, target: "missing" }
    );
  }
  if (target.kind === "database") {
    // Notion refusal here is a policy choice of the plugin, not a malformed argument,
    // so `inputError`'s "fix your arguments" framing would be misleading. Keep it
    // visible to the model as an unusable request.
    throw new InputError(PAGE_ERRORS.trashPage_2({ id: id }),
      { id, target: "database", refused: "database_delete" }
    );
  }

  if (target.archived) {
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

  // The child list is the ONLY thing that can state the scope of this delete, so it is
  // always read in full. "Could not enumerate" must never be treated as "no children".
  const children = await listChildPages(runner, id);
  const risk = children.length === 0 ? null : trashSubtreeRisk(id, target, children);

  // Every execution passes the checkpoint, INCLUDING a null risk: a confirmed call is
  // replayed with its original arguments, and only a fresh checkpoint lets doublecheck
  // notice that the scope changed in the meantime (it then refuses the stale confirmation
  // and asks for a new review instead of deleting a subtree nobody approved).
  const pending = checkpoint({
    service: readDoublecheck(deps.getDoublecheck ?? (() => undefined)),
    exec: deps.exec,
    risk,
    // Only reached when child pages exist and there is no review channel: say what was
    // found, because "nothing happened" alone would hide how much was at stake.
    unavailable: () =>
      new NotionToolError(PAGE_ERRORS.trashPage_3({ id: id, count: children.length }), {
        code: NOTION_ERROR_CODES.reviewUnavailable,
        details: {
          id,
          children: children.map((child) => child.id),
          children_count: children.length,
        },
      }),
  });
  if (pending) return pending;

  // The review is not a transaction: this spawn still takes a moment, and a child page
  // created in that window would be deleted without having been listed. Known residual,
  // measured at ~1s; the alternative (a versioned pre-condition) is not offered by Notion.
  if (signal?.aborted) throw abortError();
  const result = await runner({ args: ["pages", "trash", id, "--yes"] });
  if (!result.ok) throw ntnFailure("ntn pages trash", result);

  return pageValue({ id, url: pageUrl(id), properties: [], changed: ["trashed"] });
}

/** Dependencies of {@link trashPage}: the review channel plus the execution it belongs to. */
type TrashDeps = {
  /** The real DSH execution of this call; doublecheck validates the call identity against it. */
  exec: unknown;
  /** Reads the optional doublecheck service; absent = no review channel. */
  getDoublecheck?: () => unknown;
};

/**
 * The one risk a trash can carry: the page has children, so Notion takes the whole subtree.
 *
 * Everything in here is deterministic on purpose: the same page must produce a byte-identical
 * snapshot on the retry that follows a confirmation, or doublecheck treats the risk as
 * changed. That is why the children are sorted by id and nothing time-dependent is included.
 */
function trashSubtreeRisk(
  id: string,
  target: Extract<TrashTarget, { kind: "page" }>,
  children: TrashChild[]
): RiskSnapshot {
  const ordered = [...children].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const reason = TRASH_CHECKS.subtree({
    target: "页面",
    title: truncate(target.title ?? id, MAX_LISTED_TITLE),
    id,
    count: ordered.length,
    listed: ordered
      .slice(0, MAX_LISTED_CHILDREN)
      .map((child) =>
        TRASH_CHECKS.childLine({
          kind: child.kind,
          label: truncate(child.label, MAX_LISTED_CHILD_TITLE),
          id: child.id,
        })
      )
      .join("\n"),
    overflow:
      ordered.length > MAX_LISTED_CHILDREN
        ? TRASH_CHECKS.overflow({ rest: ordered.length - MAX_LISTED_CHILDREN, total: ordered.length })
        : "",
  });
  return {
    code: TRASH_RISK_CODES.subtree,
    reason,
    details: {
      scope: "subtree",
      tool: "notion_page_trash",
      page_id: id,
      ...(target.title === undefined ? {} : { page_title: target.title }),
      ...(target.parent === undefined ? {} : { parent: target.parent }),
      child_count: ordered.length,
      children: ordered.slice(0, MAX_RISK_CHILDREN).map((child) => ({
        kind: child.kind,
        id: child.id,
        title: child.label,
      })),
      children_truncated: ordered.length > MAX_RISK_CHILDREN,
    },
  };
}

/** Page title from `GET v1/pages/{id}`: the one property whose type is `title`. */
function pageTitleOf(raw: JsonObject): string | undefined {
  const properties = isPlainObject(raw.properties) ? raw.properties : undefined;
  if (!properties) return undefined;
  for (const value of Object.values(properties)) {
    if (!isPlainObject(value) || value.type !== "title" || !Array.isArray(value.title)) continue;
    const text = value.title
      .map((part) => (isPlainObject(part) && typeof part.plain_text === "string" ? part.plain_text : ""))
      .join("")
      .trim();
    return text === "" ? undefined : text;
  }
  return undefined;
}

/** Parent identity from `GET v1/pages/{id}`; a workspace-level page has no parent id. */
function pageParentOf(raw: JsonObject): { type: string; id: string } | undefined {
  const parent = isPlainObject(raw.parent) ? raw.parent : undefined;
  if (!parent || typeof parent.type !== "string") return undefined;
  const id = parent.type === "page_id" ? parent.page_id : parent.type === "database_id" ? parent.database_id : undefined;
  return typeof id === "string" ? { type: parent.type, id } : undefined;
}

/** The model-facing body of a trash `pending`: not executed, what is at stake, how to answer. */
function describeTrashPending(pending: PendingValue): string {
  return [
    TRASH_PENDING_TEXT.head,
    pending.reason,
    "",
    TRASH_PENDING_TEXT.confirm({ id: pending.id }),
    TRASH_PENDING_TEXT.cancel({ id: pending.id }),
    TRASH_PENDING_TEXT.onlyParent({ id: pending.id }),
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * Parameter schemas (enforced DSH JSON Schema subset only)
 *
 * Allowed keywords: type / oneOf / properties / required / additionalProperties /
 * items / enum / const + description/title. NOT minLength, pattern, minimum,
 * maximum or format — the registry rejects those.
 * ------------------------------------------------------------------ */

const ICON_PARAMETERS = [
  { type: "string", description: ICON_TEXT.string },
  { type: "object", additionalProperties: true, description: ICON_TEXT.object },
  { type: "null", description: ICON_TEXT.null },
];

/** Notion rejects an empty `old_str`; that is enforced in readContentEdits, not in the schema. */
const EDIT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    old_str: {
      type: "string",
      description: EDIT_ITEM_TEXT.old_str,
    },
    new_str: {
      type: "string",
      description: EDIT_ITEM_TEXT.new_str,
    },
    replace_all_matches: {
      type: "boolean",
      description: EDIT_ITEM_TEXT.replace_all_matches,
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
      description: CREATE_PARAMS.parent,
    },
    title: {
      type: "string",
      description: CREATE_PARAMS.title,
    },
    props: { type: "object", additionalProperties: true, description: PROPS_DESCRIPTION },
    icon: { oneOf: ICON_PARAMETERS, description: ICON_PARAMETER_TEXT_CREATE },
    body_content: {
      type: "string",
      description: CREATE_PARAMS.body_content,
    },
  },
  // `parent` is NOT required: omitting it creates the page at the WORKSPACE ROOT, which
  // is what `ntn pages create` and POST /v1/pages do when no parent is given. Requiring
  // it would be a restriction neither the CLI nor the API has.
  additionalProperties: false,
};

const EDIT_PARAMETERS = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: EDIT_PARAMS.id,
    },
    edits: {
      type: "array",
      items: EDIT_ITEM_SCHEMA,
      description: EDIT_PARAMS.edits,
    },
    body_content: {
      type: "string",
      description: EDIT_PARAMS.body_content,
    },
    props: { type: "object", additionalProperties: true, description: PROPS_DESCRIPTION },
    title: { type: "string", description: EDIT_PARAMS.title },
    icon: { oneOf: ICON_PARAMETERS, description: ICON_PARAMETER_TEXT_EDIT },
    parent: {
      type: "string",
      description: EDIT_PARAMS.parent,
    },
    yes: {
      type: "boolean",
      description: EDIT_PARAMS.yes,
    },
  },
  required: ["id"],
  additionalProperties: false,
};

/**
 * `notion_page_trash` takes ONE argument.
 *
 * There is deliberately no `yes`/`recursive`: the confirmation is the pending that a
 * subtree delete returns, and it is answered in a later model step through double_check.
 * A caller carrying the old parameters still works — `execute` ignores them instead of
 * failing, because "I meant to confirm" is no longer something a parameter can express.
 */
const TRASH_PARAMETERS = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: TRASH_PARAMS.id,
    },
  },
  required: ["id"],
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
    body_chars: { type: "integer" },
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

/**
 * The value a gated delete returns instead of a success.
 *
 * It is NOT an error: nothing failed and nothing was written. It is returned as the
 * canonical value so the model gets a structured `id` to answer with, and so
 * `output.render` can say "not executed" in words.
 */
const TRASH_PENDING_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", const: "pending" },
    id: { type: "string" },
    reason: { type: "string" },
    details: { description: TRASH_PENDING_OUTPUT_TEXT.details },
  },
  required: ["kind", "id", "reason"],
  additionalProperties: false,
};

/**
 * Trash can end in either shape, so its schema is a `oneOf`.
 *
 * The branches cannot overlap: a success always carries `ok`/`properties`/`changed`
 * (which the pending forbids), and a pending always carries `kind`/`reason` (which the
 * success forbids). Create and edit keep the plain success schema — they never pend.
 */
const TRASH_OUTPUT_SCHEMA = {
  oneOf: [PAGE_OUTPUT_SCHEMA, TRASH_PENDING_OUTPUT_SCHEMA],
};

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/** `notion_page_create` — one page (or database row), with its columns, icon and body. */
export function createNotionPageCreateTool(deps: NotionPageDeps = {}): NotionTool<PageToolValue> {
  const runner: NtnRunner = deps.runNtn ?? runNtn;

  return defineNotionTool<PageToolValue>({
    name: "notion_page_create",
    description: TOOL_DESCRIPTIONS.pageCreate,
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
    description: TOOL_DESCRIPTIONS.pageEdit,
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
        throw new InputError(PAGE_ERRORS.createNotionPageEditTool_1,
          { field: "yes" }
        );
      }

      const appends = body !== undefined && body.trim() !== "";
      // `edits` and `body_content` are two different content operations (find-and-replace
      // vs append). Running one and silently dropping the other would report success for a
      // write that never happened, so the combination is refused instead of guessed.
      if (edits.length > 0 && body !== undefined) {
        throw new InputError(PAGE_ERRORS.createNotionPageEditTool_2,
          { conflict: true, fields: ["edits", "body_content"] }
        );
      }
      if (edits.length === 0 && !appends && props === undefined && title === undefined && icon === undefined && args.parent === undefined) {
        throw new InputError(PAGE_ERRORS.createNotionPageEditTool_3({ bodyProvided: body !== undefined }));
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

/** `notion_page_trash` — delete one page (or row); a subtree delete needs a second step. */
export function createNotionPageTrashTool(deps: NotionPageDeps = {}): NotionTool<PageToolValue | PendingValue> {
  const runner: NtnRunner = deps.runNtn ?? runNtn;

  return defineNotionTool<PageToolValue | PendingValue>({
    name: "notion_page_trash",
    description: TOOL_DESCRIPTIONS.pageTrash,
    timeoutMs: TOOL_TIMEOUTS.page,
    isConcurrencySafe: () => false,
    parameters: TRASH_PARAMETERS as unknown as JsonObject,
    output: {
      schema: TRASH_OUTPUT_SCHEMA as unknown as JsonObject,
      render: (_args, value) =>
        textBlocks(isPendingValue(value) ? describeTrashPending(value) : describePageValue(value)),
    },

    async execute(args, exec) {
      // `yes` / `recursive` are the previous version's parameters. They are accepted and
      // IGNORED rather than rejected: a model carrying the old contract would otherwise
      // burn a round trip on INVALID_INPUT for something it cannot express any more, and
      // "I meant to confirm" is exactly what the pending now asks it to say out loud.
      rejectUnexpectedParams(
        args,
        ["id", "yes", "recursive"],
        "notion_page_trash 只接受 { id }（yes/recursive 已不再需要，传了也会被忽略）。"
      );
      if (exec.signal?.aborted) throw abortError();

      return await trashPage(
        { id: requireId(args.id, "trash") },
        bindSignal(runner, exec.signal),
        { exec, getDoublecheck: deps.getDoublecheck }
      );
    },
  });
}

/** Narrow a trash value to the pending branch (the success branch has `ok`, this has `kind`). */
function isPendingValue(value: PageToolValue | PendingValue): value is PendingValue {
  return (value as { kind?: unknown }).kind === "pending";
}

