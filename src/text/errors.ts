/**
 * 模型读到的错误消息（error message）。
 *
 * 一条错误要做三件事：说明**没做什么**、**为什么**、**下一步怎么改**。这些消息是模型
 * 出事时唯一能看的东西，所以它们和工具描述一样重要——只是触发时机不同。
 *
 * 编写约定：
 *   - 参数化的消息写成函数，参数名要对读者有意义（`got` / `name` / `hint`），不要 a/b/c。
 *   - 只写实测确认过的原因。识别不出原因就说「原因未知」，不要猜一个听起来合理的。
 *   - 需要模型采取动作的（比如"本次没有写入"），把那句话放进消息正文，不要只放在 details。
 */

/** `notion_search` 的错误。 */
export const SEARCH_ERRORS = {
  /** query 缺失或全是空白 */
  emptyQuery:
    "notion_search requires a non-empty query: pass a keyword. Notion search matches titles " +
    "(page/database names), not page body text.",
} as const;

/** `notion_get` 的错误。 */
export const GET_ERRORS = {
  /** id_or_url 里提取不出 Notion id */
  noIdInInput: (p: { raw: string }): string =>
    `Could not find a Notion ID in "${p.raw}". Pass a 32-character id ` +
    `(with or without dashes) or a notion.so / app.notion.com URL.`,
} as const;

/** `notion_query` 的错误。 */
export const QUERY_ERRORS = {
  /** sort 数组里的一项不是 "Property asc|desc" 字符串 */
  sortEntryNotString: (p: { got: string }): string =>
    `sort entries must be "Property asc|desc" strings, got ${p.got}.`,
  /** sort 数组里出现空字符串 */
  sortEntryEmpty: 'sort entries must be non-empty "Property asc|desc" strings.',
} as const;

/**
 * `notion_page_*` 的错误消息。
 *
 * 命名：`<抛出的函数>_<序号>`，按函数分组、按出现顺序编号；每条上面一行注释是这条消息
 * 在说什么。参数名取自原表达式里最后一个标识符（`describeValue(raw)` → `raw`），每条参数
 * 下面保留原始表达式，改动时能对得上。
 *
 * 为什么集中在这里：这些字符串是模型出错时唯一能看的东西。散在 3000 行的实现里，
 * 没人会通读一遍去比对措辞是否一致。
 *
 * 注意：`details`（结构化载荷）**不在这里** —— DSH 渲染前会丢掉它，模型看不到，所以
 * 凡是模型必须知道的话都已经写进下面这些消息的正文里了。
 */

