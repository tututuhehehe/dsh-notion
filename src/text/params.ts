/**
 * 模型读到的参数描述（parameter description）。
 *
 * 这里只回答「这个参数怎么填」。工具的职责在 tools.ts，结果怎么读在 results.ts。
 * 带插值的用函数（比如 limit 的上限来自常量），纯静态的用常量。
 */

export const SEARCH_PARAMS = {
  /** `query` */
  query:

    "Keyword matched against object TITLES only (never body text). See the tool description for how " +
    "matching works: it is token-OR, and an exact title in double quotes is the precise lookup.",
  /**
   * `limit` — a function because the numbers are behaviour constants that live with the
   * tool (they are also what the code clamps against), and a text module must not import
   * from the tool that imports it.
   */
  limit: (p: { fallback: number; max: number }): string =>
    `Max results (default ${p.fallback}). Values above ${p.max} are clamped to ${p.max}.`,
  /** `filter_object` */
  filter_object:
    "Restrict hits to pages or databases (data sources). Omit to search both.",
} as const;

export const GET_PARAMS = {
  /** `id_or_url` */
  id_or_url:

    "Notion page or database ID (dashed UUID or 32-character id) or a notion.so / app.notion.com URL.",
  /** `format` */
  format:

    "Page output. 'md' (default) returns the Markdown body with properties as frontmatter; " +
    "'json' returns the structured page payload (markdown plus url/title/truncation metadata). " +
    "Databases are always returned as schema, regardless of format.",
} as const;

export const QUERY_PARAMS = {
  /** `database_or_data_source` */
  database_or_data_source:

    "Notion data source id, database id, or Notion URL. If the database has multiple data sources, pass one data source id explicitly.",
  /** `limit` — see the note on SEARCH_PARAMS.limit. */
  limit: (p: { fallback: number; max: number }): string =>
    `Max rows per page (default ${p.fallback}, clamped to ${p.max}).`,
  /** `start_cursor` */
  start_cursor:

    "Pagination cursor from a previous response's next_cursor. Omit for the first page.",
  /** `filter` */
  filter:
    "Raw Notion filter JSON object, passed through verbatim.",
  /** `sort` */
  sort:

    "Only rows linked to this parent row (id or Notion URL), filtered through the data source's Parent-item / self-relation column. Combined with filter via AND; refuses when filter already targets that same relation column.",
  /** `under` */
  under:
    'Sort spec "Property asc|desc", or an ordered array of specs for multiple sorts.',
  /** `include_content` */
  include_content:

    "Also fetch each row's Markdown with ntn pages get (default false; one extra call per row).",
} as const;
/**
 * notion_page_* 的参数、props 与 icon 描述。
 *
 * `props` 与 `icon` 在 create 和 edit 上共用同一份说明，所以单独导出、两处引用，
 * 避免同一段规则写两遍。
 */

/** `props`：create 与 edit 共用。 */
export const PROPS_DESCRIPTION =
    "Object map of database column NAME → simplified value (e.g. {\"Status\":\"进行中\",\"标签\":[\"a\",\"b\"],\"截止日期\":\"2025-01-31\",\"Done\":true}); {} = no property write. " +
    "The value is converted by the column TYPE from the parent data source's schema: title/rich_text string; number number|numeric string; select/status string or {name} (\"\"/null clears); multi_select string[]; date \"YYYY-MM-DD\" | ISO string | {start,end?,time_zone?}; checkbox boolean; url/email/phone string (\"\"/null clears); people/relation string[] of ids. " +
    "null clears a property where Notion allows it, and an object carrying its own type key (e.g. {\"select\":{\"name\":\"Done\"}}) is sent as-is. " +
    "Unknown names and read-only columns (formula/rollup/created_time/…) are rejected with hint_properties. " +
    "COLUMNS ONLY: the page icon is the top-level icon parameter and the page body is the top-level body_content parameter, not props keys. No default property values are invented.";

/** `icon` 的三种取值形式，对应 oneOf 的三个分支。 */
export const ICON_TEXT = {
  /** 分支 `string` */
  string:
    "An emoji (\"🎯\") or an http(s) image URL.",
  /** 分支 `object` */
  object:
    "An already-typed Notion icon object, e.g. {\"type\":\"emoji\",\"emoji\":\"🎯\"} or {\"type\":\"external\",\"external\":{\"url\":\"https://…/a.png\"}}.",
  /** 分支 `null` */
  null:
    "null clears the icon.",
} as const;

