/**
 * 模型读到的工具描述（tool description）。
 *
 * 这些字符串是「模型行动前唯一读得到的东西」——工具名之后、调用之前。改一个词就可能
 * 改变模型的行为选择，所以它们集中放在这里，而不是散在四个 tools/*.ts 的注册代码里。
 *
 * 编写约定：
 *   - 只说「这个工具做什么」和「不能做什么」；参数怎么填写在 params.ts，结果怎么读写在
 *     results.ts。同一条规则只在一处出现，否则两处早晚会改漏一处。
 *   - 凡是写进来的事实都必须被实测验证过；拿不准的宁可不写。
 */

export const TOOL_DESCRIPTIONS = {
  /** `notion_search` */
  search:

    "Search Notion by TITLE; returns id, title, URL and object type (page|database). " +
    "MATCHING IS TOKEN-OR, NOT SUBSTRING: the query is split into words and any title containing ANY ONE of " +
    "them comes back, ranked — so a long query yields loosely-related hits, not just the one you meant. " +
    'Wrap a known EXACT title in double quotes ("PRD · notion_page") to get exactly that hit. ' +
    "TITLES only: body text is never searched, and a 0-hit result does NOT prove absence (a fresh page may " +
    "not be indexed for a second or two; retry once). A hit is not proof it is the right object: verify " +
    "with notion_get. Use filter_object or limit to narrow; prefer refining the query over raising limit.",
  /** `notion_get` */
  get:

    "Read one Notion page or inspect one database. A page returns Markdown (format='md', default) with " +
    "its properties as frontmatter, or a structured payload (format='json') that also carries url, " +
    "title, truncated and unknown_block_ids. A database returns every data source id plus each " +
    "property's name, type, writable flag and Parent-item / self-relation candidates; rows are never " +
    "fetched here, so read them with notion_query. If a page comes back truncated (rare), format='json' " +
    "shows unknown_block_ids; the truncated Markdown lists the next steps.",
  /** `notion_query` */
  query:

    "Query the rows of a known Notion data source (or database) with a Notion filter, sort specs and " +
    "cursor pagination; returns rows, next_cursor and has_more. This is not keyword search: find the " +
    "data source with notion_search first when you only know a title, and read its schema with " +
    "notion_get. Pass filter as a raw Notion filter JSON object and sort as \"Property asc|desc\" or an " +
    "array of those. Use under to list only the child rows of one parent row; it filters the data " +
    "source's Parent-item column and is ANDed with filter, so do not also filter that column in " +
    "filter. When has_more is true, call again with next_cursor as start_cursor instead of raising " +
    "limit, which is capped at 100. include_content defaults to false and costs one extra ntn pages " +
    "get call per row.",
  /** `notion_page_create` */
  pageCreate:

    "Create one Notion page or database row. This tool never modifies an existing page — use " +
    "notion_page_edit for that. " +
    "`parent` is OPTIONAL: omit it to create the page at the WORKSPACE ROOT (Notion's own default; such a " +
    "page has only a title, so props cannot carry columns). " +
    "A page created inside a database needs a title: the `title` parameter, the title property in props, or " +
    "a leading \"# Heading\" in body_content. " +
    "Creating takes a SECOND request for the columns and icon. If that request fails the new page is trashed " +
    "so no half-made page is left behind, and the error reports whether the cleanup worked (`rollback`) — " +
    "partial:true means something was left behind. " +
    "A successful result reports the title, the body it wrote, the columns and the icon separately.",
  /** `notion_page_edit` */
  pageEdit:

    "Change an existing Notion page: find-and-replace its text, append Markdown, update title/columns/icon, " +
    "and/or move it. A single call may combine all of these. " +
    "THE STEPS ARE INDEPENDENT: they run in this order — (1) body content, (2) title/props/icon, " +
    "(3) parent move — and a failure in one does NOT cancel the others. A failed old_str is a bad argument, " +
    "not a broken page, so a valid title change or move still happens. The result then reports 部分成功 with " +
    "exactly what landed and what did not: retry ONLY the failed part, because resending the whole call " +
    "re-applies the parts that already succeeded. " +
    "`changed` lists what actually happened. " +
    "There is NO whole-page replace in this tool: to rewrite everything, delete the old text with edits " +
    "(new_str \"\") and append the new text in a second call. " +
    "When the returned body was truncated the result says so — truncated markdown is not the full page, so do " +
    "not derive the next old_str from it.",
  /** `notion_page_trash` */
  pageTrash:

    "Move one Notion page or database row to the trash. " +
    "A page with NO child pages is deleted by this one call, immediately. " +
    "A page WITH child pages is NOT deleted by this one call: it returns kind:'pending' and lists every child " +
    "page (id + title) that would go with it, because Notion always trashes the whole subtree. You must then " +
    "answer that pending in a LATER model step with double_check — yes:true deletes the whole subtree, " +
    "yes:false cancels; double_check becomes visible with the first pending. If the doublecheck service is " +
    "unavailable, a subtree delete fails without deleting anything. " +
    "Two things are refusals rather than pendings: a database or data source is refused outright (deleting one " +
    "destroys its rows too — ask the user to do it in Notion), and a page whose child list cannot be read is " +
    "refused because the scope could not be stated. A page already in the trash returns success with " +
    "already_archived:true and changed:[] — nothing was written. Trash is idempotent: calling it twice is safe.",
} as const;
