/**
 * 模型读到的「待复核」文案（doublecheck 的 pending）。
 *
 * 只有一种删除会走到这里：目标页面**有子页面**。没有子页面的删除是一次普通调用，
 * 不经过复核，所以这里没有「单页删除」的文案。
 *
 * 为什么文案分两半：
 *   - `TRASH_CHECKS.*` 生成 risk 的 `reason`。确认时 doublecheck 会拿原参数重放，并用
 *     逐字节相同的 risk 快照来判断「还是同一件事」，所以 reason 必须是确定性的；
 *   - `TRASH_PENDING_TEXT.confirm/cancel` 生成答复行，里面要填 pending id，而 id 是
 *     risk 快照**之后**才由 doublecheck 生成的 —— 它只能由渲染代码拼进去，不能进 reason。
 *
 * 写作约定与 errors.ts 相同：一条事实只写一处，每个插值都注明来源。
 */

/** 风险码：删除页会连带整棵子树。机器读 `code`，人读 `reason`。 */
export const TRASH_RISK_CODES = {
  subtree: "notion.trash.subtree.v1",
} as const;

/** 子项的种类标签：一个子页面、一个内联数据库、一个可能套着页面的块。 */
export const TRASH_CHILD_LABELS = {
  page: "子页面",
  database: "子数据库",
  container: "嵌套容器",
} as const;

export const TRASH_CHECKS = {
  /** 列表里的一行。种类要说清楚：把 toggle 容器写成「子页面」是在报一个不存在的页面。 */
  childLine: (p: { kind: keyof typeof TRASH_CHILD_LABELS; label: string; id: string }): string =>
    `  - [${TRASH_CHILD_LABELS[p.kind]}] ${p.label} — ${p.id}`,
  // kind ← listChildPages 判定的种类
  // label ← 子页面/数据库的标题，嵌套容器是块类型（比如 toggle）
  // id ← 子项的块 id

  /** 超过列出上限时补的一行：数量要说全，别让「只删父页面」看起来像「只删了列出来的那些」。 */
  overflow: (p: { rest: number; total: number }): string =>
    `\n  …另有 ${p.rest} 个未列出（共 ${p.total} 个，完整清单见 Notion）。`,
  // rest ← children.length - MAX_LISTED_CHILDREN
  // total ← children.length

  /** 有子页面时唯一要复核的事：这一删会连整棵子树一起进回收站。 */
  subtree: (p: {
    /** 目标是页面还是数据行。 */
    target: string;
    /** 标题，读不到时是占位符。 */
    title: string;
    /** 页面 id。 */
    id: string;
    /** 会被一起删掉的子项数量。 */
    count: number;
    /** 逐行列出子项的 `  - [子页面] 标题 — id`，已按 id 排序。 */
    listed: string;
    /** 超过列出上限时的「另有 N 个未列出」；没有就是空串。 */
    overflow: string;
  }): string =>
    `删除${p.target}「${p.title}」(${p.id})，会连带 ${p.count} 个子页面一起进入 Notion 回收站：\n` +
    `${p.listed}${p.overflow}\n` +
    "没有「只删父页面、保留子页面」这个选项。",
  // target ← 目标种类（"页面" / "数据行"）
  // title ← pageTitleOf(v1/pages/{id} 的响应)
  // id ← 参数 id
  // count ← children.length
  // listed ← 前 MAX_LISTED_CHILDREN 行 childLine
  // overflow ← children.length > MAX_LISTED_CHILDREN 时的剩余数量
} as const;

/** `notion_page_trash` 的 pending 值里，`details` 字段在 output schema 上的说明。 */
export const TRASH_PENDING_OUTPUT_TEXT = {
  details: "Stable JSON evidence from doublecheck; reason already states it in words.",
} as const;

export const TRASH_PENDING_TEXT = {
  /**
   * pending 的第一行。
   *
   * 上一版的删除必须先传 yes:true，模型很可能把 pending 读成「失败了，重试」，
   * 所以第一句就否认这个读法：没有失败，也还没有删除。
   */
  head: "待复核 · 未删除：目标还在原处。这不是失败 —— 有子页面的删除要先过复核。",

  /** 确认删除整棵子树。 */
  confirm: (p: { id: string }): string =>
    `确认删除 → double_check({ "id": "${p.id}", "yes": true })`,
  // id ← pending.id（doublecheck 生成的四位十六进制）

  /** 放弃删除。 */
  cancel: (p: { id: string }): string =>
    `不删除   → double_check({ "id": "${p.id}", "yes": false })`,
  // id ← pending.id

  /** 只想删父页面时的替代路径：复核不会替调用方保留子页面。 */
  onlyParent: (p: { id: string }): string =>
    `只想删父页面 → 先 double_check({ "id": "${p.id}", "yes": false })，` +
    "再用 notion_page_edit 把上面列出的子页面逐个移到别处，最后重新调用 notion_page_trash。",
  // id ← pending.id
} as const;