export const PAGE_ERRORS = {
  /* ---------- rejectUnexpectedParams ---------- */
  /** … 多余的参数：…。 */
  rejectUnexpectedParams_1: (p: { usage: string | number, join: string }): string =>
    `${p.usage} 多余的参数：${p.join}。`,
  // usage ← usage
  // join ← unexpected.join(", ")

  /* ---------- normalizeIcon ---------- */
  /** icon 不能是空字符串：不设置 icon 就省略这个参数，清除已有 icon 请传 null。" */
  normalizeIcon_1:
    "icon 不能是空字符串：不设置 icon 就省略这个参数，清除已有 icon 请传 null。",

  /** icon 看起来既不是 emoji 也不是图片 URL（长度 …）：…。 + '请传单个 emoji（如 "🎯"）、http(s… */
  normalizeIcon_2: (p: { length: string | number, value: string }): string =>
    `icon 看起来既不是 emoji 也不是图片 URL（长度 ${p.length}）：${p.value}。` +
    '请传单个 emoji（如 "🎯"）、http(s) 图片 URL，或 null 清除。',
  // length ← [...value].length
  // value ← describeValue(value)

  /** icon 的 emoji 对象缺少 emoji 文本：需要 { "type": "emoji", "emoji": "🎯" }。… */
  normalizeIcon_3:
    'icon 的 emoji 对象缺少 emoji 文本：需要 { "type": "emoji", "emoji": "🎯" }。',

  /** icon 的 external 对象需要一个 http(s) url：' + '{ "type": "external", "e… */
  normalizeIcon_4:
    'icon 的 external 对象需要一个 http(s) url：' +
    '{ "type": "external", "external": { "url": "https://…/a.png" } }。',

  /** icon 的对象形式必须带 type：接受 "emoji" / "external" / "custom_emoji" / "f… */
  normalizeIcon_5: (p: { raw: string }): string =>
    'icon 的对象形式必须带 type：接受 "emoji" / "external" / "custom_emoji" / "file"，' +
    `或直接传 emoji 字符串、图片 URL、null。收到 ${p.raw}。`,
  // raw ← describeValue(raw)

  /** icon 必须是 emoji 字符串、http(s) 图片 URL、已构好的 Notion icon 对象，或 null（清除）… */
  normalizeIcon_6: (p: { raw: string }): string =>
    `icon 必须是 emoji 字符串、http(s) 图片 URL、已构好的 Notion icon 对象，或 null（清除）；` +
    `收到 ${p.raw}。`,
  // raw ← describeValue(raw)

  /* ---------- normalizeBody ---------- */
  /** body_content 必须是 Markdown 字符串，不能是 null。" */
  normalizeBody_1:
    "body_content 必须是 Markdown 字符串，不能是 null。",

  /** body_content 必须是 Markdown 字符串（页面正文），收到 …。 */
  normalizeBody_2: (p: { raw: string }): string =>
    `body_content 必须是 Markdown 字符串（页面正文），收到 ${p.raw}。`,
  // raw ← describeValue(raw)

  /* ---------- normalizeProps ---------- */
  /** props 必须是对象 map（{属性名: 值}），不是数组。例如 {\"Status\":\"进行中\",\"标签\":[\"… */
  normalizeProps_1:
    "props 必须是对象 map（{属性名: 值}），不是数组。例如 {\"Status\":\"进行中\",\"标签\":[\"a\",\"b\"]}。",

  /** props 必须是对象 map（{属性名: 值}），收到 …。 */
  normalizeProps_2: (p: { raw: string }): string =>
    `props 必须是对象 map（{属性名: 值}），收到 ${p.raw}。`,
  // raw ← describeValue(raw)

  /* ---------- normalizeTitle ---------- */
  /** title 必须是字符串。" */
  normalizeTitle_1:
    "title 必须是字符串。",

  /* ---------- parseParentSpec ---------- */
  /** … 需要 parent：…。 */
  parseParentSpec_1: (p: { create: string | number, usage: string }): string =>
    `${p.create} 需要 parent：${p.usage}。`,
  // create ← op === "move" ? "移动页面（parent）" : "create"
  // usage ← usage

  /** parent 格式无效：…。用法：…。 + "接受 Notion id（32 位 hex / UUID）或该对象的 Notion… */
  parseParentSpec_2: (p: { raw: string | number, usage: string }): string =>
    `parent 格式无效：${p.raw}。用法：${p.usage}。` +
    "接受 Notion id（32 位 hex / UUID）或该对象的 Notion URL。",
  // raw ← describeValue(raw)
  // usage ← usage

  /** parent 里的 id 无效：…。接受 Notion id（32 位 hex / UUID）或 URL， + "例如 data… */
  parseParentSpec_3: (p: { match: string }): string =>
    `parent 里的 id 无效：${p.match}。接受 Notion id（32 位 hex / UUID）或 URL，` +
    "例如 data-source:716f546f-1824-45f0-b73a-481bf8b5f5db。",
  // match ← describeValue(match[2])

  /* ---------- requireId ---------- */
  /** … 需要 id：页面 id（32 位 hex 或带连字符的 UUID）或该页面的 Notion URL。 */
  requireId_1: (p: { op: string }): string =>
    `${p.op} 需要 id：页面 id（32 位 hex 或带连字符的 UUID）或该页面的 Notion URL。`,
  // op ← op

  /** id 无效：…。只接受 Notion 页面 id（32 位 hex / UUID）或该页面的 Notion URL。 */
  requireId_2: (p: { raw: string }): string =>
    `id 无效：${p.raw}。只接受 Notion 页面 id（32 位 hex / UUID）或该页面的 Notion URL。`,
  // raw ← describeValue(raw)

  /* ---------- ntnFailure ---------- */
  /** …； : ""}… 失败…… : ""} + (hint ? \n… : "") */
  ntnFailure_1: (p: { note: string | number, label: string | number, status: string | number, detail: string | number, hint: string | undefined }): string =>
    `${p.note}${p.label} 失败${p.status}${p.detail}` +
    (p.hint ? `\n${p.hint}` : ""),
  // note ← note ? `${note}；` : ""
  // label ← label
  // status ← status
  // detail ← detail ? `：${truncate(detail)}` : ""
  // hint ← hint

  /* ---------- fetchDataSourceSchema ---------- */
  /** 无法从 … 读取属性列表：请确认 id 正确、Integration 已被邀请到该数据库，并且 parent 类型匹配（新版数据… */
  fetchDataSourceSchema_1: (p: { path: string }): string =>
    `无法从 ${p.path} 读取属性列表：请确认 id 正确、Integration 已被邀请到该数据库，并且 parent 类型匹配（新版数据库用 data-source:<id>）。`,
  // path ← path

  /* ---------- resolveDatabaseDataSource ---------- */
  /** database … 没有返回任何 data source id。请确认 Integration 已被邀请，并改用 data-s… */
  resolveDatabaseDataSource_1: (p: { databaseId: string }): string =>
    `database ${p.databaseId} 没有返回任何 data source id。请确认 Integration 已被邀请，并改用 data-source:<id> 指定。`,
  // databaseId ← databaseId

  /** database … 有 … 个 data source，需要唯一一个才能确定 schema。 + 请改用 parent: da… */
  resolveDatabaseDataSource_2: (p: { databaseId: string | number, length: string | number, n: string }): string =>
    `database ${p.databaseId} 有 ${p.length} 个 data source，需要唯一一个才能确定 schema。` +
    `请改用 parent: data-source:<id>，可选：\n${p.n}`,
  // databaseId ← databaseId
  // length ← refs.length
  // n ← lines.join("\n")

  /* ---------- assertNoRowCycle ---------- */
  /** Parent-item 祖先链超过 … 层，无法确认不会形成环；已停止，未写入。 */
  assertNoRowCycle_1: (p: { MAX_ANCESTOR_WALK: number }): string =>
    `Parent-item 祖先链超过 ${p.MAX_ANCESTOR_WALK} 层，无法确认不会形成环；已停止，未写入。`,
  // MAX_ANCESTOR_WALK ← MAX_ANCESTOR_WALK

  /** 行 … 不能挂到 … 下：那会形成 Parent-item 环（… 的祖先里有 …）。 */
  assertNoRowCycle_2: (p: { childId: string | number, parentId: string | number, parentId2: string | number, childId2: string }): string =>
    `行 ${p.childId} 不能挂到 ${p.parentId} 下：那会形成 Parent-item 环（${p.parentId2} 的祖先里有 ${p.childId2}）。`,
  // childId ← childId
  // parentId ← parentId
  // parentId2 ← parentId
  // childId2 ← childId

  /** 无法读取祖先行 …，因此无法确认把 … 挂到 … 下不会形成环；已在写入前停止。 */
  assertNoRowCycle_3: (p: { current: string | number, childId: string | number, parentId: string }): string =>
    `无法读取祖先行 ${p.current}，因此无法确认把 ${p.childId} 挂到 ${p.parentId} 下不会形成环；已在写入前停止。`,
  // current ← current
  // childId ← childId
  // parentId ← parentId

  /** 无法确认祖先行 … 所属的 data source，因此无法确认把 … 挂到 … 下不会形成环；已在写入前停止。 */
  assertNoRowCycle_4: (p: { current: string | number, childId: string | number, parentId: string }): string =>
    `无法确认祖先行 ${p.current} 所属的 data source，因此无法确认把 ${p.childId} 挂到 ${p.parentId} 下不会形成环；已在写入前停止。`,
  // current ← current
  // childId ← childId
  // parentId ← parentId

  /* ---------- classifyBareParent ---------- */
  /** 无法把 … 当作 parent：读取它作为页面失败…） : ""}。 + … 的裸 id 必须是页面或数据库行；如果它是 dat… */
  classifyBareParent_1: (p: { id: string | number, detail: string | number, create: string }): string =>
    `无法把 ${p.id} 当作 parent：读取它作为页面失败${p.detail}。` +
    `${p.create} 的裸 id 必须是页面或数据库行；如果它是 database 或 data source，请写成 database:<id> / data-source:<id>。`,
  // id ← id
  // detail ← detail ? `（${truncate(detail, 300)}）` : ""
  // create ← op === "create" ? "create" : "移动页面"

  /** 无法把 … 当作 parent：GET v1/pages 没有返回 parent。 + … 的裸 id 必须是页面或数据库行；如… */
  classifyBareParent_2: (p: { id: string | number, create: string }): string =>
    `无法把 ${p.id} 当作 parent：GET v1/pages 没有返回 parent。` +
    `${p.create} 的裸 id 必须是页面或数据库行；如果它是 database 或 data source，请写成 database:<id> / data-source:<id>。`,
  // id ← id
  // create ← op === "create" ? "create" : "移动页面"

  /* ---------- requireString ---------- */
  /** 属性 "…" (…) 需要字符串，收到 …。 */
  requireString_1: (p: { name: string | number, type: string | number, value: string }): string =>
    `属性 "${p.name}" (${p.type}) 需要字符串，收到 ${p.value}。`,
  // name ← prop.name
  // type ← prop.type
  // value ← describeValue(value)

  /* ---------- stringList ---------- */
  /** 属性 "…" (…) 需要 string[]，收到 …。 */
  stringList_1: (p: { name: string | number, type: string | number, value: string }): string =>
    `属性 "${p.name}" (${p.type}) 需要 string[]，收到 ${p.value}。`,
  // name ← prop.name
  // type ← prop.type
  // value ← describeValue(value)

  /* ---------- buildPropertyValue ---------- */
  /** 属性 "…" 是标题，不能设为 null。 */
  buildPropertyValue_1: (p: { name: string }): string =>
    `属性 "${p.name}" 是标题，不能设为 null。`,
  // name ← prop.name

  /** 属性 "…" (…) 不支持用 null 清空。 */
  buildPropertyValue_2: (p: { name: string | number, type: string }): string =>
    `属性 "${p.name}" (${p.type}) 不支持用 null 清空。`,
  // name ← prop.name
  // type ← prop.type

  /** 标题属性 "…" 不能为空。 */
  buildPropertyValue_3: (p: { name: string }): string =>
    `标题属性 "${p.name}" 不能为空。`,
  // name ← prop.name

  /** 属性 "…" (rich_text) 需要字符串，收到 …。 */
  buildPropertyValue_4: (p: { name: string | number, value: string }): string =>
    `属性 "${p.name}" (rich_text) 需要字符串，收到 ${p.value}。`,
  // name ← prop.name
  // value ← describeValue(value)

  /** 属性 "…" (number) 需要数字，收到 …。 */
  buildPropertyValue_5: (p: { name: string | number, value: string }): string =>
    `属性 "${p.name}" (number) 需要数字，收到 ${p.value}。`,
  // name ← prop.name
  // value ← describeValue(value)

  /** 属性 "…" (…) 需要选项名字符串，收到 …。 */
  buildPropertyValue_6: (p: { name: string | number, type: string | number, value: string }): string =>
    `属性 "${p.name}" (${p.type}) 需要选项名字符串，收到 ${p.value}。`,
  // name ← prop.name
  // type ← prop.type
  // value ← describeValue(value)

  /** 属性 "…" (date) 需要日期字符串或 {start,end}，收到 …。 */
  buildPropertyValue_7: (p: { name: string | number, value: string }): string =>
    `属性 "${p.name}" (date) 需要日期字符串或 {start,end}，收到 ${p.value}。`,
  // name ← prop.name
  // value ← describeValue(value)

  /** 属性 "…" (checkbox) 需要 true/false，收到 …。 */
  buildPropertyValue_8: (p: { name: string | number, value: string }): string =>
    `属性 "${p.name}" (checkbox) 需要 true/false，收到 ${p.value}。`,
  // name ← prop.name
  // value ← describeValue(value)

  /** 属性 "…" 的类型 … 暂不支持通过简化值写入；可改用 props 里直接给 Notion 原生 payload，例如 {"…… */
  buildPropertyValue_9: (p: { name: string | number, type: string | number, name2: string | number, type2: string }): string =>
    `属性 "${p.name}" 的类型 ${p.type} 暂不支持通过简化值写入；可改用 props 里直接给 Notion 原生 payload，例如 {"${p.name2}": {"${p.type2}": ...}}。`,
  // name ← prop.name
  // type ← prop.type
  // name2 ← prop.name
  // type2 ← prop.type

  /* ---------- resolveProperty ---------- */
  /** 未知属性 "…"。可用可写属性：…。 */
  resolveProperty_1: (p: { name: string | number, hints: string }): string =>
    `未知属性 "${p.name}"。可用可写属性：${p.hints}。`,
  // name ← name
  // hints ← formatHints(hints)

  /** 属性 "…" 的类型是 …（只读），不能写入。可写属性：…。 */
  resolveProperty_2: (p: { name: string | number, type: string | number, hints: string }): string =>
    `属性 "${p.name}" 的类型是 ${p.type}（只读），不能写入。可写属性：${p.hints}。`,
  // name ← name
  // type ← prop.type
  // hints ← formatHints(hints)

  /* ---------- readContentEdit ---------- */
  /** … 必须是 { old_str, new_str, replace_all_matches? }，收到 …。 */
  readContentEdit_1: (p: { path: string | number, raw: string }): string =>
    `${p.path} 必须是 { old_str, new_str, replace_all_matches? }，收到 ${p.raw}。`,
  // path ← path
  // raw ← describeValue(raw)

  /** … 只接受 old_str / new_str / replace_all_matches，多余字段：…。 */
  readContentEdit_2: (p: { path: string | number, join: string }): string =>
    `${p.path} 只接受 old_str / new_str / replace_all_matches，多余字段：${p.join}。`,
  // path ← path
  // join ← unexpected.join(", ")

  /** ….old_str 必须是字符串（要查找的原文），收到 …。 */
  readContentEdit_3: (p: { path: string | number, old_str: string }): string =>
    `${p.path}.old_str 必须是字符串（要查找的原文），收到 ${p.old_str}。`,
  // path ← path
  // old_str ← describeValue(raw.old_str)

  /** ….old_str 不能是空字符串：Notion 会拒绝空 old_str。要追加内容请用 body_content 且不传 e… */
  readContentEdit_4: (p: { path: string }): string =>
    `${p.path}.old_str 不能是空字符串：Notion 会拒绝空 old_str。要追加内容请用 body_content 且不传 edits。`,
  // path ← path

  /** ….new_str 是必填的：替换成什么就写什么，想删除这段文字请传 ""（空字符串）。 */
  readContentEdit_5: (p: { path: string }): string =>
    `${p.path}.new_str 是必填的：替换成什么就写什么，想删除这段文字请传 ""（空字符串）。`,
  // path ← path

  /** ….new_str 必须是字符串，收到 …。 */
  readContentEdit_6: (p: { path: string | number, new_str: string }): string =>
    `${p.path}.new_str 必须是字符串，收到 ${p.new_str}。`,
  // path ← path
  // new_str ← describeValue(raw.new_str)

  /* ---------- readContentEdits ---------- */
  /** edits 必须是数组：[{ old_str, new_str, replace_all_matches? }, ...]，收到… */
  readContentEdits_1: (p: { raw: string }): string =>
    `edits 必须是数组：[{ old_str, new_str, replace_all_matches? }, ...]，收到 ${p.raw}。` +
    `要追加内容请改用 body_content（不传 edits）。`,
  // raw ← describeValue(raw)

  /** edits 最多 … 条（Notion 限制），收到 … 条。请拆成多次 notion_page_edit 调用。 */
  readContentEdits_2: (p: { MAX_CONTENT_UPDATES: number, length: number }): string =>
    `edits 最多 ${p.MAX_CONTENT_UPDATES} 条（Notion 限制），收到 ${p.length} 条。请拆成多次 notion_page_edit 调用。`,
  // MAX_CONTENT_UPDATES ← MAX_CONTENT_UPDATES
  // length ← raw.length

  /* ---------- withEditAlias ---------- */
  /** edits 和 props.block_update 是同一个东西（查找替换列表），不要同时传；请统一用 edits。本次没有写… */
  withEditAlias_1:
    "edits 和 props.block_update 是同一个东西（查找替换列表），不要同时传；请统一用 edits。本次没有写入任何内容。",

  /* ---------- markdownFailure ---------- */
  /** 这次编辑会删除页面 … 里的子页面或子数据库，Notion 因此拒绝执行（本次没有写入任何内容）。 + "old_str 匹配的… */
  markdownFailure_1: (p: { pageId: string | number, detail: string }): string =>
    `这次编辑会删除页面 ${p.pageId} 里的子页面或子数据库，Notion 因此拒绝执行（本次没有写入任何内容）。` +
    "old_str 匹配的是整段文本，很容易连带覆盖 `<page url=\"...\">…</page>` 或 `<database ...>` 这类块。" +
    "请把 old_str 缩小到那段文字本身（不要包含子页面/子数据库块），或先在 Notion 里把子页面移走再改。" +
    `ntn 输出：${p.detail}`,
  // pageId ← pageId
  // detail ← truncate(detail, 600)

  /* ---------- buildPropertyWrite ---------- */
  /** context.pageId ? 无法确定页面 … 的标题属性，不能用 title 改标题；请改用 props 并指定标题属性名… */
  buildPropertyWrite_1: (p: { pageId: string | undefined, source: string }): string =>
    p.pageId
      ? `无法确定页面 ${p.pageId} 的标题属性，不能用 title 改标题；请改用 props 并指定标题属性名。`
      : `无法确定 ${p.source} 的标题属性，不能用 title 指定标题；请改用 props 并指定标题属性名。`,
  // pageId ← context.pageId            （有页面 id 时说的是「页面 …」，否则说容器类型）
  // source ← context.source

  /* ---------- parentItemError ---------- */
  /** data source … 没有可用的 Parent-item / 自关联 relation 列，无法把行挂到父行下（…）。 +… */
  parentItemError_1: (p: { dataSourceId: string | number, detail: string }): string =>
    `data source ${p.dataSourceId} 没有可用的 Parent-item / 自关联 relation 列，无法把行挂到父行下（${p.detail}）。` +
    "请在 Notion 里为这个库加一个指向自身的 relation 属性（默认名 Parent-item），或用 notion_get 查看现有列后重试。",
  // dataSourceId ← dataSourceId
  // detail ← detail

  /* ---------- rollbackCreatedPage ---------- */
  /** …… */
  rollbackCreatedPage_1: (p: { detail: string | number, rollbackLine: string }): string =>
    `${p.detail}${p.rollbackLine}`,
  // detail ← cause.detail
  // rollbackLine ← rollbackLine

  /** 回滚成功：新页面 … 已移入回收站（partial: false），没有留下半成品。 */
  rollbackCreatedPage_2: (p: { pageId: string }): string =>
    `\n已回滚：新页面 ${p.pageId} 已移入回收站（partial: false），没有留下半成品。`,
  // pageId ← pageId

  /** 回滚失败：… 该页面/行仍然存在（partial: true）。请手动清理：notion_page_trash { id: "…" }。 */
  rollbackCreatedPage_3: (p: { pageId: string, detail: string }): string =>
    `\n回滚失败：ntn pages trash ${p.pageId} 也失败了${p.detail ? `（${p.detail}）` : ""}，` +
    `该页面/行仍然存在（partial: true）。请手动清理：notion_page_trash { id: "${p.pageId}" }。`,
  // pageId ← pageId
  // detail ← truncate(detail, 300)

  /* ---------- createPage ---------- */
  /** 在 … 所在 data source : container.kind} 中创建页面需要标题： + 请传 title、在 pro… */
  createPage_1: (p: { kind: string | number, title: string | number, hints: string }): string =>
    `在 ${p.kind} 中创建页面需要标题：` +
    `请传 title、在 props 里写标题属性（${p.title}），` +
    `或让 body_content 以 "# 标题" 开头。可写属性：${p.hints}。`,
  // kind ← container.kind === "row" ? `行 ${container.rowParentId} 所在 data source` : contain
  // title ← titlePropertyName(container.schema) ?? "title"
  // hints ← formatHints(hints)

  /** create 需要 body_content 或 title：ntn pages create 不接受空 Markdown，只有… */
  createPage_2:
    "create 需要 body_content 或 title：ntn pages create 不接受空 Markdown，只有 parent 无法创建空白页面。",

  /** 页面已创建（parent …），但没有从 ntn 的结构化输出里取到页面 id， + …未写入。 + 没有可信 id 就不自动 … */
  createPage_3: (p: { workspace: string | number, what: string }): string =>
    `页面已创建（parent ${p.workspace}），但没有从 ntn 的结构化输出里取到页面 id，` +
    `${p.what}未写入。` +
    `没有可信 id 就不自动 trash（避免误删），请用 notion_search/notion_get 找到该页面后，` +
    `用 notion_page_edit 写入，或 notion_page_trash 删除（partial: true，rollback: unknown_id）。`,
  // workspace ← parentLabel ?? "workspace"
  // what ← what

  /* ---------- editWithFailures ---------- */
  /** 部分成功。已经生效的部分：…（已写入，不会回滚）。\n + 失败的部分：\n…\n + 这些步骤互不依赖，所以其余步骤照常执行了… */
  editWithFailures_1: (p: { join: string | number, reported: string }): string =>
    `部分成功。已经生效的部分：${p.join}（已写入，不会回滚）。\n` +
    `失败的部分：\n${p.reported}\n` +
    `这些步骤互不依赖，所以其余步骤照常执行了。重试时请只重发失败的部分；` +
    `重发全部会把已生效的部分重复应用一遍。`,
  // join ← applied.join("、")
  // reported ← reported

  /* ---------- movePage ---------- */
  /** edit 的 parent（移动页面）只支持 page:<id> 或（裸）行 id：页面挂到页面下用 POST /v1/page… */
  movePage_1:
    "edit 的 parent（移动页面）只支持 page:<id> 或（裸）行 id：页面挂到页面下用 POST /v1/pages/{id}/move，行挂到行下用 Parent-item relation。" +
    "要把页面放进某个 data source，请用 notion_page_create。",

  /** 无法确定页面 … 的当前父级（GET v1/pages 未返回 parent）。移动页面不会在没有确认的情况下执行。 */
  movePage_2: (p: { id: string }): string =>
    `无法确定页面 ${p.id} 的当前父级（GET v1/pages 未返回 parent）。移动页面不会在没有确认的情况下执行。`,
  // id ← id

  /** 页面 … 不能挂到自己下面。 */
  movePage_3: (p: { id: string }): string =>
    `页面 ${p.id} 不能挂到自己下面。`,
  // id ← id

  /** 页面 … 已经是 … 的子页面，无需移动。 */
  movePage_4: (p: { id: string | number, targetParentId: string }): string =>
    `页面 ${p.id} 已经是 ${p.targetParentId} 的子页面，无需移动。`,
  // id ← id
  // targetParentId ← targetParentId

  /** 页面 … 不能挂到页面 … 下：会形成环（…）。 */
  movePage_5: (p: { id: string | number, targetParentId: string | number, join: string }): string =>
    `页面 ${p.id} 不能挂到页面 ${p.targetParentId} 下：会形成环（${p.join}）。`,
  // id ← id
  // targetParentId ← targetParentId
  // join ← cycle.cycle.join(" → ")

  /** 无法把页面挂到 data source 容器下；请改用 notion_page_create。" */
  movePage_6:
    "无法把页面挂到 data source 容器下；请改用 notion_page_create。",

  /** 页面 … 不在数据库里（父级是页面… : ""}）， + 不能用 Parent-item relation 挂到行 … 下；行→… */
  movePage_7: (p: { id: string | number, id2: string | number, rowParentId: string }): string =>
    `页面 ${p.id} 不在数据库里（父级是页面${p.id2}），` +
    `不能用 Parent-item relation 挂到行 ${p.rowParentId} 下；行→行的移动只适用于同一库内的行。`,
  // id ← id
  // id2 ← childParent.id ? ` ${childParent.id}` : ""
  // rowParentId ← container.rowParentId

  /** 行 … 不能挂到自己下面。 */
  movePage_8: (p: { id: string }): string =>
    `行 ${p.id} 不能挂到自己下面。`,
  // id ← id

  /** 行 … 属于 data source …，父行 … 属于 …； + "自关联 Parent-item 只能在同一 data so… */
  movePage_9: (p: { id: string | number, childDataSourceId: string | number, rowParentId: string | number, dataSourceId: string }): string =>
    `行 ${p.id} 属于 data source ${p.childDataSourceId}，父行 ${p.rowParentId} 属于 ${p.dataSourceId}；` +
    "自关联 Parent-item 只能在同一 data source 内使用，跨库请改用 page 父级或 notion_page_create。",
  // id ← id
  // childDataSourceId ← childDataSourceId
  // rowParentId ← container.rowParentId
  // dataSourceId ← container.dataSourceId

  /** 行 … 的 …（Parent-item）已经指向 …， + 移到 … 下会覆盖这个链接。确认要改父级请传 yes: true；本… */
  movePage_10: (p: { id: string | number, name: string | number, join: string | number, rowParentId: string }): string =>
    `行 ${p.id} 的 ${p.name}（Parent-item）已经指向 ${p.join}，` +
    `移到 ${p.rowParentId} 下会覆盖这个链接。确认要改父级请传 yes: true；本次没有写入。`,
  // id ← id
  // name ← relation.name
  // join ← currentParents.join(", ")
  // rowParentId ← container.rowParentId

  /* ---------- listChildPages ---------- */
  /** 页面 … 的子块列表无法解析，不能确认它有多少子页面，因此拒绝删除。 + ntn 输出：… */
  listChildPages_1: (p: { pageId: string | number, trim: string }): string =>
    `页面 ${p.pageId} 的子块列表无法解析，不能确认它有多少子页面，因此拒绝删除。` +
    `ntn 输出：${p.trim}`,
  // pageId ← pageId
  // trim ← truncate((result.stdout || "").trim(), 200)

  /** 页面 … 的子块报告 has_more=true 却没有 next_cursor，无法读完子页面列表，因此拒绝删除。 */
  listChildPages_2: (p: { pageId: string }): string =>
    `页面 ${p.pageId} 的子块报告 has_more=true 却没有 next_cursor，无法读完子页面列表，因此拒绝删除。`,
  // pageId ← pageId

  /** 页面 … 的子块超过 … 页仍未列完，无法确认它有多少子页面，因此拒绝删除。 + "请在 Notion 里手动确认并删除。" */
  listChildPages_3: (p: { pageId: string | number, MAX_BLOCK_PAGES: number }): string =>
    `页面 ${p.pageId} 的子块超过 ${p.MAX_BLOCK_PAGES} 页仍未列完，无法确认它有多少子页面，因此拒绝删除。` +
    "请在 Notion 里手动确认并删除。",
  // pageId ← pageId
  // MAX_BLOCK_PAGES ← MAX_BLOCK_PAGES

  /* ---------- trashPage ---------- */
  /** 页面 … 不存在，或没有被当前的 Notion integration 共享（••• → Connections），因此无法删除… */
  trashPage_1: (p: { id: string }): string =>
    `页面 ${p.id} 不存在，或没有被当前的 Notion integration 共享（••• → Connections），因此无法删除。` +
    "请先用 notion_search 确认 id 正确。",
  // id ← id

  /** notion_page_trash cannot delete a database (id …). Removing a da… */
  trashPage_2: (p: { id: string }): string =>
    `notion_page_trash cannot delete a database (id ${p.id}). Removing a database, its data ` +
    "sources and every row in them is far more destructive than deleting a page, so this tool " +
    "refuses it outright — a review cannot authorize it either. Ask the user to delete it in " +
    "Notion (••• → Delete) if that is really intended.",
  // id ← id

  /** 页面 … 有 … 个子页面，删除会连带整棵子树，需要复核；doublecheck 服务不可用，因此没有删除。 */
  trashPage_3: (p: { id: string, count: number }): string =>
    `页面 ${p.id} 有 ${p.count} 个子页面，删除会连带整棵子树，所以必须先过 doublecheck 复核；` +
    "doublecheck 服务当前不可用，因此没有删除任何内容（页面和子页面都还在）。" +
    "请让用户在 Notion 里删除，或先启用 doublecheck 插件再重试。",
  // id ← id
  // count ← children.length

  /* ---------- createNotionPageEditTool ---------- */
  /** yes 只用于「行→行移动时覆盖已有 Parent-item 链接」，没有 parent 时传 yes 没有意义；请去掉 yes… */
  createNotionPageEditTool_1:
    "yes 只用于「行→行移动时覆盖已有 Parent-item 链接」，没有 parent 时传 yes 没有意义；请去掉 yes。本次没有写入。",

  /** edits（查找替换）和 body_content（追加到末尾）不能同时传：二选一。" + "需要既改又追加时请分两次调用 no… */
  createNotionPageEditTool_2:
    "edits（查找替换）和 body_content（追加到末尾）不能同时传：二选一。" +
    "需要既改又追加时请分两次调用 notion_page_edit。本次没有写入。",

  /** notion_page_edit 需要 edits、body_content、props、title、icon、parent 至… */
  createNotionPageEditTool_3: (p: { bodyProvided: boolean }): string =>
    "notion_page_edit 需要 edits、body_content、props、title、icon、parent 至少一项；空调用不会修改页面。" +
    (p.bodyProvided
      ? "body_content 是空白：追加空白内容不会修改页面。"
      : "要追加内容请传 body_content（不传 edits）。"),
  // bodyProvided ← body !== undefined

} as const;

/**
 * `src/dsh/doublecheck.ts` 适配层的错误。
 *
 * 这类失败不是调用方的参数问题，也不代表删除被拒绝：它意味着复核通道本身坏了，
 * 所以按 fail closed 处理 —— 什么都没删。消息必须把这一点说清楚，否则模型会去改参数。
 */
export const CHECK_ERRORS = {
  /** doublecheck 返回了无法识别的复核结果；按 fail closed 处理，没有执行删除。 */
  malformed:
    "doublecheck 返回了无法识别的复核结果，因此没有执行删除（fail closed）。" +
    "这是插件版本不匹配的迹象：请检查 doublecheck 与 dsh-notion 的版本。",
} as const;