export const EDIT_ITEM_TEXT = {
  /** `old_str` */
  old_str:
    "Required, non-empty. The existing text to find. Substring matching: one word, one sentence or several " +
    "blocks all work — you do not have to resend the whole paragraph. " +
    "COPY WHAT notion_get SHOWED YOU, MARKERS AND ALL — that always matches, at any length. " +
    "A marker-free plain fragment also works, but only if it sits inside ONE formatting run: on " +
    "`Alpha **bold** omega`, `bold` and `Alpha ` match, `Alpha bold` does not (it crosses the bold boundary). " +
    "So the one way to fail is a plain fragment spanning a formatting change — when unsure, copy the markers. " +
    "Adjacent blocks join with \\n, which merges them on replace. A `$` may be bare or escaped.",
  /** `new_str` */
  new_str:
    "Required. The replacement text. \"\" DELETES old_str. It is markdown, so **bold**, `code`, [link](url), ## headings and - list items all render as that formatting; a new_str containing \\n\\n creates separate blocks and a single \\n is a line break inside one block. " +
    "A `$` may be written bare or escaped — this tool removes the escape before sending, so pasting the \\\\$ that notion_get renders is safe.",
  /** `replace_all_matches` */
  replace_all_matches:
    "Default false: if old_str matches more than one place the whole call fails and NOTHING is written. Set true to replace every occurrence. This is detected by Notion, not locally, so the tool cannot say which of your edits was ambiguous in advance — narrow the old_str or set this flag.",
} as const;

export const CREATE_PARAMS = {
  /** `parent` */
  parent:
    "Where the page goes. OMIT it to create the page at the WORKSPACE ROOT (Notion's default when no parent is given; such a page only has a title, so props cannot carry columns). Otherwise: page:<id> (child page), database:<id> | data-source:<id> (a row in that database), or a bare page/row id (a bare ROW id means a child row, linked through that data source's Parent-item / self-relation column). A Notion URL is accepted anywhere an id is: the id is extracted from it.",
  /** `title` */
  title:
    "Page title. A row in a database needs one (here, or as the title property in props, or as a leading \"# Heading\" in body_content).",
  /** `icon` */
  icon:
    "The page icon.",
  /** `body_content` */
  body_content:
    "The page body as Markdown. A leading \"# Heading\" becomes the title when title is absent.",
} as const;

export const EDIT_PARAMS = {
  /** `id` */
  id:
    "Required. The page id (32 hex or dashed UUID) or its Notion URL.",
  /** `edits` */
  edits:
    "Find-and-replace operations, applied in order (edit[i+1] sees edit[i]'s result). Max 100. " +
    "replace_all_matches belongs on the INDIVIDUAL edit object, not on the call. " +
    "Notion does the matching, so a call can end three ways: " +
    "all match -> success; " +
    "SOME match -> success, with the misses in `warnings` (nothing is rolled back, so do not assume the page now equals what you sent); " +
    "NONE match -> the call fails and nothing is written, which means the old_str were stale: re-read with notion_get instead of retrying the same string. " +
    "An old_str matching MORE THAN ONE place is a separate hard error: nothing is written unless that edit sets replace_all_matches:true. " +
    "Omit `edits` and pass body_content to APPEND instead.",
  /** `body_content` */
  body_content:
    "Markdown to APPEND at the end of the page. Only used when `edits` is empty or absent — this is the ONLY way to add new content, and edit never replaces the whole page. Passing body_content TOGETHER with a non-empty edits is an INVALID_INPUT error (nothing is written): append and find-replace cannot be combined in one call.",
  /** `title` */
  title:
    "New page title (writes the title property).",
  /** `icon` */
  icon:
    "New page icon; null clears it.",
  /** `parent` */
  parent:
    "Move the page: page:<id> (under that page), or a bare PAGE id, or a bare ROW id (re-link the Parent-item relation of that row). A Notion URL is accepted anywhere an id is. Database/data source parents are not accepted — use notion_page_create to add a row.",
  /** `yes` */
  yes:
    "Only for a row→row move: consent to REPLACE the row's existing Parent-item link, which otherwise refuses with the current parent ids. Ignored nowhere else — passing it without parent is an error.",
} as const;

export const TRASH_PARAMS = {
  /** `id` */
  id:
    "Required. The page id (32 hex or dashed UUID) or its Notion URL.",
  /** `yes` */
  yes:
    "Required true. Without it the tool refuses without calling ntn, so a trash is never a guess.",
  /** `recursive` */
  recursive:
    "Consent to delete the page together with its child pages (Notion archives the whole subtree). Without it a page that has child pages is refused with the child ids.",
} as const;

/**
 * 参数列表里 `icon` 自身的描述。
 *
 * 它和上面的 ICON_TEXT 不同：ICON_TEXT 描述的是 oneOf 每个分支接受什么，这一句是整个
 * 参数的标题级说明。create 与 edit 的措辞本来不同（edit 强调的是「改」，并说明 null 的
 * 含义），所以保持两份，不合并。
 */
export const ICON_PARAMETER_TEXT_CREATE = "The page icon.";
export const ICON_PARAMETER_TEXT_EDIT = "New page icon; null clears it.";
