/**
 * 模型读到的**结果**文本里，属于「句子」的那些。
 *
 * 结果文本要回答「发生了什么、下一步怎么办」。这里只收句子级的话术；像 `URL: …`、
 * `parent: …`、`ID: …` 这类字段标签留在渲染代码里 —— 给它们套一层函数只会让调用处更
 * 难读，也没人会去评审「URL:」这几个字。
 *
 * 分工：发生了什么（这里）、下一步怎么改（errors.ts）、这个工具能做什么（tools.ts）。
 */

/** `notion_page_*` 的结果句子。 */
export const PAGE_RESULT_TEXT = {
  /** 移动时目标父级与当前一致 —— 报告「无需改动」而不是「已移动」 */
  alreadyLinked: (p: {
    hasParentItem: boolean;
    id: string;
    parentItemRowId: string;
    parentItemProperty: string;
    parent: string;
  }): string =>
    p.hasParentItem
      ? `行 ${p.id} 已经在父行 ${p.parentItemRowId} 下（Parent-item 列：${p.parentItemProperty}），无需改动`
      : `页面 ${p.id} 已经挂在 ${p.parent} 下，无需改动`,

  /** trash 的目标本来就在回收站里 —— 说明这次没有执行删除 */
  alreadyArchived: (p: { id: string }): string =>
    `页面 ${p.id} 本来就在回收站里，本次没有执行删除`,

  /** 环检测只跑了 best-effort（祖先链读不全） */
  cycleCheckPartial:
    "注意：页面祖先链未能完整读取，深层环检查为 best-effort（cycle_check: partial）",

  /** create 的结果：正文写了多少字。和「已写入列」分开两行，因为二者是两件事。 */
  bodyWritten: (p: { chars: number }): string => `正文：已写入 ${p.chars} 字`,
  /** create 的结果：本次没有正文（只有标题/属性） */
  bodyNotProvided: "正文：未提交正文内容（本次只有标题/属性）",

  /** edit 的查找替换统计：N/M 条已应用，并说明没匹配的那些 */
  editTally: (p: { applied: number; sent: number; missed: number }): string =>
    `edits: ${p.applied}/${p.sent} 条已应用` +
    (p.missed > 0
      ? `，${p.missed} 条 old_str 没有匹配（页面其余部分未改动，见 warnings）`
      : "，全部匹配"),

  /** edit 走的是追加路径（edits 为空 + body_content） */
  appended: "正文已追加到页面末尾（edits 为空 + body_content）",

  /** Notion 截断了返回的 markdown —— 提醒别拿它当完整页面用 */
  truncated:
    "注意：Notion 返回的 markdown 被截断（truncated: true），它不是完整页面；下一次 old_str 不要以它为准。",
} as const;

/** `notion_get` 的结果句子。 */
export const GET_RESULT_TEXT = {
  /** 数据库 schema 里列出可作为 Parent-item 的列 */
  parentItemCandidates: (p: { list: string }): string =>
    "Parent-item candidates (use one with notion_page_edit parent / a child-row create): " + p.list,

  /** 数据库结果说明：只给了 schema，没有倒出行 */
  schemaOnly: "Schema only — no rows. Use notion_query with a data_source_id to read pages.",
} as const;
