// src/dsh/tool.ts
var NOTION_ERROR_CODES = {
  /** The caller's arguments cannot be acted on; re-read the message and retry. */
  invalidInput: "INVALID_INPUT",
  /** `ntn` itself failed (bad token, no workspace, Notion API error, exit != 0). */
  ntnFailed: "NTN_FAILED",
  /** The call was cancelled or timed out; the child process was killed. */
  aborted: "ABORTED",
  /** A follow-up write failed and the page could not be fully cleaned up. */
  partialWrite: "PARTIAL_WRITE",
  /**
   * A destructive call needed a doublecheck review and the review channel was unusable
   * (service missing, or it answered something unreadable). Nothing was deleted, and the
   * caller's arguments were not the problem — fixing them will not help.
   */
  reviewUnavailable: "REVIEW_UNAVAILABLE"
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
var TOOL_TIMEOUTS = {
  search: 12e4,
  get: 12e4,
  page: 18e4,
  query: 3e5
};
function defineNotionTool(tool) {
  return tool;
}
function textBlocks(text2) {
  return [{ type: "text", text: text2 }];
}
function inputError(message, details) {
  return new NotionToolError(message, {
    code: NOTION_ERROR_CODES.invalidInput,
    ...details ? { details } : {}
  });
}
function codedError(error) {
  if (error instanceof NotionToolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NotionToolError(message, { code: NOTION_ERROR_CODES.ntnFailed });
}
function abortError() {
  return new NotionToolError("tool call aborted", { code: NOTION_ERROR_CODES.aborted });
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
function readEnum(raw, field, spellings) {
  if (typeof raw !== "string") {
    throw inputError(
      `${field} must be a string, got ${describe(raw)}. Accepted: ${spellingList(spellings)}.`,
      { field, value: raw }
    );
  }
  const folded = fold(raw);
  for (const spelling of spellings) {
    if (fold(spelling.value) === folded) return spelling.value;
    if (spelling.aliases.some((alias) => fold(alias) === folded)) return spelling.value;
  }
  throw inputError(
    `${field} "${raw}" is not recognized. Accepted: ${spellingList(spellings)}.`,
    { field, value: raw }
  );
}
function spellingList(spellings) {
  return spellings.map((spelling) => {
    const aliases = spelling.aliases.filter((alias) => fold(alias) !== fold(spelling.value));
    return aliases.length === 0 ? spelling.value : `${spelling.value} (also ${aliases.map((alias) => `"${alias}"`).join(", ")})`;
  }).join(" | ");
}
function fold(value) {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}
function readInteger(raw, field, min, max) {
  let value;
  if (typeof raw === "number" && Number.isFinite(raw)) value = Math.trunc(raw);
  else if (typeof raw === "string" && /^\s*-?\d+\s*$/.test(raw)) value = Number(raw.trim());
  else {
    throw inputError(
      `${field} must be an integer${max === void 0 ? "" : ` between ${min} and ${max}`}, got ${describe(raw)}.`,
      { field, value: raw }
    );
  }
  if (value < min) {
    throw inputError(`${field} must be >= ${min}, got ${value}.`, { field, value: raw });
  }
  if (max !== void 0 && value > max) return max;
  return value;
}
function readBoolean(raw, field) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number" && (raw === 1 || raw === 0)) return raw === 1;
  if (typeof raw === "string") {
    const folded = fold(raw);
    if (folded === "true" || folded === "yes" || folded === "1") return true;
    if (folded === "false" || folded === "no" || folded === "0") return false;
  }
  throw inputError(`field ${field} must be a boolean, got ${describe(raw)}.`, {
    field,
    value: raw
  });
}
function readString(raw, field) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw inputError(`${field} must be a non-empty string, got ${describe(raw)}.`, {
      field,
      value: raw
    });
  }
  return raw.trim();
}
function describe(value) {
  try {
    const text2 = JSON.stringify(value);
    return (text2 ?? String(value)).slice(0, 80);
  } catch {
    return String(value);
  }
}

// src/text/results.ts
var PAGE_RESULT_TEXT = {
  /** 移动时目标父级与当前一致 —— 报告「无需改动」而不是「已移动」 */
  alreadyLinked: (p) => p.hasParentItem ? `\u884C ${p.id} \u5DF2\u7ECF\u5728\u7236\u884C ${p.parentItemRowId} \u4E0B\uFF08Parent-item \u5217\uFF1A${p.parentItemProperty}\uFF09\uFF0C\u65E0\u9700\u6539\u52A8` : `\u9875\u9762 ${p.id} \u5DF2\u7ECF\u6302\u5728 ${p.parent} \u4E0B\uFF0C\u65E0\u9700\u6539\u52A8`,
  /** trash 的目标本来就在回收站里 —— 说明这次没有执行删除 */
  alreadyArchived: (p) => `\u9875\u9762 ${p.id} \u672C\u6765\u5C31\u5728\u56DE\u6536\u7AD9\u91CC\uFF0C\u672C\u6B21\u6CA1\u6709\u6267\u884C\u5220\u9664`,
  /** 环检测只跑了 best-effort（祖先链读不全） */
  cycleCheckPartial: "\u6CE8\u610F\uFF1A\u9875\u9762\u7956\u5148\u94FE\u672A\u80FD\u5B8C\u6574\u8BFB\u53D6\uFF0C\u6DF1\u5C42\u73AF\u68C0\u67E5\u4E3A best-effort\uFF08cycle_check: partial\uFF09",
  /** create 的结果：正文写了多少字。和「已写入列」分开两行，因为二者是两件事。 */
  bodyWritten: (p) => `\u6B63\u6587\uFF1A\u5DF2\u5199\u5165 ${p.chars} \u5B57`,
  /** create 的结果：本次没有正文（只有标题/属性） */
  bodyNotProvided: "\u6B63\u6587\uFF1A\u672A\u63D0\u4EA4\u6B63\u6587\u5185\u5BB9\uFF08\u672C\u6B21\u53EA\u6709\u6807\u9898/\u5C5E\u6027\uFF09",
  /** edit 的查找替换统计：N/M 条已应用，并说明没匹配的那些 */
  editTally: (p) => `edits: ${p.applied}/${p.sent} \u6761\u5DF2\u5E94\u7528` + (p.missed > 0 ? `\uFF0C${p.missed} \u6761 old_str \u6CA1\u6709\u5339\u914D\uFF08\u9875\u9762\u5176\u4F59\u90E8\u5206\u672A\u6539\u52A8\uFF0C\u89C1 warnings\uFF09` : "\uFF0C\u5168\u90E8\u5339\u914D"),
  /** edit 走的是追加路径（edits 为空 + body_content） */
  appended: "\u6B63\u6587\u5DF2\u8FFD\u52A0\u5230\u9875\u9762\u672B\u5C3E\uFF08edits \u4E3A\u7A7A + body_content\uFF09",
  /** Notion 截断了返回的 markdown —— 提醒别拿它当完整页面用 */
  truncated: "\u6CE8\u610F\uFF1ANotion \u8FD4\u56DE\u7684 markdown \u88AB\u622A\u65AD\uFF08truncated: true\uFF09\uFF0C\u5B83\u4E0D\u662F\u5B8C\u6574\u9875\u9762\uFF1B\u4E0B\u4E00\u6B21 old_str \u4E0D\u8981\u4EE5\u5B83\u4E3A\u51C6\u3002"
};
var GET_RESULT_TEXT = {
  /** 数据库 schema 里列出可作为 Parent-item 的列 */
  parentItemCandidates: (p) => "Parent-item candidates (use one with notion_page_edit parent / a child-row create): " + p.list,
  /** 数据库结果说明：只给了 schema，没有倒出行 */
  schemaOnly: "Schema only \u2014 no rows. Use notion_query with a data_source_id to read pages."
};

// src/text/errors.ts
var SEARCH_ERRORS = {
  /** query 缺失或全是空白 */
  emptyQuery: "notion_search requires a non-empty query: pass a keyword. Notion search matches titles (page/database names), not page body text."
};
var GET_ERRORS = {
  /** id_or_url 里提取不出 Notion id */
  noIdInInput: (p) => `Could not find a Notion ID in "${p.raw}". Pass a 32-character id (with or without dashes) or a notion.so / app.notion.com URL.`
};
var QUERY_ERRORS = {
  /** sort 数组里的一项不是 "Property asc|desc" 字符串 */
  sortEntryNotString: (p) => `sort entries must be "Property asc|desc" strings, got ${p.got}.`,
  /** sort 数组里出现空字符串 */
  sortEntryEmpty: 'sort entries must be non-empty "Property asc|desc" strings.'
};
var PAGE_ERRORS = {
  /* ---------- rejectUnexpectedParams ---------- */
  /** … 多余的参数：…。 */
  rejectUnexpectedParams_1: (p) => `${p.usage} \u591A\u4F59\u7684\u53C2\u6570\uFF1A${p.join}\u3002`,
  // usage ← usage
  // join ← unexpected.join(", ")
  /* ---------- normalizeIcon ---------- */
  /** icon 不能是空字符串：不设置 icon 就省略这个参数，清除已有 icon 请传 null。" */
  normalizeIcon_1: "icon \u4E0D\u80FD\u662F\u7A7A\u5B57\u7B26\u4E32\uFF1A\u4E0D\u8BBE\u7F6E icon \u5C31\u7701\u7565\u8FD9\u4E2A\u53C2\u6570\uFF0C\u6E05\u9664\u5DF2\u6709 icon \u8BF7\u4F20 null\u3002",
  /** icon 看起来既不是 emoji 也不是图片 URL（长度 …）：…。 + '请传单个 emoji（如 "🎯"）、http(s… */
  normalizeIcon_2: (p) => `icon \u770B\u8D77\u6765\u65E2\u4E0D\u662F emoji \u4E5F\u4E0D\u662F\u56FE\u7247 URL\uFF08\u957F\u5EA6 ${p.length}\uFF09\uFF1A${p.value}\u3002\u8BF7\u4F20\u5355\u4E2A emoji\uFF08\u5982 "\u{1F3AF}"\uFF09\u3001http(s) \u56FE\u7247 URL\uFF0C\u6216 null \u6E05\u9664\u3002`,
  // length ← [...value].length
  // value ← describeValue(value)
  /** icon 的 emoji 对象缺少 emoji 文本：需要 { "type": "emoji", "emoji": "🎯" }。… */
  normalizeIcon_3: 'icon \u7684 emoji \u5BF9\u8C61\u7F3A\u5C11 emoji \u6587\u672C\uFF1A\u9700\u8981 { "type": "emoji", "emoji": "\u{1F3AF}" }\u3002',
  /** icon 的 external 对象需要一个 http(s) url：' + '{ "type": "external", "e… */
  normalizeIcon_4: 'icon \u7684 external \u5BF9\u8C61\u9700\u8981\u4E00\u4E2A http(s) url\uFF1A{ "type": "external", "external": { "url": "https://\u2026/a.png" } }\u3002',
  /** icon 的对象形式必须带 type：接受 "emoji" / "external" / "custom_emoji" / "f… */
  normalizeIcon_5: (p) => `icon \u7684\u5BF9\u8C61\u5F62\u5F0F\u5FC5\u987B\u5E26 type\uFF1A\u63A5\u53D7 "emoji" / "external" / "custom_emoji" / "file"\uFF0C\u6216\u76F4\u63A5\u4F20 emoji \u5B57\u7B26\u4E32\u3001\u56FE\u7247 URL\u3001null\u3002\u6536\u5230 ${p.raw}\u3002`,
  // raw ← describeValue(raw)
  /** icon 必须是 emoji 字符串、http(s) 图片 URL、已构好的 Notion icon 对象，或 null（清除）… */
  normalizeIcon_6: (p) => `icon \u5FC5\u987B\u662F emoji \u5B57\u7B26\u4E32\u3001http(s) \u56FE\u7247 URL\u3001\u5DF2\u6784\u597D\u7684 Notion icon \u5BF9\u8C61\uFF0C\u6216 null\uFF08\u6E05\u9664\uFF09\uFF1B\u6536\u5230 ${p.raw}\u3002`,
  // raw ← describeValue(raw)
  /* ---------- normalizeBody ---------- */
  /** body_content 必须是 Markdown 字符串，不能是 null。" */
  normalizeBody_1: "body_content \u5FC5\u987B\u662F Markdown \u5B57\u7B26\u4E32\uFF0C\u4E0D\u80FD\u662F null\u3002",
  /** body_content 必须是 Markdown 字符串（页面正文），收到 …。 */
  normalizeBody_2: (p) => `body_content \u5FC5\u987B\u662F Markdown \u5B57\u7B26\u4E32\uFF08\u9875\u9762\u6B63\u6587\uFF09\uFF0C\u6536\u5230 ${p.raw}\u3002`,
  // raw ← describeValue(raw)
  /* ---------- normalizeProps ---------- */
  /** props 必须是对象 map（{属性名: 值}），不是数组。例如 {\"Status\":\"进行中\",\"标签\":[\"… */
  normalizeProps_1: 'props \u5FC5\u987B\u662F\u5BF9\u8C61 map\uFF08{\u5C5E\u6027\u540D: \u503C}\uFF09\uFF0C\u4E0D\u662F\u6570\u7EC4\u3002\u4F8B\u5982 {"Status":"\u8FDB\u884C\u4E2D","\u6807\u7B7E":["a","b"]}\u3002',
  /** props 必须是对象 map（{属性名: 值}），收到 …。 */
  normalizeProps_2: (p) => `props \u5FC5\u987B\u662F\u5BF9\u8C61 map\uFF08{\u5C5E\u6027\u540D: \u503C}\uFF09\uFF0C\u6536\u5230 ${p.raw}\u3002`,
  // raw ← describeValue(raw)
  /* ---------- normalizeTitle ---------- */
  /** title 必须是字符串。" */
  normalizeTitle_1: "title \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u3002",
  /* ---------- parseParentSpec ---------- */
  /** … 需要 parent：…。 */
  parseParentSpec_1: (p) => `${p.create} \u9700\u8981 parent\uFF1A${p.usage}\u3002`,
  // create ← op === "move" ? "移动页面（parent）" : "create"
  // usage ← usage
  /** parent 格式无效：…。用法：…。 + "接受 Notion id（32 位 hex / UUID）或该对象的 Notion… */
  parseParentSpec_2: (p) => `parent \u683C\u5F0F\u65E0\u6548\uFF1A${p.raw}\u3002\u7528\u6CD5\uFF1A${p.usage}\u3002\u63A5\u53D7 Notion id\uFF0832 \u4F4D hex / UUID\uFF09\u6216\u8BE5\u5BF9\u8C61\u7684 Notion URL\u3002`,
  // raw ← describeValue(raw)
  // usage ← usage
  /** parent 里的 id 无效：…。接受 Notion id（32 位 hex / UUID）或 URL， + "例如 data… */
  parseParentSpec_3: (p) => `parent \u91CC\u7684 id \u65E0\u6548\uFF1A${p.match}\u3002\u63A5\u53D7 Notion id\uFF0832 \u4F4D hex / UUID\uFF09\u6216 URL\uFF0C\u4F8B\u5982 data-source:716f546f-1824-45f0-b73a-481bf8b5f5db\u3002`,
  // match ← describeValue(match[2])
  /* ---------- requireId ---------- */
  /** … 需要 id：页面 id（32 位 hex 或带连字符的 UUID）或该页面的 Notion URL。 */
  requireId_1: (p) => `${p.op} \u9700\u8981 id\uFF1A\u9875\u9762 id\uFF0832 \u4F4D hex \u6216\u5E26\u8FDE\u5B57\u7B26\u7684 UUID\uFF09\u6216\u8BE5\u9875\u9762\u7684 Notion URL\u3002`,
  // op ← op
  /** id 无效：…。只接受 Notion 页面 id（32 位 hex / UUID）或该页面的 Notion URL。 */
  requireId_2: (p) => `id \u65E0\u6548\uFF1A${p.raw}\u3002\u53EA\u63A5\u53D7 Notion \u9875\u9762 id\uFF0832 \u4F4D hex / UUID\uFF09\u6216\u8BE5\u9875\u9762\u7684 Notion URL\u3002`,
  // raw ← describeValue(raw)
  /* ---------- ntnFailure ---------- */
  /** …； : ""}… 失败…… : ""} + (hint ? \n… : "") */
  ntnFailure_1: (p) => `${p.note}${p.label} \u5931\u8D25${p.status}${p.detail}` + (p.hint ? `
${p.hint}` : ""),
  // note ← note ? `${note}；` : ""
  // label ← label
  // status ← status
  // detail ← detail ? `：${truncate(detail)}` : ""
  // hint ← hint
  /* ---------- fetchDataSourceSchema ---------- */
  /** 无法从 … 读取属性列表：请确认 id 正确、Integration 已被邀请到该数据库，并且 parent 类型匹配（新版数据… */
  fetchDataSourceSchema_1: (p) => `\u65E0\u6CD5\u4ECE ${p.path} \u8BFB\u53D6\u5C5E\u6027\u5217\u8868\uFF1A\u8BF7\u786E\u8BA4 id \u6B63\u786E\u3001Integration \u5DF2\u88AB\u9080\u8BF7\u5230\u8BE5\u6570\u636E\u5E93\uFF0C\u5E76\u4E14 parent \u7C7B\u578B\u5339\u914D\uFF08\u65B0\u7248\u6570\u636E\u5E93\u7528 data-source:<id>\uFF09\u3002`,
  // path ← path
  /* ---------- resolveDatabaseDataSource ---------- */
  /** database … 没有返回任何 data source id。请确认 Integration 已被邀请，并改用 data-s… */
  resolveDatabaseDataSource_1: (p) => `database ${p.databaseId} \u6CA1\u6709\u8FD4\u56DE\u4EFB\u4F55 data source id\u3002\u8BF7\u786E\u8BA4 Integration \u5DF2\u88AB\u9080\u8BF7\uFF0C\u5E76\u6539\u7528 data-source:<id> \u6307\u5B9A\u3002`,
  // databaseId ← databaseId
  /** database … 有 … 个 data source，需要唯一一个才能确定 schema。 + 请改用 parent: da… */
  resolveDatabaseDataSource_2: (p) => `database ${p.databaseId} \u6709 ${p.length} \u4E2A data source\uFF0C\u9700\u8981\u552F\u4E00\u4E00\u4E2A\u624D\u80FD\u786E\u5B9A schema\u3002\u8BF7\u6539\u7528 parent: data-source:<id>\uFF0C\u53EF\u9009\uFF1A
${p.n}`,
  // databaseId ← databaseId
  // length ← refs.length
  // n ← lines.join("\n")
  /* ---------- assertNoRowCycle ---------- */
  /** Parent-item 祖先链超过 … 层，无法确认不会形成环；已停止，未写入。 */
  assertNoRowCycle_1: (p) => `Parent-item \u7956\u5148\u94FE\u8D85\u8FC7 ${p.MAX_ANCESTOR_WALK} \u5C42\uFF0C\u65E0\u6CD5\u786E\u8BA4\u4E0D\u4F1A\u5F62\u6210\u73AF\uFF1B\u5DF2\u505C\u6B62\uFF0C\u672A\u5199\u5165\u3002`,
  // MAX_ANCESTOR_WALK ← MAX_ANCESTOR_WALK
  /** 行 … 不能挂到 … 下：那会形成 Parent-item 环（… 的祖先里有 …）。 */
  assertNoRowCycle_2: (p) => `\u884C ${p.childId} \u4E0D\u80FD\u6302\u5230 ${p.parentId} \u4E0B\uFF1A\u90A3\u4F1A\u5F62\u6210 Parent-item \u73AF\uFF08${p.parentId2} \u7684\u7956\u5148\u91CC\u6709 ${p.childId2}\uFF09\u3002`,
  // childId ← childId
  // parentId ← parentId
  // parentId2 ← parentId
  // childId2 ← childId
  /** 无法读取祖先行 …，因此无法确认把 … 挂到 … 下不会形成环；已在写入前停止。 */
  assertNoRowCycle_3: (p) => `\u65E0\u6CD5\u8BFB\u53D6\u7956\u5148\u884C ${p.current}\uFF0C\u56E0\u6B64\u65E0\u6CD5\u786E\u8BA4\u628A ${p.childId} \u6302\u5230 ${p.parentId} \u4E0B\u4E0D\u4F1A\u5F62\u6210\u73AF\uFF1B\u5DF2\u5728\u5199\u5165\u524D\u505C\u6B62\u3002`,
  // current ← current
  // childId ← childId
  // parentId ← parentId
  /** 无法确认祖先行 … 所属的 data source，因此无法确认把 … 挂到 … 下不会形成环；已在写入前停止。 */
  assertNoRowCycle_4: (p) => `\u65E0\u6CD5\u786E\u8BA4\u7956\u5148\u884C ${p.current} \u6240\u5C5E\u7684 data source\uFF0C\u56E0\u6B64\u65E0\u6CD5\u786E\u8BA4\u628A ${p.childId} \u6302\u5230 ${p.parentId} \u4E0B\u4E0D\u4F1A\u5F62\u6210\u73AF\uFF1B\u5DF2\u5728\u5199\u5165\u524D\u505C\u6B62\u3002`,
  // current ← current
  // childId ← childId
  // parentId ← parentId
  /* ---------- classifyBareParent ---------- */
  /** 无法把 … 当作 parent：读取它作为页面失败…） : ""}。 + … 的裸 id 必须是页面或数据库行；如果它是 dat… */
  classifyBareParent_1: (p) => `\u65E0\u6CD5\u628A ${p.id} \u5F53\u4F5C parent\uFF1A\u8BFB\u53D6\u5B83\u4F5C\u4E3A\u9875\u9762\u5931\u8D25${p.detail}\u3002${p.create} \u7684\u88F8 id \u5FC5\u987B\u662F\u9875\u9762\u6216\u6570\u636E\u5E93\u884C\uFF1B\u5982\u679C\u5B83\u662F database \u6216 data source\uFF0C\u8BF7\u5199\u6210 database:<id> / data-source:<id>\u3002`,
  // id ← id
  // detail ← detail ? `（${truncate(detail, 300)}）` : ""
  // create ← op === "create" ? "create" : "移动页面"
  /** 无法把 … 当作 parent：GET v1/pages 没有返回 parent。 + … 的裸 id 必须是页面或数据库行；如… */
  classifyBareParent_2: (p) => `\u65E0\u6CD5\u628A ${p.id} \u5F53\u4F5C parent\uFF1AGET v1/pages \u6CA1\u6709\u8FD4\u56DE parent\u3002${p.create} \u7684\u88F8 id \u5FC5\u987B\u662F\u9875\u9762\u6216\u6570\u636E\u5E93\u884C\uFF1B\u5982\u679C\u5B83\u662F database \u6216 data source\uFF0C\u8BF7\u5199\u6210 database:<id> / data-source:<id>\u3002`,
  // id ← id
  // create ← op === "create" ? "create" : "移动页面"
  /* ---------- requireString ---------- */
  /** 属性 "…" (…) 需要字符串，收到 …。 */
  requireString_1: (p) => `\u5C5E\u6027 "${p.name}" (${p.type}) \u9700\u8981\u5B57\u7B26\u4E32\uFF0C\u6536\u5230 ${p.value}\u3002`,
  // name ← prop.name
  // type ← prop.type
  // value ← describeValue(value)
  /* ---------- stringList ---------- */
  /** 属性 "…" (…) 需要 string[]，收到 …。 */
  stringList_1: (p) => `\u5C5E\u6027 "${p.name}" (${p.type}) \u9700\u8981 string[]\uFF0C\u6536\u5230 ${p.value}\u3002`,
  // name ← prop.name
  // type ← prop.type
  // value ← describeValue(value)
  /* ---------- buildPropertyValue ---------- */
  /** 属性 "…" 是标题，不能设为 null。 */
  buildPropertyValue_1: (p) => `\u5C5E\u6027 "${p.name}" \u662F\u6807\u9898\uFF0C\u4E0D\u80FD\u8BBE\u4E3A null\u3002`,
  // name ← prop.name
  /** 属性 "…" (…) 不支持用 null 清空。 */
  buildPropertyValue_2: (p) => `\u5C5E\u6027 "${p.name}" (${p.type}) \u4E0D\u652F\u6301\u7528 null \u6E05\u7A7A\u3002`,
  // name ← prop.name
  // type ← prop.type
  /** 标题属性 "…" 不能为空。 */
  buildPropertyValue_3: (p) => `\u6807\u9898\u5C5E\u6027 "${p.name}" \u4E0D\u80FD\u4E3A\u7A7A\u3002`,
  // name ← prop.name
  /** 属性 "…" (rich_text) 需要字符串，收到 …。 */
  buildPropertyValue_4: (p) => `\u5C5E\u6027 "${p.name}" (rich_text) \u9700\u8981\u5B57\u7B26\u4E32\uFF0C\u6536\u5230 ${p.value}\u3002`,
  // name ← prop.name
  // value ← describeValue(value)
  /** 属性 "…" (number) 需要数字，收到 …。 */
  buildPropertyValue_5: (p) => `\u5C5E\u6027 "${p.name}" (number) \u9700\u8981\u6570\u5B57\uFF0C\u6536\u5230 ${p.value}\u3002`,
  // name ← prop.name
  // value ← describeValue(value)
  /** 属性 "…" (…) 需要选项名字符串，收到 …。 */
  buildPropertyValue_6: (p) => `\u5C5E\u6027 "${p.name}" (${p.type}) \u9700\u8981\u9009\u9879\u540D\u5B57\u7B26\u4E32\uFF0C\u6536\u5230 ${p.value}\u3002`,
  // name ← prop.name
  // type ← prop.type
  // value ← describeValue(value)
  /** 属性 "…" (date) 需要日期字符串或 {start,end}，收到 …。 */
  buildPropertyValue_7: (p) => `\u5C5E\u6027 "${p.name}" (date) \u9700\u8981\u65E5\u671F\u5B57\u7B26\u4E32\u6216 {start,end}\uFF0C\u6536\u5230 ${p.value}\u3002`,
  // name ← prop.name
  // value ← describeValue(value)
  /** 属性 "…" (checkbox) 需要 true/false，收到 …。 */
  buildPropertyValue_8: (p) => `\u5C5E\u6027 "${p.name}" (checkbox) \u9700\u8981 true/false\uFF0C\u6536\u5230 ${p.value}\u3002`,
  // name ← prop.name
  // value ← describeValue(value)
  /** 属性 "…" 的类型 … 暂不支持通过简化值写入；可改用 props 里直接给 Notion 原生 payload，例如 {"…… */
  buildPropertyValue_9: (p) => `\u5C5E\u6027 "${p.name}" \u7684\u7C7B\u578B ${p.type} \u6682\u4E0D\u652F\u6301\u901A\u8FC7\u7B80\u5316\u503C\u5199\u5165\uFF1B\u53EF\u6539\u7528 props \u91CC\u76F4\u63A5\u7ED9 Notion \u539F\u751F payload\uFF0C\u4F8B\u5982 {"${p.name2}": {"${p.type2}": ...}}\u3002`,
  // name ← prop.name
  // type ← prop.type
  // name2 ← prop.name
  // type2 ← prop.type
  /* ---------- resolveProperty ---------- */
  /** 未知属性 "…"。可用可写属性：…。 */
  resolveProperty_1: (p) => `\u672A\u77E5\u5C5E\u6027 "${p.name}"\u3002\u53EF\u7528\u53EF\u5199\u5C5E\u6027\uFF1A${p.hints}\u3002`,
  // name ← name
  // hints ← formatHints(hints)
  /** 属性 "…" 的类型是 …（只读），不能写入。可写属性：…。 */
  resolveProperty_2: (p) => `\u5C5E\u6027 "${p.name}" \u7684\u7C7B\u578B\u662F ${p.type}\uFF08\u53EA\u8BFB\uFF09\uFF0C\u4E0D\u80FD\u5199\u5165\u3002\u53EF\u5199\u5C5E\u6027\uFF1A${p.hints}\u3002`,
  // name ← name
  // type ← prop.type
  // hints ← formatHints(hints)
  /* ---------- readContentEdit ---------- */
  /** … 必须是 { old_str, new_str, replace_all_matches? }，收到 …。 */
  readContentEdit_1: (p) => `${p.path} \u5FC5\u987B\u662F { old_str, new_str, replace_all_matches? }\uFF0C\u6536\u5230 ${p.raw}\u3002`,
  // path ← path
  // raw ← describeValue(raw)
  /** … 只接受 old_str / new_str / replace_all_matches，多余字段：…。 */
  readContentEdit_2: (p) => `${p.path} \u53EA\u63A5\u53D7 old_str / new_str / replace_all_matches\uFF0C\u591A\u4F59\u5B57\u6BB5\uFF1A${p.join}\u3002`,
  // path ← path
  // join ← unexpected.join(", ")
  /** ….old_str 必须是字符串（要查找的原文），收到 …。 */
  readContentEdit_3: (p) => `${p.path}.old_str \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF08\u8981\u67E5\u627E\u7684\u539F\u6587\uFF09\uFF0C\u6536\u5230 ${p.old_str}\u3002`,
  // path ← path
  // old_str ← describeValue(raw.old_str)
  /** ….old_str 不能是空字符串：Notion 会拒绝空 old_str。要追加内容请用 body_content 且不传 e… */
  readContentEdit_4: (p) => `${p.path}.old_str \u4E0D\u80FD\u662F\u7A7A\u5B57\u7B26\u4E32\uFF1ANotion \u4F1A\u62D2\u7EDD\u7A7A old_str\u3002\u8981\u8FFD\u52A0\u5185\u5BB9\u8BF7\u7528 body_content \u4E14\u4E0D\u4F20 edits\u3002`,
  // path ← path
  /** ….new_str 是必填的：替换成什么就写什么，想删除这段文字请传 ""（空字符串）。 */
  readContentEdit_5: (p) => `${p.path}.new_str \u662F\u5FC5\u586B\u7684\uFF1A\u66FF\u6362\u6210\u4EC0\u4E48\u5C31\u5199\u4EC0\u4E48\uFF0C\u60F3\u5220\u9664\u8FD9\u6BB5\u6587\u5B57\u8BF7\u4F20 ""\uFF08\u7A7A\u5B57\u7B26\u4E32\uFF09\u3002`,
  // path ← path
  /** ….new_str 必须是字符串，收到 …。 */
  readContentEdit_6: (p) => `${p.path}.new_str \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\uFF0C\u6536\u5230 ${p.new_str}\u3002`,
  // path ← path
  // new_str ← describeValue(raw.new_str)
  /* ---------- readContentEdits ---------- */
  /** edits 必须是数组：[{ old_str, new_str, replace_all_matches? }, ...]，收到… */
  readContentEdits_1: (p) => `edits \u5FC5\u987B\u662F\u6570\u7EC4\uFF1A[{ old_str, new_str, replace_all_matches? }, ...]\uFF0C\u6536\u5230 ${p.raw}\u3002\u8981\u8FFD\u52A0\u5185\u5BB9\u8BF7\u6539\u7528 body_content\uFF08\u4E0D\u4F20 edits\uFF09\u3002`,
  // raw ← describeValue(raw)
  /** edits 最多 … 条（Notion 限制），收到 … 条。请拆成多次 notion_page_edit 调用。 */
  readContentEdits_2: (p) => `edits \u6700\u591A ${p.MAX_CONTENT_UPDATES} \u6761\uFF08Notion \u9650\u5236\uFF09\uFF0C\u6536\u5230 ${p.length} \u6761\u3002\u8BF7\u62C6\u6210\u591A\u6B21 notion_page_edit \u8C03\u7528\u3002`,
  // MAX_CONTENT_UPDATES ← MAX_CONTENT_UPDATES
  // length ← raw.length
  /* ---------- withEditAlias ---------- */
  /** edits 和 props.block_update 是同一个东西（查找替换列表），不要同时传；请统一用 edits。本次没有写… */
  withEditAlias_1: "edits \u548C props.block_update \u662F\u540C\u4E00\u4E2A\u4E1C\u897F\uFF08\u67E5\u627E\u66FF\u6362\u5217\u8868\uFF09\uFF0C\u4E0D\u8981\u540C\u65F6\u4F20\uFF1B\u8BF7\u7EDF\u4E00\u7528 edits\u3002\u672C\u6B21\u6CA1\u6709\u5199\u5165\u4EFB\u4F55\u5185\u5BB9\u3002",
  /* ---------- markdownFailure ---------- */
  /** 这次编辑会删除页面 … 里的子页面或子数据库，Notion 因此拒绝执行（本次没有写入任何内容）。 + "old_str 匹配的… */
  markdownFailure_1: (p) => `\u8FD9\u6B21\u7F16\u8F91\u4F1A\u5220\u9664\u9875\u9762 ${p.pageId} \u91CC\u7684\u5B50\u9875\u9762\u6216\u5B50\u6570\u636E\u5E93\uFF0CNotion \u56E0\u6B64\u62D2\u7EDD\u6267\u884C\uFF08\u672C\u6B21\u6CA1\u6709\u5199\u5165\u4EFB\u4F55\u5185\u5BB9\uFF09\u3002old_str \u5339\u914D\u7684\u662F\u6574\u6BB5\u6587\u672C\uFF0C\u5F88\u5BB9\u6613\u8FDE\u5E26\u8986\u76D6 \`<page url="...">\u2026</page>\` \u6216 \`<database ...>\` \u8FD9\u7C7B\u5757\u3002\u8BF7\u628A old_str \u7F29\u5C0F\u5230\u90A3\u6BB5\u6587\u5B57\u672C\u8EAB\uFF08\u4E0D\u8981\u5305\u542B\u5B50\u9875\u9762/\u5B50\u6570\u636E\u5E93\u5757\uFF09\uFF0C\u6216\u5148\u5728 Notion \u91CC\u628A\u5B50\u9875\u9762\u79FB\u8D70\u518D\u6539\u3002ntn \u8F93\u51FA\uFF1A${p.detail}`,
  // pageId ← pageId
  // detail ← truncate(detail, 600)
  /* ---------- buildPropertyWrite ---------- */
  /** context.pageId ? 无法确定页面 … 的标题属性，不能用 title 改标题；请改用 props 并指定标题属性名… */
  buildPropertyWrite_1: (p) => p.pageId ? `\u65E0\u6CD5\u786E\u5B9A\u9875\u9762 ${p.pageId} \u7684\u6807\u9898\u5C5E\u6027\uFF0C\u4E0D\u80FD\u7528 title \u6539\u6807\u9898\uFF1B\u8BF7\u6539\u7528 props \u5E76\u6307\u5B9A\u6807\u9898\u5C5E\u6027\u540D\u3002` : `\u65E0\u6CD5\u786E\u5B9A ${p.source} \u7684\u6807\u9898\u5C5E\u6027\uFF0C\u4E0D\u80FD\u7528 title \u6307\u5B9A\u6807\u9898\uFF1B\u8BF7\u6539\u7528 props \u5E76\u6307\u5B9A\u6807\u9898\u5C5E\u6027\u540D\u3002`,
  // pageId ← context.pageId            （有页面 id 时说的是「页面 …」，否则说容器类型）
  // source ← context.source
  /* ---------- parentItemError ---------- */
  /** data source … 没有可用的 Parent-item / 自关联 relation 列，无法把行挂到父行下（…）。 +… */
  parentItemError_1: (p) => `data source ${p.dataSourceId} \u6CA1\u6709\u53EF\u7528\u7684 Parent-item / \u81EA\u5173\u8054 relation \u5217\uFF0C\u65E0\u6CD5\u628A\u884C\u6302\u5230\u7236\u884C\u4E0B\uFF08${p.detail}\uFF09\u3002\u8BF7\u5728 Notion \u91CC\u4E3A\u8FD9\u4E2A\u5E93\u52A0\u4E00\u4E2A\u6307\u5411\u81EA\u8EAB\u7684 relation \u5C5E\u6027\uFF08\u9ED8\u8BA4\u540D Parent-item\uFF09\uFF0C\u6216\u7528 notion_get \u67E5\u770B\u73B0\u6709\u5217\u540E\u91CD\u8BD5\u3002`,
  // dataSourceId ← dataSourceId
  // detail ← detail
  /* ---------- rollbackCreatedPage ---------- */
  /** …… */
  rollbackCreatedPage_1: (p) => `${p.detail}${p.rollbackLine}`,
  // detail ← cause.detail
  // rollbackLine ← rollbackLine
  /** 回滚成功：新页面 … 已移入回收站（partial: false），没有留下半成品。 */
  rollbackCreatedPage_2: (p) => `
\u5DF2\u56DE\u6EDA\uFF1A\u65B0\u9875\u9762 ${p.pageId} \u5DF2\u79FB\u5165\u56DE\u6536\u7AD9\uFF08partial: false\uFF09\uFF0C\u6CA1\u6709\u7559\u4E0B\u534A\u6210\u54C1\u3002`,
  // pageId ← pageId
  /** 回滚失败：… 该页面/行仍然存在（partial: true）。请手动清理：notion_page_trash { id: "…" }。 */
  rollbackCreatedPage_3: (p) => `
\u56DE\u6EDA\u5931\u8D25\uFF1Antn pages trash ${p.pageId} \u4E5F\u5931\u8D25\u4E86${p.detail ? `\uFF08${p.detail}\uFF09` : ""}\uFF0C\u8BE5\u9875\u9762/\u884C\u4ECD\u7136\u5B58\u5728\uFF08partial: true\uFF09\u3002\u8BF7\u624B\u52A8\u6E05\u7406\uFF1Anotion_page_trash { id: "${p.pageId}" }\u3002`,
  // pageId ← pageId
  // detail ← truncate(detail, 300)
  /* ---------- createPage ---------- */
  /** 在 … 所在 data source : container.kind} 中创建页面需要标题： + 请传 title、在 pro… */
  createPage_1: (p) => `\u5728 ${p.kind} \u4E2D\u521B\u5EFA\u9875\u9762\u9700\u8981\u6807\u9898\uFF1A\u8BF7\u4F20 title\u3001\u5728 props \u91CC\u5199\u6807\u9898\u5C5E\u6027\uFF08${p.title}\uFF09\uFF0C\u6216\u8BA9 body_content \u4EE5 "# \u6807\u9898" \u5F00\u5934\u3002\u53EF\u5199\u5C5E\u6027\uFF1A${p.hints}\u3002`,
  // kind ← container.kind === "row" ? `行 ${container.rowParentId} 所在 data source` : contain
  // title ← titlePropertyName(container.schema) ?? "title"
  // hints ← formatHints(hints)
  /** create 需要 body_content 或 title：ntn pages create 不接受空 Markdown，只有… */
  createPage_2: "create \u9700\u8981 body_content \u6216 title\uFF1Antn pages create \u4E0D\u63A5\u53D7\u7A7A Markdown\uFF0C\u53EA\u6709 parent \u65E0\u6CD5\u521B\u5EFA\u7A7A\u767D\u9875\u9762\u3002",
  /** 页面已创建（parent …），但没有从 ntn 的结构化输出里取到页面 id， + …未写入。 + 没有可信 id 就不自动 … */
  createPage_3: (p) => `\u9875\u9762\u5DF2\u521B\u5EFA\uFF08parent ${p.workspace}\uFF09\uFF0C\u4F46\u6CA1\u6709\u4ECE ntn \u7684\u7ED3\u6784\u5316\u8F93\u51FA\u91CC\u53D6\u5230\u9875\u9762 id\uFF0C${p.what}\u672A\u5199\u5165\u3002\u6CA1\u6709\u53EF\u4FE1 id \u5C31\u4E0D\u81EA\u52A8 trash\uFF08\u907F\u514D\u8BEF\u5220\uFF09\uFF0C\u8BF7\u7528 notion_search/notion_get \u627E\u5230\u8BE5\u9875\u9762\u540E\uFF0C\u7528 notion_page_edit \u5199\u5165\uFF0C\u6216 notion_page_trash \u5220\u9664\uFF08partial: true\uFF0Crollback: unknown_id\uFF09\u3002`,
  // workspace ← parentLabel ?? "workspace"
  // what ← what
  /* ---------- editWithFailures ---------- */
  /** 部分成功。已经生效的部分：…（已写入，不会回滚）。\n + 失败的部分：\n…\n + 这些步骤互不依赖，所以其余步骤照常执行了… */
  editWithFailures_1: (p) => `\u90E8\u5206\u6210\u529F\u3002\u5DF2\u7ECF\u751F\u6548\u7684\u90E8\u5206\uFF1A${p.join}\uFF08\u5DF2\u5199\u5165\uFF0C\u4E0D\u4F1A\u56DE\u6EDA\uFF09\u3002
\u5931\u8D25\u7684\u90E8\u5206\uFF1A
${p.reported}
\u8FD9\u4E9B\u6B65\u9AA4\u4E92\u4E0D\u4F9D\u8D56\uFF0C\u6240\u4EE5\u5176\u4F59\u6B65\u9AA4\u7167\u5E38\u6267\u884C\u4E86\u3002\u91CD\u8BD5\u65F6\u8BF7\u53EA\u91CD\u53D1\u5931\u8D25\u7684\u90E8\u5206\uFF1B\u91CD\u53D1\u5168\u90E8\u4F1A\u628A\u5DF2\u751F\u6548\u7684\u90E8\u5206\u91CD\u590D\u5E94\u7528\u4E00\u904D\u3002`,
  // join ← applied.join("、")
  // reported ← reported
  /* ---------- movePage ---------- */
  /** edit 的 parent（移动页面）只支持 page:<id> 或（裸）行 id：页面挂到页面下用 POST /v1/page… */
  movePage_1: "edit \u7684 parent\uFF08\u79FB\u52A8\u9875\u9762\uFF09\u53EA\u652F\u6301 page:<id> \u6216\uFF08\u88F8\uFF09\u884C id\uFF1A\u9875\u9762\u6302\u5230\u9875\u9762\u4E0B\u7528 POST /v1/pages/{id}/move\uFF0C\u884C\u6302\u5230\u884C\u4E0B\u7528 Parent-item relation\u3002\u8981\u628A\u9875\u9762\u653E\u8FDB\u67D0\u4E2A data source\uFF0C\u8BF7\u7528 notion_page_create\u3002",
  /** 无法确定页面 … 的当前父级（GET v1/pages 未返回 parent）。移动页面不会在没有确认的情况下执行。 */
  movePage_2: (p) => `\u65E0\u6CD5\u786E\u5B9A\u9875\u9762 ${p.id} \u7684\u5F53\u524D\u7236\u7EA7\uFF08GET v1/pages \u672A\u8FD4\u56DE parent\uFF09\u3002\u79FB\u52A8\u9875\u9762\u4E0D\u4F1A\u5728\u6CA1\u6709\u786E\u8BA4\u7684\u60C5\u51B5\u4E0B\u6267\u884C\u3002`,
  // id ← id
  /** 页面 … 不能挂到自己下面。 */
  movePage_3: (p) => `\u9875\u9762 ${p.id} \u4E0D\u80FD\u6302\u5230\u81EA\u5DF1\u4E0B\u9762\u3002`,
  // id ← id
  /** 页面 … 已经是 … 的子页面，无需移动。 */
  movePage_4: (p) => `\u9875\u9762 ${p.id} \u5DF2\u7ECF\u662F ${p.targetParentId} \u7684\u5B50\u9875\u9762\uFF0C\u65E0\u9700\u79FB\u52A8\u3002`,
  // id ← id
  // targetParentId ← targetParentId
  /** 页面 … 不能挂到页面 … 下：会形成环（…）。 */
  movePage_5: (p) => `\u9875\u9762 ${p.id} \u4E0D\u80FD\u6302\u5230\u9875\u9762 ${p.targetParentId} \u4E0B\uFF1A\u4F1A\u5F62\u6210\u73AF\uFF08${p.join}\uFF09\u3002`,
  // id ← id
  // targetParentId ← targetParentId
  // join ← cycle.cycle.join(" → ")
  /** 无法把页面挂到 data source 容器下；请改用 notion_page_create。" */
  movePage_6: "\u65E0\u6CD5\u628A\u9875\u9762\u6302\u5230 data source \u5BB9\u5668\u4E0B\uFF1B\u8BF7\u6539\u7528 notion_page_create\u3002",
  /** 页面 … 不在数据库里（父级是页面… : ""}）， + 不能用 Parent-item relation 挂到行 … 下；行→… */
  movePage_7: (p) => `\u9875\u9762 ${p.id} \u4E0D\u5728\u6570\u636E\u5E93\u91CC\uFF08\u7236\u7EA7\u662F\u9875\u9762${p.id2}\uFF09\uFF0C\u4E0D\u80FD\u7528 Parent-item relation \u6302\u5230\u884C ${p.rowParentId} \u4E0B\uFF1B\u884C\u2192\u884C\u7684\u79FB\u52A8\u53EA\u9002\u7528\u4E8E\u540C\u4E00\u5E93\u5185\u7684\u884C\u3002`,
  // id ← id
  // id2 ← childParent.id ? ` ${childParent.id}` : ""
  // rowParentId ← container.rowParentId
  /** 行 … 不能挂到自己下面。 */
  movePage_8: (p) => `\u884C ${p.id} \u4E0D\u80FD\u6302\u5230\u81EA\u5DF1\u4E0B\u9762\u3002`,
  // id ← id
  /** 行 … 属于 data source …，父行 … 属于 …； + "自关联 Parent-item 只能在同一 data so… */
  movePage_9: (p) => `\u884C ${p.id} \u5C5E\u4E8E data source ${p.childDataSourceId}\uFF0C\u7236\u884C ${p.rowParentId} \u5C5E\u4E8E ${p.dataSourceId}\uFF1B\u81EA\u5173\u8054 Parent-item \u53EA\u80FD\u5728\u540C\u4E00 data source \u5185\u4F7F\u7528\uFF0C\u8DE8\u5E93\u8BF7\u6539\u7528 page \u7236\u7EA7\u6216 notion_page_create\u3002`,
  // id ← id
  // childDataSourceId ← childDataSourceId
  // rowParentId ← container.rowParentId
  // dataSourceId ← container.dataSourceId
  /** 行 … 的 …（Parent-item）已经指向 …， + 移到 … 下会覆盖这个链接。确认要改父级请传 yes: true；本… */
  movePage_10: (p) => `\u884C ${p.id} \u7684 ${p.name}\uFF08Parent-item\uFF09\u5DF2\u7ECF\u6307\u5411 ${p.join}\uFF0C\u79FB\u5230 ${p.rowParentId} \u4E0B\u4F1A\u8986\u76D6\u8FD9\u4E2A\u94FE\u63A5\u3002\u786E\u8BA4\u8981\u6539\u7236\u7EA7\u8BF7\u4F20 yes: true\uFF1B\u672C\u6B21\u6CA1\u6709\u5199\u5165\u3002`,
  // id ← id
  // name ← relation.name
  // join ← currentParents.join(", ")
  // rowParentId ← container.rowParentId
  /* ---------- listChildPages ---------- */
  /** 页面 … 的子块列表无法解析，不能确认它有多少子页面，因此拒绝删除。 + ntn 输出：… */
  listChildPages_1: (p) => `\u9875\u9762 ${p.pageId} \u7684\u5B50\u5757\u5217\u8868\u65E0\u6CD5\u89E3\u6790\uFF0C\u4E0D\u80FD\u786E\u8BA4\u5B83\u6709\u591A\u5C11\u5B50\u9875\u9762\uFF0C\u56E0\u6B64\u62D2\u7EDD\u5220\u9664\u3002ntn \u8F93\u51FA\uFF1A${p.trim}`,
  // pageId ← pageId
  // trim ← truncate((result.stdout || "").trim(), 200)
  /** 页面 … 的子块报告 has_more=true 却没有 next_cursor，无法读完子页面列表，因此拒绝删除。 */
  listChildPages_2: (p) => `\u9875\u9762 ${p.pageId} \u7684\u5B50\u5757\u62A5\u544A has_more=true \u5374\u6CA1\u6709 next_cursor\uFF0C\u65E0\u6CD5\u8BFB\u5B8C\u5B50\u9875\u9762\u5217\u8868\uFF0C\u56E0\u6B64\u62D2\u7EDD\u5220\u9664\u3002`,
  // pageId ← pageId
  /** 页面 … 的子块超过 … 页仍未列完，无法确认它有多少子页面，因此拒绝删除。 + "请在 Notion 里手动确认并删除。" */
  listChildPages_3: (p) => `\u9875\u9762 ${p.pageId} \u7684\u5B50\u5757\u8D85\u8FC7 ${p.MAX_BLOCK_PAGES} \u9875\u4ECD\u672A\u5217\u5B8C\uFF0C\u65E0\u6CD5\u786E\u8BA4\u5B83\u6709\u591A\u5C11\u5B50\u9875\u9762\uFF0C\u56E0\u6B64\u62D2\u7EDD\u5220\u9664\u3002\u8BF7\u5728 Notion \u91CC\u624B\u52A8\u786E\u8BA4\u5E76\u5220\u9664\u3002`,
  // pageId ← pageId
  // MAX_BLOCK_PAGES ← MAX_BLOCK_PAGES
  /* ---------- trashPage ---------- */
  /** 页面 … 不存在，或没有被当前的 Notion integration 共享（••• → Connections），因此无法删除… */
  trashPage_1: (p) => `\u9875\u9762 ${p.id} \u4E0D\u5B58\u5728\uFF0C\u6216\u6CA1\u6709\u88AB\u5F53\u524D\u7684 Notion integration \u5171\u4EAB\uFF08\u2022\u2022\u2022 \u2192 Connections\uFF09\uFF0C\u56E0\u6B64\u65E0\u6CD5\u5220\u9664\u3002\u8BF7\u5148\u7528 notion_search \u786E\u8BA4 id \u6B63\u786E\u3002`,
  // id ← id
  /** notion_page_trash cannot delete a database (id …). Removing a da… */
  trashPage_2: (p) => `notion_page_trash cannot delete a database (id ${p.id}). Removing a database, its data sources and every row in them is far more destructive than deleting a page, so this tool refuses it outright \u2014 a review cannot authorize it either. Ask the user to delete it in Notion (\u2022\u2022\u2022 \u2192 Delete) if that is really intended.`,
  // id ← id
  /** 页面 … 有 … 个子页面，删除会连带整棵子树，需要复核；doublecheck 服务不可用，因此没有删除。 */
  trashPage_3: (p) => `\u9875\u9762 ${p.id} \u6709 ${p.count} \u4E2A\u5B50\u9875\u9762\uFF0C\u5220\u9664\u4F1A\u8FDE\u5E26\u6574\u68F5\u5B50\u6811\uFF0C\u6240\u4EE5\u5FC5\u987B\u5148\u8FC7 doublecheck \u590D\u6838\uFF1Bdoublecheck \u670D\u52A1\u5F53\u524D\u4E0D\u53EF\u7528\uFF0C\u56E0\u6B64\u6CA1\u6709\u5220\u9664\u4EFB\u4F55\u5185\u5BB9\uFF08\u9875\u9762\u548C\u5B50\u9875\u9762\u90FD\u8FD8\u5728\uFF09\u3002\u8BF7\u8BA9\u7528\u6237\u5728 Notion \u91CC\u5220\u9664\uFF0C\u6216\u5148\u542F\u7528 doublecheck \u63D2\u4EF6\u518D\u91CD\u8BD5\u3002`,
  // id ← id
  // count ← children.length
  /* ---------- createNotionPageEditTool ---------- */
  /** yes 只用于「行→行移动时覆盖已有 Parent-item 链接」，没有 parent 时传 yes 没有意义；请去掉 yes… */
  createNotionPageEditTool_1: "yes \u53EA\u7528\u4E8E\u300C\u884C\u2192\u884C\u79FB\u52A8\u65F6\u8986\u76D6\u5DF2\u6709 Parent-item \u94FE\u63A5\u300D\uFF0C\u6CA1\u6709 parent \u65F6\u4F20 yes \u6CA1\u6709\u610F\u4E49\uFF1B\u8BF7\u53BB\u6389 yes\u3002\u672C\u6B21\u6CA1\u6709\u5199\u5165\u3002",
  /** edits（查找替换）和 body_content（追加到末尾）不能同时传：二选一。" + "需要既改又追加时请分两次调用 no… */
  createNotionPageEditTool_2: "edits\uFF08\u67E5\u627E\u66FF\u6362\uFF09\u548C body_content\uFF08\u8FFD\u52A0\u5230\u672B\u5C3E\uFF09\u4E0D\u80FD\u540C\u65F6\u4F20\uFF1A\u4E8C\u9009\u4E00\u3002\u9700\u8981\u65E2\u6539\u53C8\u8FFD\u52A0\u65F6\u8BF7\u5206\u4E24\u6B21\u8C03\u7528 notion_page_edit\u3002\u672C\u6B21\u6CA1\u6709\u5199\u5165\u3002",
  /** notion_page_edit 需要 edits、body_content、props、title、icon、parent 至… */
  createNotionPageEditTool_3: (p) => "notion_page_edit \u9700\u8981 edits\u3001body_content\u3001props\u3001title\u3001icon\u3001parent \u81F3\u5C11\u4E00\u9879\uFF1B\u7A7A\u8C03\u7528\u4E0D\u4F1A\u4FEE\u6539\u9875\u9762\u3002" + (p.bodyProvided ? "body_content \u662F\u7A7A\u767D\uFF1A\u8FFD\u52A0\u7A7A\u767D\u5185\u5BB9\u4E0D\u4F1A\u4FEE\u6539\u9875\u9762\u3002" : "\u8981\u8FFD\u52A0\u5185\u5BB9\u8BF7\u4F20 body_content\uFF08\u4E0D\u4F20 edits\uFF09\u3002")
  // bodyProvided ← body !== undefined
};
var CHECK_ERRORS = {
  /** doublecheck 返回了无法识别的复核结果；按 fail closed 处理，没有执行删除。 */
  malformed: "doublecheck \u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u590D\u6838\u7ED3\u679C\uFF0C\u56E0\u6B64\u6CA1\u6709\u6267\u884C\u5220\u9664\uFF08fail closed\uFF09\u3002\u8FD9\u662F\u63D2\u4EF6\u7248\u672C\u4E0D\u5339\u914D\u7684\u8FF9\u8C61\uFF1A\u8BF7\u68C0\u67E5 doublecheck \u4E0E dsh-notion \u7684\u7248\u672C\u3002"
};

// src/text/params.ts
var SEARCH_PARAMS = {
  /** `query` */
  query: "Keyword matched against object TITLES only (never body text). See the tool description for how matching works: it is token-OR, and an exact title in double quotes is the precise lookup.",
  /**
   * `limit` — a function because the numbers are behaviour constants that live with the
   * tool (they are also what the code clamps against), and a text module must not import
   * from the tool that imports it.
   */
  limit: (p) => `Max results (default ${p.fallback}). Values above ${p.max} are clamped to ${p.max}.`,
  /** `filter_object` */
  filter_object: "Restrict hits to pages or databases (data sources). Omit to search both."
};
var GET_PARAMS = {
  /** `id_or_url` */
  id_or_url: "Notion page or database ID (dashed UUID or 32-character id) or a notion.so / app.notion.com URL.",
  /** `format` */
  format: "Page output. 'md' (default) returns the Markdown body with properties as frontmatter; 'json' returns the structured page payload (markdown plus url/title/truncation metadata). Databases are always returned as schema, regardless of format."
};
var QUERY_PARAMS = {
  /** `database_or_data_source` */
  database_or_data_source: "Notion data source id, database id, or Notion URL. If the database has multiple data sources, pass one data source id explicitly.",
  /** `limit` — see the note on SEARCH_PARAMS.limit. */
  limit: (p) => `Max rows per page (default ${p.fallback}, clamped to ${p.max}).`,
  /** `start_cursor` */
  start_cursor: "Pagination cursor from a previous response's next_cursor. Omit for the first page.",
  /** `filter` */
  filter: "Raw Notion filter JSON object, passed through verbatim.",
  /** `sort` */
  sort: "Only rows linked to this parent row (id or Notion URL), filtered through the data source's Parent-item / self-relation column. Combined with filter via AND; refuses when filter already targets that same relation column.",
  /** `under` */
  under: 'Sort spec "Property asc|desc", or an ordered array of specs for multiple sorts.',
  /** `include_content` */
  include_content: "Also fetch each row's Markdown with ntn pages get (default false; one extra call per row)."
};
var PROPS_DESCRIPTION = `Object map of database column NAME \u2192 simplified value (e.g. {"Status":"\u8FDB\u884C\u4E2D","\u6807\u7B7E":["a","b"],"\u622A\u6B62\u65E5\u671F":"2025-01-31","Done":true}); {} = no property write. The value is converted by the column TYPE from the parent data source's schema: title/rich_text string; number number|numeric string; select/status string or {name} (""/null clears); multi_select string[]; date "YYYY-MM-DD" | ISO string | {start,end?,time_zone?}; checkbox boolean; url/email/phone string (""/null clears); people/relation string[] of ids. null clears a property where Notion allows it, and an object carrying its own type key (e.g. {"select":{"name":"Done"}}) is sent as-is. Unknown names and read-only columns (formula/rollup/created_time/\u2026) are rejected with hint_properties. COLUMNS ONLY: the page icon is the top-level icon parameter and the page body is the top-level body_content parameter, not props keys. No default property values are invented.`;
var ICON_TEXT = {
  /** 分支 `string` */
  string: 'An emoji ("\u{1F3AF}") or an http(s) image URL.',
  /** 分支 `object` */
  object: 'An already-typed Notion icon object, e.g. {"type":"emoji","emoji":"\u{1F3AF}"} or {"type":"external","external":{"url":"https://\u2026/a.png"}}.',
  /** 分支 `null` */
  null: "null clears the icon."
};
var EDIT_ITEM_TEXT = {
  /** `old_str` */
  old_str: "Required, non-empty. The existing text to find. Substring matching: one word, one sentence or several blocks all work \u2014 you do not have to resend the whole paragraph. COPY WHAT notion_get SHOWED YOU, MARKERS AND ALL \u2014 that always matches, at any length. A marker-free plain fragment also works, but only if it sits inside ONE formatting run: on `Alpha **bold** omega`, `bold` and `Alpha ` match, `Alpha bold` does not (it crosses the bold boundary). So the one way to fail is a plain fragment spanning a formatting change \u2014 when unsure, copy the markers. Adjacent blocks join with \\n, which merges them on replace. A `$` may be bare or escaped.",
  /** `new_str` */
  new_str: 'Required. The replacement text. "" DELETES old_str. It is markdown, so **bold**, `code`, [link](url), ## headings and - list items all render as that formatting; a new_str containing \\n\\n creates separate blocks and a single \\n is a line break inside one block. A `$` may be written bare or escaped \u2014 this tool removes the escape before sending, so pasting the \\\\$ that notion_get renders is safe.',
  /** `replace_all_matches` */
  replace_all_matches: "Default false: if old_str matches more than one place the whole call fails and NOTHING is written. Set true to replace every occurrence. This is detected by Notion, not locally, so the tool cannot say which of your edits was ambiguous in advance \u2014 narrow the old_str or set this flag."
};
var CREATE_PARAMS = {
  /** `parent` */
  parent: "Where the page goes. OMIT it to create the page at the WORKSPACE ROOT (Notion's default when no parent is given; such a page only has a title, so props cannot carry columns). Otherwise: page:<id> (child page), database:<id> | data-source:<id> (a row in that database), or a bare page/row id (a bare ROW id means a child row, linked through that data source's Parent-item / self-relation column). A Notion URL is accepted anywhere an id is: the id is extracted from it.",
  /** `title` */
  title: 'Page title. A row in a database needs one (here, or as the title property in props, or as a leading "# Heading" in body_content).',
  /** `icon` */
  icon: "The page icon.",
  /** `body_content` */
  body_content: 'The page body as Markdown. A leading "# Heading" becomes the title when title is absent.'
};
var EDIT_PARAMS = {
  /** `id` */
  id: "Required. The page id (32 hex or dashed UUID) or its Notion URL.",
  /** `edits` */
  edits: "Find-and-replace operations, applied in order (edit[i+1] sees edit[i]'s result). Max 100. replace_all_matches belongs on the INDIVIDUAL edit object, not on the call. Notion does the matching, so a call can end three ways: all match -> success; SOME match -> success, with the misses in `warnings` (nothing is rolled back, so do not assume the page now equals what you sent); NONE match -> the call fails and nothing is written, which means the old_str were stale: re-read with notion_get instead of retrying the same string. An old_str matching MORE THAN ONE place is a separate hard error: nothing is written unless that edit sets replace_all_matches:true. Omit `edits` and pass body_content to APPEND instead.",
  /** `body_content` */
  body_content: "Markdown to APPEND at the end of the page. Only used when `edits` is empty or absent \u2014 this is the ONLY way to add new content, and edit never replaces the whole page. Passing body_content TOGETHER with a non-empty edits is an INVALID_INPUT error (nothing is written): append and find-replace cannot be combined in one call.",
  /** `title` */
  title: "New page title (writes the title property).",
  /** `icon` */
  icon: "New page icon; null clears it.",
  /** `parent` */
  parent: "Move the page: page:<id> (under that page), or a bare PAGE id, or a bare ROW id (re-link the Parent-item relation of that row). A Notion URL is accepted anywhere an id is. Database/data source parents are not accepted \u2014 use notion_page_create to add a row.",
  /** `yes` */
  yes: "Only for a row\u2192row move: consent to REPLACE the row's existing Parent-item link, which otherwise refuses with the current parent ids. Ignored nowhere else \u2014 passing it without parent is an error."
};
var TRASH_PARAMS = {
  /** `id` */
  id: "Required. The page id (32 hex or dashed UUID) or its Notion URL. There is no yes/recursive parameter: a page with no child pages is deleted by this one call, and a page with child pages returns a pending that you answer with double_check."
};
var ICON_PARAMETER_TEXT_CREATE = "The page icon.";
var ICON_PARAMETER_TEXT_EDIT = "New page icon; null clears it.";

// src/text/tools.ts
var TOOL_DESCRIPTIONS = {
  /** `notion_search` */
  search: 'Search Notion by TITLE; returns id, title, URL and object type (page|database). MATCHING IS TOKEN-OR, NOT SUBSTRING: the query is split into words and any title containing ANY ONE of them comes back, ranked \u2014 so a long query yields loosely-related hits, not just the one you meant. Wrap a known EXACT title in double quotes ("PRD \xB7 notion_page") to get exactly that hit. TITLES only: body text is never searched, and a 0-hit result does NOT prove absence (a fresh page may not be indexed for a second or two; retry once). A hit is not proof it is the right object: verify with notion_get. Use filter_object or limit to narrow; prefer refining the query over raising limit.',
  /** `notion_get` */
  get: "Read one Notion page or inspect one database. A page returns Markdown (format='md', default) with its properties as frontmatter, or a structured payload (format='json') that also carries url, title, truncated and unknown_block_ids. A database returns every data source id plus each property's name, type, writable flag and Parent-item / self-relation candidates; rows are never fetched here, so read them with notion_query. If a page comes back truncated (rare), format='json' shows unknown_block_ids; the truncated Markdown lists the next steps.",
  /** `notion_query` */
  query: `Query the rows of a known Notion data source (or database) with a Notion filter, sort specs and cursor pagination; returns rows, next_cursor and has_more. This is not keyword search: find the data source with notion_search first when you only know a title, and read its schema with notion_get. Pass filter as a raw Notion filter JSON object and sort as "Property asc|desc" or an array of those. Use under to list only the child rows of one parent row; it filters the data source's Parent-item column and is ANDed with filter, so do not also filter that column in filter. When has_more is true, call again with next_cursor as start_cursor instead of raising limit, which is capped at 100. include_content defaults to false and costs one extra ntn pages get call per row.`,
  /** `notion_page_create` */
  pageCreate: 'Create one Notion page or database row. This tool never modifies an existing page \u2014 use notion_page_edit for that. `parent` is OPTIONAL: omit it to create the page at the WORKSPACE ROOT (Notion\'s own default; such a page has only a title, so props cannot carry columns). A page created inside a database needs a title: the `title` parameter, the title property in props, or a leading "# Heading" in body_content. Creating takes a SECOND request for the columns and icon. If that request fails the new page is trashed so no half-made page is left behind, and the error reports whether the cleanup worked (`rollback`) \u2014 partial:true means something was left behind. A successful result reports the title, the body it wrote, the columns and the icon separately.',
  /** `notion_page_edit` */
  pageEdit: 'Change an existing Notion page: find-and-replace its text, append Markdown, update title/columns/icon, and/or move it. A single call may combine all of these. THE STEPS ARE INDEPENDENT: they run in this order \u2014 (1) body content, (2) title/props/icon, (3) parent move \u2014 and a failure in one does NOT cancel the others. A failed old_str is a bad argument, not a broken page, so a valid title change or move still happens. The result then reports \u90E8\u5206\u6210\u529F with exactly what landed and what did not: retry ONLY the failed part, because resending the whole call re-applies the parts that already succeeded. `changed` lists what actually happened. There is NO whole-page replace in this tool: to rewrite everything, delete the old text with edits (new_str "") and append the new text in a second call. When the returned body was truncated the result says so \u2014 truncated markdown is not the full page, so do not derive the next old_str from it.',
  /** `notion_page_trash` */
  pageTrash: "Move one Notion page or database row to the trash. A page with NO child pages is deleted by this one call, immediately. A page WITH child pages is NOT deleted by this one call: it returns kind:'pending' and lists every child page (id + title) that would go with it, because Notion always trashes the whole subtree. You must then answer that pending in a LATER model step with double_check \u2014 yes:true deletes the whole subtree, yes:false cancels; double_check becomes visible with the first pending. If the doublecheck service is unavailable, a subtree delete fails without deleting anything. Two things are refusals rather than pendings: a database or data source is refused outright (deleting one destroys its rows too \u2014 ask the user to do it in Notion), and a page whose child list cannot be read is refused because the scope could not be stated. A page already in the trash returns success with already_archived:true and changed:[] \u2014 nothing was written. Trash is idempotent: calling it twice is safe."
};

// src/lib/failures.ts
var SNIPPET_LIMIT = 300;
var FAILURE_HINTS = [
  {
    match: /not found on PATH|ENOENT/i,
    hint: "Hint: the Notion CLI is not installed where this process can see it. Install it with `npm i -g ntn` (or `curl -fsSL https://ntn.dev | bash`), then run `ntn login`."
  },
  {
    // The binary exists but the OS refused to execute it — a different fix from "missing".
    match: /EACCES|EPERM/i,
    hint: "Hint: `ntn` was found but the OS refused to execute it (EACCES/EPERM). Fix the file's permissions or its mount options; reinstalling will not help while the permission is wrong."
  },
  {
    match: /api token is invalid|unauthorized|\b401\b|invalid_token/i,
    hint: "Hint: the token was rejected. Set a valid NOTION_API_TOKEN (or run `ntn login`), and make sure the target pages/databases are shared with that integration."
  },
  {
    match: /no workspace selected|not logged in|not authenticated/i,
    hint: "Hint: not authenticated yet. Run `ntn login`, or set NOTION_API_TOKEN (plus NOTION_WORKSPACE_ID for multi-workspace tokens), then share the target pages/databases with the integration."
  },
  {
    match: /restricted_resource|\b403\b|could not find (page|database)|object_not_found|\b404\b|does not have access|not shared/i,
    hint: "Hint: the object exists but this integration cannot see it (or it does not exist). In Notion open the page/database, use \u2022\u2022\u2022 \u2192 Connections, and add the integration. A 404 and a missing permission look identical to the API."
  },
  {
    match: /rate_limited|\b429\b|too many requests/i,
    hint: "Hint: Notion rate-limited the request. Wait a moment and retry the same call; if it repeats, reduce how many calls you make in a burst (for example lower `limit`, or skip `include_content`)."
  },
  {
    match: /\b5\d\d\b|internal_server_error|service_unavailable|gateway_timeout|service_overload/i,
    hint: "Hint: Notion returned a server-side error. This is usually transient \u2014 retry once; if it keeps failing the request is probably too large or malformed rather than unlucky."
  },
  {
    match: /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|network/i,
    hint: "Hint: the request could not reach Notion (network/DNS). Check connectivity and retry."
  },
  {
    match: /timed out after \d+ms|no exit code/i,
    hint: "Hint: the `ntn` process was killed by our own timeout. Narrow the request (lower `limit`, avoid `include_content`) or retry; a repeated timeout is not a credential problem."
  },
  {
    // ntn's own wrapper message, with the underlying cause discarded. We cannot tell
    // which of the above it was, so we say exactly that instead of guessing.
    match: /failed to execute public API request/i,
    hint: "Hint: `ntn` discarded the underlying cause here (its own wording), so the reason is genuinely unknown from this error. Retry once; if it persists, check the token, the workspace, and whether the target is shared with the integration, in that order."
  }
];
function snippet(text2) {
  const trimmed = text2.trim();
  if (!trimmed) return "<empty>";
  return trimmed.length > SNIPPET_LIMIT ? `${trimmed.slice(0, SNIPPET_LIMIT)}\u2026` : trimmed;
}
function failureHint(result) {
  const text2 = `${result.stderr}
${result.stdout}`;
  if (!text2.trim()) return void 0;
  return FAILURE_HINTS.find((entry) => entry.match.test(text2))?.hint;
}
function failureStatus(result) {
  return result.code === null ? "no exit code (timed out or could not start)" : `exit ${result.code}`;
}
function describeFailure(result, label) {
  const detail = result.stderr.trim() || result.stdout.trim();
  return [
    `${label ? `${label}: ` : ""}ntn ${failureStatus(result)}.`,
    detail ? snippet(detail) : "ntn printed no error text.",
    failureHint(result)
  ].filter((part) => Boolean(part)).join("\n");
}

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
      description: GET_PARAMS.id_or_url
    },
    format: {
      type: "string",
      enum: ["md", "json"],
      description: GET_PARAMS.format
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
    description: TOOL_DESCRIPTIONS.get,
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
  const raw = readString(params.id_or_url, "id_or_url");
  const format = params.format === void 0 ? "md" : readEnum(params.format, "format", [
    { value: "md", aliases: ["markdown", "text", "md"] },
    { value: "json", aliases: ["json"] }
  ]);
  const id = extractNotionId(raw);
  if (!id) {
    throw inputError(
      GET_ERRORS.noIdInInput({ raw }),
      { id_or_url: raw }
    );
  }
  const page = await runPage(id, format, run);
  if (page.ok) return page.value;
  if (isFatalCliError(page.res)) throw new Error(describeFailure(page.res, "notion_get failed"));
  if (shouldTryDatabase(page.res)) {
    const database = await runDatabase(id, run);
    if (database.ok) return database.value;
    if (isFatalCliError(database.res)) {
      throw new Error(describeFailure(database.res, "notion_get failed"));
    }
    const dataSource = await runDataSourceSchema(id, run);
    if (dataSource.ok) return dataSource.value;
    const hint = failureHint(page.res) ?? failureHint(database.res) ?? "Make sure the target is shared with the Notion integration (in Notion: \u2022\u2022\u2022 \u2192 Connections).";
    throw new Error(
      `Could not read ${id} as a page, database or data source.
- ntn pages get: ${errorSummary(page.res)}
- ntn datasources resolve: ${errorSummary(database.res)}
- ntn api v1/data_sources: ${dataSource.excerpt}
` + hint
    );
  }
  throw new Error(describeFailure(page.res, `notion_get could not read ${id}`));
}
async function runDataSourceSchema(id, run) {
  let res;
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
  const url = typeof parsed.url === "string" && parsed.url ? parsed.url : void 0;
  const dataSource = {
    id,
    ...title ? { name: title } : {},
    properties
  };
  const candidates = parentItemCandidates([dataSource]);
  return {
    ok: true,
    value: {
      type: "database",
      id,
      ...title ? { title } : {},
      ...url ? { url } : {},
      data_source_ids: [id],
      properties,
      data_sources: [dataSource],
      ...candidates.length > 0 ? { parent_item_candidates: candidates } : {}
    }
  };
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

[notion_get] ntn truncated this page, so the text above is incomplete (rare: most pages, even very large ones, come back whole). Next: format="json" returns unknown_block_ids, child pages can be read by their own ids, notion_page_edit takes an exact old_str from the part above, and for a database notion_query reads its rows with limit / start_cursor.` : body;
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
      GET_RESULT_TEXT.parentItemCandidates({
        list: result.parent_item_candidates.map((candidate) => `${candidate.property} (data source ${candidate.data_source_id})`).join(", ")
      })
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
  lines.push(GET_RESULT_TEXT.schemaOnly);
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

// src/dsh/doublecheck.ts
function readDoublecheck(get) {
  const service = get();
  if (service === void 0 || service === null) return void 0;
  return service;
}
function checkpoint(p) {
  const usable = p.service !== void 0 && typeof p.service.checkpoint === "function";
  if (!usable) {
    if (p.risk !== null) throw p.unavailable();
    return void 0;
  }
  if (p.risk !== null) assertRisk(p.risk);
  let decision;
  try {
    decision = p.service.checkpoint(p.exec, p.risk);
  } catch (error) {
    if (error instanceof NotionToolError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new NotionToolError(message, { code: NOTION_ERROR_CODES.reviewUnavailable });
  }
  return interpret(decision);
}
function interpret(decision) {
  if (!isRecord2(decision) || typeof decision.kind !== "string") throw reviewBroken();
  if (decision.kind === "proceed") return void 0;
  if (decision.kind !== "pending") throw reviewBroken();
  const { id, reason } = decision;
  if (typeof id !== "string" || id.trim() === "" || typeof reason !== "string" || reason.trim() === "") {
    throw reviewBroken();
  }
  return decision;
}
function assertRisk(risk) {
  if (typeof risk.code !== "string" || risk.code.trim() === "" || typeof risk.reason !== "string" || risk.reason.trim() === "") {
    throw reviewBroken();
  }
}
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function reviewBroken() {
  return new NotionToolError(CHECK_ERRORS.malformed, {
    code: NOTION_ERROR_CODES.reviewUnavailable
  });
}

// src/text/checks.ts
var TRASH_RISK_CODES = {
  subtree: "notion.trash.subtree.v1"
};
var TRASH_CHILD_LABELS = {
  page: "\u5B50\u9875\u9762",
  database: "\u5B50\u6570\u636E\u5E93",
  container: "\u5D4C\u5957\u5BB9\u5668"
};
var TRASH_CHECKS = {
  /** 列表里的一行。种类要说清楚：把 toggle 容器写成「子页面」是在报一个不存在的页面。 */
  childLine: (p) => `  - [${TRASH_CHILD_LABELS[p.kind]}] ${p.label} \u2014 ${p.id}`,
  // kind ← listChildPages 判定的种类
  // label ← 子页面/数据库的标题，嵌套容器是块类型（比如 toggle）
  // id ← 子项的块 id
  /** 超过列出上限时补的一行：数量要说全，别让「只删父页面」看起来像「只删了列出来的那些」。 */
  overflow: (p) => `
  \u2026\u53E6\u6709 ${p.rest} \u4E2A\u672A\u5217\u51FA\uFF08\u5171 ${p.total} \u4E2A\uFF0C\u5B8C\u6574\u6E05\u5355\u89C1 Notion\uFF09\u3002`,
  // rest ← children.length - MAX_LISTED_CHILDREN
  // total ← children.length
  /** 有子页面时唯一要复核的事：这一删会连整棵子树一起进回收站。 */
  subtree: (p) => `\u5220\u9664${p.target}\u300C${p.title}\u300D(${p.id})\uFF0C\u4F1A\u8FDE\u5E26 ${p.count} \u4E2A\u5B50\u9875\u9762\u4E00\u8D77\u8FDB\u5165 Notion \u56DE\u6536\u7AD9\uFF1A
${p.listed}${p.overflow}
\u6CA1\u6709\u300C\u53EA\u5220\u7236\u9875\u9762\u3001\u4FDD\u7559\u5B50\u9875\u9762\u300D\u8FD9\u4E2A\u9009\u9879\u3002`
  // target ← 目标种类（"页面" / "数据行"）
  // title ← pageTitleOf(v1/pages/{id} 的响应)
  // id ← 参数 id
  // count ← children.length
  // listed ← 前 MAX_LISTED_CHILDREN 行 childLine
  // overflow ← children.length > MAX_LISTED_CHILDREN 时的剩余数量
};
var TRASH_PENDING_OUTPUT_TEXT = {
  details: "Stable JSON evidence from doublecheck; reason already states it in words."
};
var TRASH_PENDING_TEXT = {
  /**
   * pending 的第一行。
   *
   * 上一版的删除必须先传 yes:true，模型很可能把 pending 读成「失败了，重试」，
   * 所以第一句就否认这个读法：没有失败，也还没有删除。
   */
  head: "\u5F85\u590D\u6838 \xB7 \u672A\u5220\u9664\uFF1A\u76EE\u6807\u8FD8\u5728\u539F\u5904\u3002\u8FD9\u4E0D\u662F\u5931\u8D25 \u2014\u2014 \u6709\u5B50\u9875\u9762\u7684\u5220\u9664\u8981\u5148\u8FC7\u590D\u6838\u3002",
  /** 确认删除整棵子树。 */
  confirm: (p) => `\u786E\u8BA4\u5220\u9664 \u2192 double_check({ "id": "${p.id}", "yes": true })`,
  // id ← pending.id（doublecheck 生成的四位十六进制）
  /** 放弃删除。 */
  cancel: (p) => `\u4E0D\u5220\u9664   \u2192 double_check({ "id": "${p.id}", "yes": false })`,
  // id ← pending.id
  /** 只想删父页面时的替代路径：复核不会替调用方保留子页面。 */
  onlyParent: (p) => `\u53EA\u60F3\u5220\u7236\u9875\u9762 \u2192 \u5148 double_check({ "id": "${p.id}", "yes": false })\uFF0C\u518D\u7528 notion_page_edit \u628A\u4E0A\u9762\u5217\u51FA\u7684\u5B50\u9875\u9762\u9010\u4E2A\u79FB\u5230\u522B\u5904\uFF0C\u6700\u540E\u91CD\u65B0\u8C03\u7528 notion_page_trash\u3002`
  // id ← pending.id
};

// src/lib/datasources.ts
function parseResolveDataSources(raw) {
  const isRecord5 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (isRecord5(raw)) {
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
    if (!isRecord5(item)) continue;
    const id = typeof item.id === "string" ? item.id : typeof item.data_source_id === "string" ? item.data_source_id : typeof item.dataSourceId === "string" ? item.dataSourceId : void 0;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name2 = typeof item.name === "string" ? item.name : typeof item.title === "string" ? item.title : void 0;
    out.push(name2 ? { id, name: name2 } : { id });
  }
  return out;
}

// src/lib/schema.ts
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function extractSchemaProperties(raw) {
  if (!isRecord3(raw)) return void 0;
  let properties = raw.properties;
  if (!isRecord3(properties)) {
    for (const wrapper of ["data_source", "database"]) {
      const nested = raw[wrapper];
      if (isRecord3(nested) && isRecord3(nested.properties)) {
        properties = nested.properties;
        break;
      }
    }
  }
  if (!isRecord3(properties)) return void 0;
  const map = /* @__PURE__ */ new Map();
  for (const [name2, entry] of Object.entries(properties)) {
    if (!isRecord3(entry)) continue;
    const type = typeof entry.type === "string" ? entry.type : "unknown";
    const relation = isRecord3(entry.relation) ? entry.relation : void 0;
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
  if (isRecord3(raw) && typeof raw.id === "string" && raw.id) return raw.id;
  return fallback;
}

// src/tools/page.ts
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
function rejectUnexpectedParams(params, allowed, usage) {
  const unexpected = Object.keys(params).filter(
    (key) => params[key] !== void 0 && !allowed.includes(key)
  );
  if (unexpected.length > 0) {
    throw new InputError(PAGE_ERRORS.rejectUnexpectedParams_1({ usage, join: unexpected.join(", ") }), {
      unexpected_params: unexpected
    });
  }
}
function containerParentLabel(container) {
  return container.kind === "workspace" ? void 0 : formatParent(container.createParent);
}
var PAGE_SCHEMA = {
  source: "page",
  properties: /* @__PURE__ */ new Map([["title", { name: "title", type: "title" }]])
};
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
        PAGE_ERRORS.normalizeIcon_1,
        { field: "icon" }
      );
    }
    if (HTTP_URL_RE.test(value)) {
      return { payload: { type: "external", external: { url: value } }, display: value };
    }
    if ([...value].length > MAX_EMOJI_LENGTH) {
      throw new InputError(
        PAGE_ERRORS.normalizeIcon_2({ length: [...value].length, value: describeValue(value) }),
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
          PAGE_ERRORS.normalizeIcon_3,
          { field: "icon" }
        );
      }
      return { payload: { type: "emoji", emoji }, display: emoji };
    }
    if (type === "external") {
      const url = isPlainObject(raw.external) ? raw.external.url : void 0;
      if (typeof url !== "string" || !HTTP_URL_RE.test(url.trim())) {
        throw new InputError(
          PAGE_ERRORS.normalizeIcon_4,
          { field: "icon" }
        );
      }
      return { payload: { type: "external", external: { url: url.trim() } }, display: url.trim() };
    }
    if (type === "custom_emoji" || type === "file") {
      return { payload: raw, display: `${String(type)} icon` };
    }
    throw new InputError(
      PAGE_ERRORS.normalizeIcon_5({ raw: describeValue(raw) }),
      { field: "icon", value: raw }
    );
  }
  throw new InputError(
    PAGE_ERRORS.normalizeIcon_6({ raw: describeValue(raw) }),
    { field: "icon", value: raw }
  );
}
function normalizeBody(raw, required) {
  if (raw === void 0 || raw === null) {
    if (required) {
      throw new InputError(PAGE_ERRORS.normalizeBody_1, {
        field: "body_content"
      });
    }
    return void 0;
  }
  if (typeof raw !== "string") {
    throw new InputError(PAGE_ERRORS.normalizeBody_2({ raw: describeValue(raw) }), {
      field: "body_content"
    });
  }
  return raw;
}
function normalizeProps(raw) {
  if (raw === void 0 || raw === null) return void 0;
  if (Array.isArray(raw)) {
    throw new InputError(PAGE_ERRORS.normalizeProps_1);
  }
  if (!isPlainObject(raw)) {
    throw new InputError(PAGE_ERRORS.normalizeProps_2({ raw: describeValue(raw) }));
  }
  const entries = Object.entries(raw).filter(([, value]) => value !== void 0);
  return entries.length ? Object.fromEntries(entries) : void 0;
}
function normalizeTitle(raw) {
  if (raw === void 0 || raw === null) return void 0;
  if (typeof raw !== "string") throw new InputError(PAGE_ERRORS.normalizeTitle_1);
  const title = raw.trim();
  return title || void 0;
}
function parseParentSpec(raw, op) {
  const usage = op === "move" ? "page:<id>\uFF08\u628A\u9875\u9762\u6302\u5230\u8BE5\u9875\u9762\u4E0B\uFF09\u6216\u7236\u884C id\uFF08\u628A\u884C\u6302\u5230\u7236\u884C\u4E0B\uFF09" : "page:<id>\u3001database:<id>\u3001data-source:<id>\uFF0C\u6216\u6570\u636E\u5E93\u884C id\uFF08\u4F5C\u4E3A\u5B50\u884C\u7236\u7EA7\uFF09";
  if (typeof raw !== "string" || !raw.trim()) {
    throw new InputError(PAGE_ERRORS.parseParentSpec_1({ create: op === "move" ? "\u79FB\u52A8\u9875\u9762\uFF08parent\uFF09" : "create", usage }));
  }
  const value = raw.trim();
  const match = /^(page|database|data[_-]?source)\s*:\s*(.+)$/i.exec(value);
  if (!match) {
    const bare = isNotionId(value) ? value : extractNotionId(value);
    if (!bare) {
      throw new InputError(PAGE_ERRORS.parseParentSpec_2({ raw: describeValue(raw), usage }));
    }
    return { bare: true, id: bare };
  }
  const kindRaw = match[1].toLowerCase().replace("_", "-");
  const kind = kindRaw === "data-source" ? "data_source" : kindRaw;
  const rawId = match[2].trim();
  const id = isNotionId(rawId) ? rawId : extractNotionId(rawId);
  if (!id) {
    throw new InputError(PAGE_ERRORS.parseParentSpec_3({ match: describeValue(match[2]) }));
  }
  return { bare: false, kind, id };
}
function requireId(raw, op) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new InputError(PAGE_ERRORS.requireId_1({ op }));
  }
  const text2 = raw.trim();
  if (isNotionId(text2)) return text2;
  const extracted = extractNotionId(text2);
  if (extracted) return extracted;
  throw new InputError(PAGE_ERRORS.requireId_2({ raw: describeValue(raw) }));
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
  const hint = failureHint(result);
  const status = result.code === null && !detail ? `\uFF08${failureStatus(result)}\uFF09` : exit;
  return new NotionToolError(
    PAGE_ERRORS.ntnFailure_1({ note: note ? `${note}\uFF1B` : "", label, status, detail: detail ? `\uFF1A${truncate(detail)}` : "", hint }),
    {
      code: NOTION_ERROR_CODES.ntnFailed,
      details: {
        stderr: snippet(result.stderr),
        stdout: truncate(result.stdout.trim()),
        code: result.code,
        ...hint ? { hint } : {}
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
      PAGE_ERRORS.fetchDataSourceSchema_1({ path }),
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
      PAGE_ERRORS.resolveDatabaseDataSource_1({ databaseId }),
      { databaseId }
    );
  }
  if (refs.length > 1) {
    const lines = refs.map((ref) => `- ${ref.id}${ref.name ? ` (${ref.name})` : ""}`);
    throw new InputError(
      PAGE_ERRORS.resolveDatabaseDataSource_2({ databaseId, length: refs.length, n: lines.join("\n") }),
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
        PAGE_ERRORS.assertNoRowCycle_1({ MAX_ANCESTOR_WALK }),
        { id: childId, parent: parentId, cycle_check: "too_deep" }
      );
    }
    const current = queue.shift();
    const key = canonicalNotionId(current);
    if (visited.has(key)) continue;
    visited.add(key);
    if (sameNotionId(current, childId)) {
      throw new InputError(
        PAGE_ERRORS.assertNoRowCycle_2({ childId, parentId, parentId2: parentId, childId2: childId }),
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
        PAGE_ERRORS.assertNoRowCycle_3({ current, childId, parentId }),
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
            PAGE_ERRORS.assertNoRowCycle_4({ current, childId, parentId }),
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
async function classifyBareParent(runner, id, op, readPage) {
  let page;
  try {
    page = readPage ? await readPage(id) : await fetchPageObject(runner, id);
  } catch (error) {
    if (error instanceof NotionToolError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new InputError(
      PAGE_ERRORS.classifyBareParent_1({ id, detail: detail ? `\uFF08${truncate(detail, 300)}\uFF09` : "", create: op === "create" ? "create" : "\u79FB\u52A8\u9875\u9762" }),
      { parent: id }
    );
  }
  const parent = page.parent;
  if (!parent) {
    throw new InputError(
      PAGE_ERRORS.classifyBareParent_2({ id, create: op === "create" ? "create" : "\u79FB\u52A8\u9875\u9762" }),
      { parent: id }
    );
  }
  if (parent.kind === "page") return { kind: "page" };
  return { kind: "row", schemaParent: parent };
}
async function resolveContainer(runner, raw, op, readPage) {
  const spec = parseParentSpec(raw, op);
  if (spec.bare) {
    const target = await classifyBareParent(runner, spec.id, op, readPage);
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
      PAGE_ERRORS.requireString_1({ name: prop.name, type: prop.type, value: describeValue(value) }),
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
    PAGE_ERRORS.stringList_1({ name: prop.name, type: prop.type, value: describeValue(value) }),
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
        throw new InputError(PAGE_ERRORS.buildPropertyValue_1({ name: prop.name }), { property: prop.name });
      default:
        throw new InputError(PAGE_ERRORS.buildPropertyValue_2({ name: prop.name, type: prop.type }), {
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
      if (!text2.trim()) throw new InputError(PAGE_ERRORS.buildPropertyValue_3({ name: prop.name }), { property: prop.name });
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
          PAGE_ERRORS.buildPropertyValue_4({ name: prop.name, value: describeValue(value) }),
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
        PAGE_ERRORS.buildPropertyValue_5({ name: prop.name, value: describeValue(value) }),
        { property: prop.name, expected: "number" }
      );
    }
    case "select":
    case "status": {
      const name2 = typeof value === "string" ? value : isPlainObject(value) && typeof value.name === "string" ? value.name : void 0;
      if (name2 === void 0) {
        throw new InputError(
          PAGE_ERRORS.buildPropertyValue_6({ name: prop.name, type: prop.type, value: describeValue(value) }),
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
        PAGE_ERRORS.buildPropertyValue_7({ name: prop.name, value: describeValue(value) }),
        { property: prop.name, expected: "string | {start,end}" }
      );
    }
    case "checkbox": {
      if (typeof value !== "boolean") {
        throw new InputError(
          PAGE_ERRORS.buildPropertyValue_8({ name: prop.name, value: describeValue(value) }),
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
        PAGE_ERRORS.buildPropertyValue_9({ name: prop.name, type: prop.type, name2: prop.name, type2: prop.type }),
        { property: prop.name, type: prop.type }
      );
  }
}
function resolveProperty(schema, name2) {
  const prop = schema.properties.get(name2);
  const hints = writableProperties(schema);
  if (!prop) {
    throw new InputError(
      PAGE_ERRORS.resolveProperty_1({ name: name2, hints: formatHints(hints) }),
      { property: name2, hint_properties: hints }
    );
  }
  if (READ_ONLY_PROPERTY_TYPES.has(prop.type)) {
    throw new InputError(
      PAGE_ERRORS.resolveProperty_2({ name: name2, type: prop.type, hints: formatHints(hints) }),
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
  else if (h1 && existingFrontmatterTitle === void 0) {
    body = `\\# ${h1.title}

${h1.rest}`;
  }
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
function pageHasUrl(raw) {
  return isPlainObject(raw) && typeof raw.url === "string" && raw.url.startsWith("http");
}
function pageUrlFromRaw(raw, pageId) {
  if (pageHasUrl(raw)) return raw.url;
  return pageUrl(pageId);
}
function describePageValue(value) {
  const lines = [];
  if (value.changed.includes("trashed")) {
    lines.push(`\u5DF2\u628A\u9875\u9762 ${value.id} \u79FB\u5165\u56DE\u6536\u7AD9`);
    if (value.url) lines.push(`URL: ${value.url}`);
    return lines.join("\n");
  }
  if (value.already_archived) {
    lines.push(`\u9875\u9762 ${value.id} \u672C\u6765\u5C31\u5728\u56DE\u6536\u7AD9\u91CC\uFF0C\u672C\u6B21\u6CA1\u6709\u6267\u884C\u5220\u9664`);
    if (value.url) lines.push(`URL: ${value.url}`);
    lines.push("changed: (none)");
    return lines.join("\n");
  }
  if (value.already_linked) {
    lines.push(
      value.parent_item_property ? PAGE_RESULT_TEXT.alreadyLinked({
        hasParentItem: true,
        id: value.id,
        parentItemRowId: value.parent_item_row_id,
        parentItemProperty: value.parent_item_property,
        parent: value.parent
      }) : PAGE_RESULT_TEXT.alreadyLinked({
        hasParentItem: false,
        id: value.id,
        parentItemRowId: "",
        parentItemProperty: "",
        parent: value.parent
      })
    );
    if (value.url) lines.push(`URL: ${value.url}`);
    lines.push("changed: (none)");
    return lines.join("\n");
  }
  if (value.created) {
    lines.push(`\u5DF2\u521B\u5EFA\u9875\u9762${value.title ? ` "${value.title}"` : ""}\uFF1A${value.id ?? "(id \u672A\u8FD4\u56DE)"}`);
  } else if (value.changed.length === 0) {
    lines.push(`\u9875\u9762 ${value.id} \u6CA1\u6709\u6539\u52A8\uFF08changed: none\uFF09`);
  } else {
    const what = describeChanges(value.changed);
    lines.push(`\u5DF2\u66F4\u65B0\u9875\u9762 ${value.id} \u7684${what}`);
  }
  if (value.url) lines.push(`URL: ${value.url}`);
  if (value.parent) lines.push(`parent: ${value.parent}`);
  if (value.parent_item_row_id) lines.push(`Parent-item \u2192 ${value.parent_item_row_id}`);
  if (value.parent_item_property) lines.push(`Parent-item \u5217\uFF1A${value.parent_item_property}`);
  if (value.replaced_parent_ids?.length) {
    lines.push(`\u66FF\u6362\u4E86\u539F\u6765\u7684\u7236\u7EA7\uFF1A${value.replaced_parent_ids.join(", ")}`);
  }
  if (value.cycle_check === "partial") {
    lines.push(PAGE_RESULT_TEXT.cycleCheckPartial);
  }
  if (value.created) {
    if (value.title) lines.push(`\u6807\u9898\uFF1A${value.title}`);
    lines.push(
      value.body_chars ? PAGE_RESULT_TEXT.bodyWritten({ chars: value.body_chars }) : PAGE_RESULT_TEXT.bodyNotProvided
    );
  }
  if (value.properties.length) lines.push(`\u5DF2\u5199\u5165\u5217\uFF1A${value.properties.join(", ")}`);
  if (value.icon !== void 0) lines.push(`icon: ${value.icon ?? "\uFF08\u5DF2\u6E05\u9664\uFF09"}`);
  if (value.edits_sent !== void 0) {
    lines.push(
      PAGE_RESULT_TEXT.editTally({
        applied: value.edits_applied ?? 0,
        sent: value.edits_sent,
        missed: value.edits_missed ?? 0
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
function describeChanges(changed) {
  const words = {
    body_content: "\u5185\u5BB9",
    title: "\u6807\u9898",
    properties: "\u5C5E\u6027",
    icon: "icon",
    parent: "\u7236\u7EA7",
    parent_item_relation: "Parent-item \u94FE\u63A5"
  };
  const ordered = ["body_content", "title", "properties", "icon", "parent", "parent_item_relation"];
  const described = ordered.filter((key) => changed.includes(key)).map((key) => words[key]);
  return described.length ? described.join("\u3001") : changed.join("\u3001");
}
function pageValue(fields) {
  return { ok: true, properties: [], ...fields };
}
var MAX_CONTENT_UPDATES = 100;
var MARKDOWN_REQUEST_DEFAULTS = {
  markdown_version: "v2"
};
function readContentEdit(raw, index) {
  const path = `edits[${index}]`;
  if (!isPlainObject(raw)) {
    throw new InputError(
      PAGE_ERRORS.readContentEdit_1({ path, raw: describeValue(raw) }),
      { field: path, value: raw }
    );
  }
  const unexpected = Object.keys(raw).filter(
    (key) => raw[key] !== void 0 && !["old_str", "new_str", "replace_all_matches"].includes(key)
  );
  if (unexpected.length > 0) {
    throw new InputError(
      PAGE_ERRORS.readContentEdit_2({ path, join: unexpected.join(", ") }),
      { field: path, unexpected_params: unexpected }
    );
  }
  if (typeof raw.old_str !== "string") {
    throw new InputError(
      PAGE_ERRORS.readContentEdit_3({ path, old_str: describeValue(raw.old_str) }),
      { field: `${path}.old_str`, value: raw.old_str }
    );
  }
  if (raw.old_str === "") {
    throw new InputError(
      PAGE_ERRORS.readContentEdit_4({ path }),
      { field: `${path}.old_str` }
    );
  }
  if (raw.new_str === void 0) {
    throw new InputError(
      PAGE_ERRORS.readContentEdit_5({ path }),
      { field: `${path}.new_str`, value: raw.new_str }
    );
  }
  if (typeof raw.new_str !== "string") {
    throw new InputError(
      PAGE_ERRORS.readContentEdit_6({ path, new_str: describeValue(raw.new_str) }),
      { field: `${path}.new_str`, value: raw.new_str }
    );
  }
  return {
    old_str: raw.old_str,
    new_str: unescapeDollar(raw.new_str),
    ...raw.replace_all_matches === void 0 ? {} : { replace_all_matches: readBoolean(raw.replace_all_matches, `${path}.replace_all_matches`) }
  };
}
function unescapeDollar(text2) {
  return text2.replace(/\\\$/g, "$");
}
function readContentEdits(raw) {
  if (raw === void 0 || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new InputError(
      PAGE_ERRORS.readContentEdits_1({ raw: describeValue(raw) }),
      { field: "edits", value: raw }
    );
  }
  if (raw.length > MAX_CONTENT_UPDATES) {
    throw new InputError(
      PAGE_ERRORS.readContentEdits_2({ MAX_CONTENT_UPDATES, length: raw.length }),
      { field: "edits", count: raw.length, max: MAX_CONTENT_UPDATES }
    );
  }
  return raw.map((entry, index) => readContentEdit(entry, index));
}
function withEditAlias(edits, props) {
  if (!props || !("block_update" in props)) return { edits, props };
  if (edits.length > 0) {
    throw new InputError(
      PAGE_ERRORS.withEditAlias_1,
      { conflict: true, fields: ["edits", "props.block_update"] }
    );
  }
  const used = { ...props };
  const rawAlias = used.block_update;
  delete used.block_update;
  const aliasEdits = readContentEdits(rawAlias);
  const rest = Object.keys(used).length ? used : void 0;
  return { edits: aliasEdits, props: rest };
}
function readMarkdownWarnings(raw) {
  if (!isPlainObject(raw)) return void 0;
  if (!Array.isArray(raw.warnings)) return void 0;
  const warnings = raw.warnings.flatMap((entry) => {
    if (!isPlainObject(entry)) return [];
    const code = typeof entry.code === "string" ? entry.code : "unknown";
    const message = typeof entry.message === "string" ? entry.message : describeValue(entry);
    return [{ code, message }];
  });
  return warnings.length ? warnings : void 0;
}
function readMarkdownTruncated(raw) {
  return isPlainObject(raw) && raw.truncated === true ? true : void 0;
}
function countNoMatchWarnings(warnings) {
  if (!warnings) return 0;
  return warnings.filter((warning) => warning.code === "no_match").length;
}
var DELETION_REFUSAL_RE = /allow_deleting_content|delete (?:a )?child|child pages? or databases|archived? child/i;
function markdownFailure(pageId, result) {
  const detail = (result.stderr || result.stdout || "").trim();
  if (DELETION_REFUSAL_RE.test(detail)) {
    return new NotionToolError(
      PAGE_ERRORS.markdownFailure_1({ pageId, detail: truncate(detail, 600) }),
      {
        code: NOTION_ERROR_CODES.ntnFailed,
        details: {
          id: pageId,
          refused: "deleting_child_content",
          stderr: result.stderr.trim(),
          stdout: truncate(result.stdout.trim()),
          code: result.code
        }
      }
    );
  }
  return ntnFailure(`\u66F4\u65B0\u9875\u9762 ${pageId} \u7684 Markdown \u5185\u5BB9`, result);
}
async function patchPageMarkdown(runner, pageId, body) {
  const path = `v1/pages/${pageId}/markdown`;
  const result = await runner({
    args: ["api", path, "-X", "PATCH", "--data", JSON.stringify({ ...MARKDOWN_REQUEST_DEFAULTS, ...body })]
  });
  if (!result.ok) throw markdownFailure(pageId, result);
  const parsed = parseJsonMaybe(result.stdout);
  const warnings = readMarkdownWarnings(parsed);
  const truncated = readMarkdownTruncated(parsed);
  return {
    ...warnings ? { warnings } : {},
    ...truncated ? { truncated } : {}
  };
}
async function applyContentEdits(runner, pageId, edits) {
  const outcome = await patchPageMarkdown(runner, pageId, {
    type: "update_content",
    update_content: { content_updates: edits }
  });
  const missed = countNoMatchWarnings(outcome.warnings);
  return {
    ...outcome,
    edits_sent: edits.length,
    edits_applied: Math.max(edits.length - missed, 0),
    edits_missed: missed
  };
}
async function appendPageContent(runner, pageId, content) {
  return patchPageMarkdown(runner, pageId, {
    type: "insert_content",
    insert_content: { content, position: { type: "end" } }
  });
}
function patchArgs(pageId, properties, icon) {
  const body = {};
  if (Object.keys(properties).length > 0) body.properties = properties;
  if (icon) body.icon = icon.payload;
  return ["api", `v1/pages/${pageId}`, "-X", "PATCH", "--data", JSON.stringify(body)];
}
function buildPropertyWrite(schema, props, title, context) {
  const properties = {};
  const names = [];
  let titleFromProps;
  if (props) {
    const built = buildProperties(schema, props);
    Object.assign(properties, built.properties);
    names.push(...built.names);
    titleFromProps = built.title;
  }
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
  const changes = [];
  if (titleWritten) changes.push("title");
  if (names.length > 0 && !titleWritten) changes.push("properties");
  return {
    properties,
    names,
    ...titleFromProps ? { title: titleFromProps } : {},
    changes
  };
}
function parentItemError(schema, dataSourceId) {
  const relations = relationProperties(schema);
  const hints = writableProperties(schema);
  const detail = relations.length ? `\u73B0\u6709 relation \u5217\uFF1A${relations.map(
    (prop) => prop.relationDataSourceId ? `${prop.name} \u2192 ${prop.relationDataSourceId}` : prop.name
  ).join(", ")}` : "\u8BE5 data source \u6CA1\u6709\u4EFB\u4F55 relation \u5217";
  return new InputError(
    PAGE_ERRORS.parentItemError_1({ dataSourceId, detail }),
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
  const rollbackLine = partial ? PAGE_ERRORS.rollbackCreatedPage_3({ pageId, detail: detail ? truncate(detail, 300) : "" }) : PAGE_ERRORS.rollbackCreatedPage_2({ pageId });
  const details = {
    ...cause.details,
    partial,
    created_id: pageId,
    rollback: partial ? "trash_failed" : "trashed",
    rollback_code: trash.code,
    ...detail ? { rollback_error: truncate(detail, 600) } : {}
  };
  return new NotionToolError(PAGE_ERRORS.rollbackCreatedPage_1({ detail: cause.detail, rollbackLine }), {
    code: partial ? NOTION_ERROR_CODES.partialWrite : cause.code,
    details
  });
}
async function createPage(params, runner) {
  const readPage = makePageReader(runner);
  const container = params.parent === void 0 ? { kind: "workspace", schema: PAGE_SCHEMA } : await resolveContainer(runner, params.parent, "create", readPage);
  const parentLabel = containerParentLabel(container);
  const markdown = params.body ?? "";
  const {
    properties,
    names,
    title: propsTitle,
    changes
  } = buildPropertyWrite(container.schema, params.props, params.title, {
    source: container.schema.source
  });
  const propertyNames = [...names];
  const explicitTitle = params.title;
  const draft = planContent(markdown, explicitTitle ?? propsTitle);
  const title = draft.title;
  if (container.kind !== "page" && container.kind !== "workspace" && !title) {
    const hints = writableProperties(container.schema);
    throw new InputError(
      PAGE_ERRORS.createPage_1({ kind: container.kind === "row" ? `\u884C ${container.rowParentId} \u6240\u5728 data source` : container.kind, title: titlePropertyName(container.schema) ?? "title", hints: formatHints(hints) }),
      { ...parentLabel ? { parent: parentLabel } : { parent: "workspace" }, hint_properties: hints }
    );
  }
  if (!draft.body.trim()) {
    throw new InputError(PAGE_ERRORS.createPage_2);
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
      ...parentLabel === void 0 ? [] : ["--parent", parentLabel],
      `--content=${draft.body}`
    ]
  });
  if (!createResult.ok) throw ntnFailure("ntn pages create", createResult);
  const created = parseJsonMaybe(createResult.stdout);
  const structuredId = findPageId(created);
  const textId = structuredId ? void 0 : findPageIdInText(createResult.stdout);
  const pageId = structuredId ?? textId;
  const url = pageId ? pageUrlFromRaw(created, pageId) : void 0;
  const icon = params.icon;
  const requireTrustedId = (what) => {
    if (structuredId) return structuredId;
    throw new InputError(
      PAGE_ERRORS.createPage_3({ workspace: parentLabel ?? "workspace", what }),
      {
        parent: parentLabel ?? "workspace",
        partial: true,
        rollback: "unknown_id",
        ...pageId ? { id_candidate: pageId } : {},
        stdout: truncate(createResult.stdout.trim())
      }
    );
  };
  const needsPatch = propertyNames.length > 0 || icon !== void 0;
  if (needsPatch) {
    const targetId = requireTrustedId("props/icon");
    const patchResult = await runner({ args: patchArgs(targetId, properties, icon) });
    if (!patchResult.ok) {
      throw await rollbackCreatedPage(
        runner,
        targetId,
        ntnFailure(
          "PATCH \u9875\u9762\u5C5E\u6027/icon",
          patchResult,
          container.kind === "row" ? `\u5B50\u884C\u5DF2\u521B\u5EFA\uFF08id ${targetId}\uFF09\uFF0C\u4F46\u5C5E\u6027/Parent-item relation/icon \u672A\u5199\u5165` : `\u9875\u9762\u5DF2\u521B\u5EFA\uFF08id ${targetId}\uFF09\uFF0C\u4F46\u5C5E\u6027/icon \u672A\u5199\u5165`
        )
      );
    }
    if (icon) changes.push("icon");
  }
  changes.unshift("body_content");
  return pageValue({
    created: true,
    ...pageId ? { id: pageId } : {},
    ...url ? { url } : {},
    parent: parentLabel ?? "workspace",
    ...title ? { title } : {},
    // The body is what `pages create --content` sent; its size is the only evidence the
    // caller gets that the Markdown landed, without echoing the whole thing back.
    body_chars: draft.body.length,
    ...container.kind === "row" ? {
      parent_item_row_id: container.rowParentId,
      ...rowRelationName ? { parent_item_property: rowRelationName } : {}
    } : {},
    ...icon ? { icon: icon.display } : {},
    properties: propertyNames,
    changed: changes
  });
}
function asToolError(error, label) {
  if (error instanceof NotionToolError) return error;
  return ntnFailure(label, {
    ok: false,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    code: null
  });
}
function editWithFailures(failed, applied, result) {
  const causes = failed.map((failure) => ({
    step: failure.step,
    cause: asToolError(failure.error, failure.step)
  }));
  const failedSteps = causes.map((entry) => entry.step);
  if (applied.length === 0) {
    const primary = causes[0];
    return primary.cause;
  }
  const reported = causes.map((entry) => `  - ${entry.step}\uFF1A${entry.cause.detail}`).join("\n");
  return new NotionToolError(
    PAGE_ERRORS.editWithFailures_1({ join: applied.join("\u3001"), reported }),
    {
      code: causes[0].cause.code,
      details: {
        partial: true,
        applied,
        failed_steps: failedSteps,
        failures: causes.map((entry) => ({
          step: entry.step,
          code: entry.cause.code,
          message: entry.cause.detail,
          ...entry.cause.details
        })),
        changed: result.changes
      }
    }
  );
}
async function editPage(params, runner) {
  const { id, edits } = params;
  const result = { changes: [], properties: [], outcome: {} };
  const applied = [];
  const failed = [];
  if (edits.length > 0) {
    try {
      const appliedEdits = await applyContentEdits(runner, id, edits);
      result.outcome = appliedEdits;
      result.changes.push("body_content");
      applied.push(
        `\u5185\u5BB9\uFF08${appliedEdits.edits_applied}/${appliedEdits.edits_sent} \u6761 edits\uFF09`
      );
    } catch (error) {
      failed.push({ step: "\u6B63\u6587\uFF08edits\uFF09", error });
    }
  } else if (params.body !== void 0 && params.body.trim() !== "") {
    try {
      result.outcome = await appendPageContent(runner, id, params.body);
      result.appended = true;
      result.changes.push("body_content");
      applied.push("\u8FFD\u52A0\u7684\u6B63\u6587\u5185\u5BB9");
    } catch (error) {
      failed.push({ step: "\u8FFD\u52A0\u6B63\u6587\uFF08body_content\uFF09", error });
    }
  }
  const needsPatch = params.props !== void 0 || params.title !== void 0 || params.icon !== void 0;
  if (needsPatch) {
    let patchResult;
    try {
      const schema = await schemaForPage(runner, id);
      const { properties, names, changes } = buildPropertyWrite(schema, params.props, params.title, {
        pageId: id,
        source: schema.source
      });
      patchResult = await runner({ args: patchArgs(id, properties, params.icon) });
      if (!patchResult.ok) throw ntnFailure("PATCH \u9875\u9762\u5C5E\u6027/icon", patchResult);
      const patched = parseJsonMaybe(patchResult.stdout);
      if (pageHasUrl(patched)) result.url = pageUrlFromRaw(patched, id);
      result.properties = names;
      result.changes.push(...changes);
      if (params.icon !== void 0) result.changes.push("icon");
      if (names.length > 0) applied.push(`\u5C5E\u6027\uFF08${names.join(", ")}\uFF09`);
      if (params.icon !== void 0) applied.push("icon");
    } catch (error) {
      failed.push({ step: "\u5C5E\u6027/\u6807\u9898/icon\uFF08PATCH \u9875\u9762\u5C5E\u6027/icon\uFF09", error });
    }
  }
  if (params.parent !== void 0) {
    try {
      const move2 = await movePage(runner, { id, parent: params.parent, yes: params.yes });
      result.move = move2;
      if (move2.change) result.changes.push(move2.change);
    } catch (error) {
      failed.push({ step: "\u79FB\u52A8\u9875\u9762\uFF08parent\uFF09", error });
    }
  }
  if (failed.length > 0) throw editWithFailures(failed, applied, result);
  const { outcome, move } = result;
  return pageValue({
    id,
    url: result.url ?? move?.url ?? pageUrl(id),
    ...move?.parent ? { parent: move.parent } : {},
    ...move?.parent_item_row_id ? { parent_item_row_id: move.parent_item_row_id } : {},
    ...move?.parent_item_property ? { parent_item_property: move.parent_item_property } : {},
    ...move?.already_linked ? { already_linked: true } : {},
    ...move?.replaced_parent_ids ? { replaced_parent_ids: move.replaced_parent_ids } : {},
    ...move?.cycle_check ? { cycle_check: move.cycle_check } : {},
    ...params.icon !== void 0 ? { icon: params.icon.display } : {},
    properties: result.properties,
    changed: result.changes,
    ...outcome.warnings ? { warnings: outcome.warnings } : {},
    ...outcome.truncated ? { truncated: true } : {},
    ...result.appended ? { appended: true } : {},
    ...outcome.edits_sent !== void 0 ? {
      edits_sent: outcome.edits_sent,
      edits_applied: outcome.edits_applied,
      edits_missed: outcome.edits_missed
    } : {}
  });
}
async function movePage(runner, options) {
  const { id } = options;
  const spec = parseParentSpec(options.parent, "move");
  if (!spec.bare && spec.kind !== "page") {
    throw new InputError(PAGE_ERRORS.movePage_1);
  }
  const readPage = makePageReader(runner);
  const container = await resolveContainer(runner, options.parent, "move", readPage);
  const childPage = await readPage(id);
  const childParent = childPage.parent;
  if (!childParent) {
    throw new InputError(
      PAGE_ERRORS.movePage_2({ id }),
      { id }
    );
  }
  if (container.kind === "page") {
    const targetParentId = container.createParent.id;
    if (sameNotionId(id, targetParentId)) {
      throw new InputError(PAGE_ERRORS.movePage_3({ id }), { id, parent: targetParentId });
    }
    if (childParent.kind === "page" && sameNotionId(childParent.id, targetParentId)) {
      throw new InputError(PAGE_ERRORS.movePage_4({ id, targetParentId }), { id });
    }
    const cycle = await walkPageAncestors(readPage, { childId: id, parentId: targetParentId });
    if (cycle.cycle) {
      throw new InputError(
        PAGE_ERRORS.movePage_5({ id, targetParentId, join: cycle.cycle.join(" \u2192 ") }),
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
    return {
      parent: formatParent(container.createParent),
      cycle_check: cycle.status,
      change: "parent",
      ...pageHasUrl(moved) ? { url: pageUrlFromRaw(moved, id) } : {}
    };
  }
  if (container.kind !== "row") {
    throw new InputError(PAGE_ERRORS.movePage_6);
  }
  if (childParent.kind === "page") {
    throw new InputError(
      PAGE_ERRORS.movePage_7({ id, id2: childParent.id ? ` ${childParent.id}` : "", rowParentId: container.rowParentId }),
      { id, parentRowId: container.rowParentId }
    );
  }
  if (sameNotionId(id, container.rowParentId)) {
    throw new InputError(PAGE_ERRORS.movePage_8({ id }), { id });
  }
  const childDataSourceId = await dataSourceIdForParent(runner, childParent);
  if (!sameNotionId(childDataSourceId, container.dataSourceId)) {
    throw new InputError(
      PAGE_ERRORS.movePage_9({ id, childDataSourceId, rowParentId: container.rowParentId, dataSourceId: container.dataSourceId }),
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
    return {
      parent: formatParent(container.createParent),
      parent_item_property: relation.name,
      parent_item_row_id: container.rowParentId,
      already_linked: true,
      change: null
    };
  }
  if (currentParents.length > 0 && options.yes !== true) {
    throw new InputError(
      PAGE_ERRORS.movePage_10({ id, name: relation.name, join: currentParents.join(", "), rowParentId: container.rowParentId }),
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
  return {
    parent: formatParent(container.createParent),
    parent_item_property: relation.name,
    parent_item_row_id: container.rowParentId,
    ...currentParents.length > 0 ? { replaced_parent_ids: currentParents } : {},
    cycle_check: "walked",
    change: "parent_item_relation",
    ...pageHasUrl(patched) ? { url: pageUrlFromRaw(patched, id) } : {}
  };
}
function isNotFound(res) {
  if (res.ok) return false;
  const text2 = `${res.stderr}
${res.stdout}`;
  return /404|not_found|object_not_found|Could not find|is a (database|data source|page), not a/i.test(
    text2
  );
}
async function classifyTrashTarget(runner, id) {
  const probes = [
    { kind: "page", path: `v1/pages/${id}` },
    { kind: "database", path: `v1/databases/${id}` },
    { kind: "database", path: `v1/data_sources/${id}` }
  ];
  for (const probe of probes) {
    const res = await runner({ args: ["api", probe.path] });
    if (res.ok) {
      if (probe.kind === "database") return { kind: "database" };
      const raw = parseJsonMaybe(res.stdout);
      const archived = isPlainObject(raw) && (raw.archived === true || raw.in_trash === true);
      const title = isPlainObject(raw) ? pageTitleOf(raw) : void 0;
      const parent = isPlainObject(raw) ? pageParentOf(raw) : void 0;
      return {
        kind: "page",
        archived,
        ...title === void 0 ? {} : { title },
        ...parent === void 0 ? {} : { parent }
      };
    }
    if (!isNotFound(res)) {
      return { kind: "unreadable", reason: (res.stderr || res.stdout).trim() };
    }
  }
  return { kind: "missing" };
}
var NESTING_BLOCK_TYPES = /* @__PURE__ */ new Set([
  "toggle",
  "column_list",
  "column",
  "synced_block",
  "link_to_page",
  "template",
  "callout"
]);
var MAX_BLOCK_PAGES = 100;
var MAX_LISTED_CHILDREN = 20;
var MAX_RISK_CHILDREN = 50;
var MAX_LISTED_TITLE = 40;
var MAX_LISTED_CHILD_TITLE = 24;
async function listChildPages(runner, pageId) {
  const children = [];
  let cursor;
  for (let page = 0; page < MAX_BLOCK_PAGES; page += 1) {
    const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : "";
    const result = await runner({ args: ["api", `v1/blocks/${pageId}/children${query}`] });
    if (!result.ok) throw ntnFailure(`\u5217\u51FA\u9875\u9762 ${pageId} \u7684\u5B50\u5757`, result);
    const parsed = parseJsonMaybe(result.stdout);
    if (!isPlainObject(parsed)) {
      throw inputError(
        PAGE_ERRORS.listChildPages_1({ pageId, trim: truncate((result.stdout || "").trim(), 200) }),
        { id: pageId, enumerable: false }
      );
    }
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    for (const block of results) {
      if (!isPlainObject(block)) continue;
      if (typeof block.id !== "string") continue;
      if (block.type === "child_page") {
        const title = isPlainObject(block.child_page) && typeof block.child_page.title === "string" ? block.child_page.title : "(untitled)";
        children.push({ id: block.id, label: title, kind: "page" });
        continue;
      }
      if (block.type === "child_database") {
        const title = isPlainObject(block.child_database) && typeof block.child_database.title === "string" ? block.child_database.title : "(untitled database)";
        children.push({ id: block.id, label: title, kind: "database" });
        continue;
      }
      if (block.has_children === true && NESTING_BLOCK_TYPES.has(String(block.type))) {
        children.push({ id: block.id, label: String(block.type), kind: "container" });
      }
    }
    const hasMore = parsed.has_more === true;
    const next = typeof parsed.next_cursor === "string" ? parsed.next_cursor : void 0;
    if (!hasMore) return children;
    if (!next) {
      throw inputError(
        PAGE_ERRORS.listChildPages_2({ pageId }),
        { id: pageId, enumerable: false }
      );
    }
    cursor = next;
    if (page === MAX_BLOCK_PAGES - 1) {
      throw inputError(
        PAGE_ERRORS.listChildPages_3({ pageId, MAX_BLOCK_PAGES }),
        { id: pageId, children_enumerated: children.length, enumerable: false }
      );
    }
  }
  return children;
}
async function trashPage(params, runner, deps) {
  const { id } = params;
  const signal = deps.exec?.signal;
  if (signal?.aborted) throw abortError();
  const target = await classifyTrashTarget(runner, id);
  if (target.kind === "unreadable") {
    throw ntnFailure(`\u786E\u8BA4\u9875\u9762 ${id} \u7684\u7C7B\u578B\uFF08page / database / data source\uFF09`, {
      ok: false,
      stdout: "",
      stderr: target.reason,
      code: null
    });
  }
  if (target.kind === "missing") {
    throw new InputError(
      PAGE_ERRORS.trashPage_1({ id }),
      { id, target: "missing" }
    );
  }
  if (target.kind === "database") {
    throw new InputError(
      PAGE_ERRORS.trashPage_2({ id }),
      { id, target: "database", refused: "database_delete" }
    );
  }
  if (target.archived) {
    return pageValue({
      id,
      url: pageUrl(id),
      already_archived: true,
      properties: [],
      changed: []
    });
  }
  const children = await listChildPages(runner, id);
  const risk = children.length === 0 ? null : trashSubtreeRisk(id, target, children);
  const pending = checkpoint({
    service: readDoublecheck(deps.getDoublecheck ?? (() => void 0)),
    exec: deps.exec,
    risk,
    // Only reached when child pages exist and there is no review channel: say what was
    // found, because "nothing happened" alone would hide how much was at stake.
    unavailable: () => new NotionToolError(PAGE_ERRORS.trashPage_3({ id, count: children.length }), {
      code: NOTION_ERROR_CODES.reviewUnavailable,
      details: {
        id,
        children: children.map((child) => child.id),
        children_count: children.length
      }
    })
  });
  if (pending) return pending;
  if (signal?.aborted) throw abortError();
  const result = await runner({ args: ["pages", "trash", id, "--yes"] });
  if (!result.ok) throw ntnFailure("ntn pages trash", result);
  return pageValue({ id, url: pageUrl(id), properties: [], changed: ["trashed"] });
}
function trashSubtreeRisk(id, target, children) {
  const ordered = [...children].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const reason = TRASH_CHECKS.subtree({
    target: "\u9875\u9762",
    title: truncate(target.title ?? id, MAX_LISTED_TITLE),
    id,
    count: ordered.length,
    listed: ordered.slice(0, MAX_LISTED_CHILDREN).map(
      (child) => TRASH_CHECKS.childLine({
        kind: child.kind,
        label: truncate(child.label, MAX_LISTED_CHILD_TITLE),
        id: child.id
      })
    ).join("\n"),
    overflow: ordered.length > MAX_LISTED_CHILDREN ? TRASH_CHECKS.overflow({ rest: ordered.length - MAX_LISTED_CHILDREN, total: ordered.length }) : ""
  });
  return {
    code: TRASH_RISK_CODES.subtree,
    reason,
    details: {
      scope: "subtree",
      tool: "notion_page_trash",
      page_id: id,
      ...target.title === void 0 ? {} : { page_title: target.title },
      ...target.parent === void 0 ? {} : { parent: target.parent },
      child_count: ordered.length,
      children: ordered.slice(0, MAX_RISK_CHILDREN).map((child) => ({
        kind: child.kind,
        id: child.id,
        title: child.label
      })),
      children_truncated: ordered.length > MAX_RISK_CHILDREN
    }
  };
}
function pageTitleOf(raw) {
  const properties = isPlainObject(raw.properties) ? raw.properties : void 0;
  if (!properties) return void 0;
  for (const value of Object.values(properties)) {
    if (!isPlainObject(value) || value.type !== "title" || !Array.isArray(value.title)) continue;
    const text2 = value.title.map((part) => isPlainObject(part) && typeof part.plain_text === "string" ? part.plain_text : "").join("").trim();
    return text2 === "" ? void 0 : text2;
  }
  return void 0;
}
function pageParentOf(raw) {
  const parent = isPlainObject(raw.parent) ? raw.parent : void 0;
  if (!parent || typeof parent.type !== "string") return void 0;
  const id = parent.type === "page_id" ? parent.page_id : parent.type === "database_id" ? parent.database_id : void 0;
  return typeof id === "string" ? { type: parent.type, id } : void 0;
}
function describeTrashPending(pending) {
  return [
    TRASH_PENDING_TEXT.head,
    pending.reason,
    "",
    TRASH_PENDING_TEXT.confirm({ id: pending.id }),
    TRASH_PENDING_TEXT.cancel({ id: pending.id }),
    TRASH_PENDING_TEXT.onlyParent({ id: pending.id })
  ].join("\n");
}
var ICON_PARAMETERS = [
  { type: "string", description: ICON_TEXT.string },
  { type: "object", additionalProperties: true, description: ICON_TEXT.object },
  { type: "null", description: ICON_TEXT.null }
];
var EDIT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    old_str: {
      type: "string",
      description: EDIT_ITEM_TEXT.old_str
    },
    new_str: {
      type: "string",
      description: EDIT_ITEM_TEXT.new_str
    },
    replace_all_matches: {
      type: "boolean",
      description: EDIT_ITEM_TEXT.replace_all_matches
    }
  },
  required: ["old_str", "new_str"],
  additionalProperties: false
};
var CREATE_PARAMETERS = {
  type: "object",
  properties: {
    parent: {
      type: "string",
      description: CREATE_PARAMS.parent
    },
    title: {
      type: "string",
      description: CREATE_PARAMS.title
    },
    props: { type: "object", additionalProperties: true, description: PROPS_DESCRIPTION },
    icon: { oneOf: ICON_PARAMETERS, description: ICON_PARAMETER_TEXT_CREATE },
    body_content: {
      type: "string",
      description: CREATE_PARAMS.body_content
    }
  },
  // `parent` is NOT required: omitting it creates the page at the WORKSPACE ROOT, which
  // is what `ntn pages create` and POST /v1/pages do when no parent is given. Requiring
  // it would be a restriction neither the CLI nor the API has.
  additionalProperties: false
};
var EDIT_PARAMETERS = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: EDIT_PARAMS.id
    },
    edits: {
      type: "array",
      items: EDIT_ITEM_SCHEMA,
      description: EDIT_PARAMS.edits
    },
    body_content: {
      type: "string",
      description: EDIT_PARAMS.body_content
    },
    props: { type: "object", additionalProperties: true, description: PROPS_DESCRIPTION },
    title: { type: "string", description: EDIT_PARAMS.title },
    icon: { oneOf: ICON_PARAMETERS, description: ICON_PARAMETER_TEXT_EDIT },
    parent: {
      type: "string",
      description: EDIT_PARAMS.parent
    },
    yes: {
      type: "boolean",
      description: EDIT_PARAMS.yes
    }
  },
  required: ["id"],
  additionalProperties: false
};
var TRASH_PARAMETERS = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: TRASH_PARAMS.id
    }
  },
  required: ["id"],
  additionalProperties: false
};
var PAGE_OUTPUT_SCHEMA = {
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
          message: { type: "string" }
        },
        required: ["code", "message"],
        additionalProperties: false
      }
    },
    appended: { type: "boolean", const: true },
    edits_sent: { type: "integer" },
    edits_applied: { type: "integer" },
    edits_missed: { type: "integer" },
    truncated: { type: "boolean", const: true }
  },
  required: ["ok", "properties", "changed"],
  additionalProperties: false
};
var TRASH_PENDING_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", const: "pending" },
    id: { type: "string" },
    reason: { type: "string" },
    details: { description: TRASH_PENDING_OUTPUT_TEXT.details }
  },
  required: ["kind", "id", "reason"],
  additionalProperties: false
};
var TRASH_OUTPUT_SCHEMA = {
  oneOf: [PAGE_OUTPUT_SCHEMA, TRASH_PENDING_OUTPUT_SCHEMA]
};
function createNotionPageCreateTool(deps = {}) {
  const runner = deps.runNtn ?? runNtn;
  return defineNotionTool({
    name: "notion_page_create",
    description: TOOL_DESCRIPTIONS.pageCreate,
    timeoutMs: TOOL_TIMEOUTS.page,
    // Every operation here can write, so page calls stay exclusive: never overlap two.
    isConcurrencySafe: () => false,
    parameters: CREATE_PARAMETERS,
    output: {
      schema: PAGE_OUTPUT_SCHEMA,
      render: (_args, value) => textBlocks(describePageValue(value))
    },
    async execute(args, exec) {
      rejectUnexpectedParams(
        args,
        ["parent", "title", "props", "icon", "body_content"],
        "notion_page_create \u53EA\u63A5\u53D7 { parent, title, props, icon, body_content }\u3002"
      );
      if (exec.signal?.aborted) throw abortError();
      const title = normalizeTitle(args.title);
      const props = normalizeProps(args.props);
      const icon = normalizeIcon(args.icon);
      const body = normalizeBody(args.body_content, false);
      const params = {
        parent: args.parent,
        ...title ? { title } : {},
        ...props ? { props } : {},
        ...icon ? { icon } : {},
        ...body === void 0 ? {} : { body }
      };
      return await createPage(params, bindSignal(runner, exec.signal));
    }
  });
}
function createNotionPageEditTool(deps = {}) {
  const runner = deps.runNtn ?? runNtn;
  return defineNotionTool({
    name: "notion_page_edit",
    description: TOOL_DESCRIPTIONS.pageEdit,
    timeoutMs: TOOL_TIMEOUTS.page,
    isConcurrencySafe: () => false,
    parameters: EDIT_PARAMETERS,
    output: {
      schema: PAGE_OUTPUT_SCHEMA,
      render: (_args, value) => textBlocks(describePageValue(value))
    },
    async execute(args, exec) {
      rejectUnexpectedParams(
        args,
        ["id", "edits", "body_content", "props", "title", "icon", "parent", "yes"],
        "notion_page_edit \u53EA\u63A5\u53D7 { id, edits, body_content, props, title, icon, parent, yes }\u3002"
      );
      if (exec.signal?.aborted) throw abortError();
      const id = requireId(args.id, "edit");
      const normalizedProps = normalizeProps(args.props);
      const { edits, props } = withEditAlias(readContentEdits(args.edits), normalizedProps);
      const body = normalizeBody(args.body_content, false);
      const icon = normalizeIcon(args.icon);
      const title = normalizeTitle(args.title);
      const hasYes = args.yes !== void 0;
      const yes = hasYes ? readBoolean(args.yes, "yes") : false;
      if (hasYes && args.parent === void 0) {
        throw new InputError(
          PAGE_ERRORS.createNotionPageEditTool_1,
          { field: "yes" }
        );
      }
      const appends = body !== void 0 && body.trim() !== "";
      if (edits.length > 0 && body !== void 0) {
        throw new InputError(
          PAGE_ERRORS.createNotionPageEditTool_2,
          { conflict: true, fields: ["edits", "body_content"] }
        );
      }
      if (edits.length === 0 && !appends && props === void 0 && title === void 0 && icon === void 0 && args.parent === void 0) {
        throw new InputError(PAGE_ERRORS.createNotionPageEditTool_3({ bodyProvided: body !== void 0 }));
      }
      const params = {
        id,
        edits,
        ...appends ? { body } : {},
        ...props ? { props } : {},
        ...title ? { title } : {},
        ...icon ? { icon } : {},
        ...args.parent === void 0 ? {} : { parent: args.parent },
        yes
      };
      return await editPage(params, bindSignal(runner, exec.signal));
    }
  });
}
function createNotionPageTrashTool(deps = {}) {
  const runner = deps.runNtn ?? runNtn;
  return defineNotionTool({
    name: "notion_page_trash",
    description: TOOL_DESCRIPTIONS.pageTrash,
    timeoutMs: TOOL_TIMEOUTS.page,
    isConcurrencySafe: () => false,
    parameters: TRASH_PARAMETERS,
    output: {
      schema: TRASH_OUTPUT_SCHEMA,
      render: (_args, value) => textBlocks(isPendingValue(value) ? describeTrashPending(value) : describePageValue(value))
    },
    async execute(args, exec) {
      rejectUnexpectedParams(
        args,
        ["id", "yes", "recursive"],
        "notion_page_trash \u53EA\u63A5\u53D7 { id }\uFF08yes/recursive \u5DF2\u4E0D\u518D\u9700\u8981\uFF0C\u4F20\u4E86\u4E5F\u4F1A\u88AB\u5FFD\u7565\uFF09\u3002"
      );
      if (exec.signal?.aborted) throw abortError();
      return await trashPage(
        { id: requireId(args.id, "trash") },
        bindSignal(runner, exec.signal),
        { exec, getDoublecheck: deps.getDoublecheck }
      );
    }
  });
}
function isPendingValue(value) {
  return value.kind === "pending";
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
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function summarizeFailure(result, action) {
  return describeFailure(result, `${action} failed`);
}
function readQueryLimit(raw) {
  if (raw === void 0 || raw === null) return DEFAULT_QUERY_LIMIT;
  const value = readInteger(raw, "limit", 1, MAX_QUERY_LIMIT);
  return value;
}
function normalizeSort(sort) {
  if (sort === void 0) return [];
  const raw = Array.isArray(sort) ? sort : [sort];
  const specs = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw inputError(
        QUERY_ERRORS.sortEntryNotString({ got: describe(item) }),
        { sort: item }
      );
    }
    const spec = item.trim();
    if (!spec) {
      throw inputError(QUERY_ERRORS.sortEntryEmpty);
    }
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
  if (!isRecord4(row)) {
    throw new Error(`ntn datasources query returned result #${index + 1} that is not an object.`);
  }
  if (typeof row.id !== "string" || !row.id) {
    throw new Error(`ntn datasources query returned result #${index + 1} without an id.`);
  }
  return {
    id: row.id,
    url: typeof row.url === "string" ? row.url : null,
    properties: isRecord4(row.properties) ? row.properties : {}
  };
}
function parseQueryResponse(raw, target) {
  const payload = Array.isArray(raw) ? { results: raw, next_cursor: null, has_more: false } : isRecord4(raw) ? raw : null;
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
  if (!isRecord4(filter)) return out;
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
      `data source ${schema.dataSourceId} \u6CA1\u6709\u53EF\u7528\u7684 Parent-item / \u81EA\u5173\u8054 relation \u5217\uFF0C\u65E0\u6CD5\u7528 under \u7B5B\u5B50\u884C\uFF08${relations.length ? `\u73B0\u6709 relation \u5217\uFF1A${relations.join(", ")}` : "\u8BE5 data source \u6CA1\u6709\u4EFB\u4F55 relation \u5217"}\uFF09\u3002\u8BF7\u6539\u7528 filter \u663E\u5F0F\u8FC7\u6EE4\uFF0C\u6216\u5148\u4E3A\u8BE5\u5E93\u52A0\u4E00\u4E2A\u6307\u5411\u81EA\u8EAB\u7684 relation \u5C5E\u6027\u3002\u53EF\u5199\u5C5E\u6027\uFF1A${hints.length ? hints.map((h) => `${h.name} (${h.type})`).join(", ") : "(none)"}\u3002`,
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
  const rawTarget = params.database_or_data_source;
  const target = rawTarget === void 0 || rawTarget === null || rawTarget === "" ? "" : readString(rawTarget, "database_or_data_source");
  if (!target) {
    throw new QueryInputError(
      "database_or_data_source \u5FC5\u987B\u662F data source / database \u7684 id \u6216 URL\uFF08\u975E\u7A7A\uFF09\uFF0C\u4E0D\u77E5\u9053 id \u65F6\u5148\u7528 notion_search \u6309\u6807\u9898\u627E\u5230\u5B83\u3002"
    );
  }
  const rawCursor = params.start_cursor;
  const rawInclude = params.include_content;
  const includeContent = rawInclude === void 0 ? false : readBoolean(rawInclude, "include_content");
  const limit = readQueryLimit(params.limit);
  const sorts = normalizeSort(params.sort);
  const startCursor = rawCursor === void 0 || rawCursor === null || typeof rawCursor === "string" && rawCursor.trim() === "" ? void 0 : readString(rawCursor, "start_cursor");
  const callerFilter = params.filter;
  if (callerFilter !== void 0 && !isRecord4(callerFilter)) {
    throw new QueryInputError("filter must be a Notion filter JSON object.");
  }
  const underFilter = params.under === void 0 ? void 0 : await filterUnder(params, target, runner);
  const filter = underFilter ?? callerFilter;
  const options = { limit, startCursor, filter, sorts };
  let query = await runner({ args: buildQueryArgs(target, options) });
  if (!query.ok) {
    const resolved = await resolveDataSources(target, runner);
    if (resolved.length > 1) {
      throw new QueryInputError(describeDataSources(target, resolved), {
        target,
        data_source_ids: resolved.map((dataSource) => dataSource.id)
      });
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
  result = { ...result, limit };
  if (includeContent) {
    await attachMarkdown(result.results, runner);
  }
  return result;
}
var QUERY_PARAMETERS = {
  type: "object",
  properties: {
    database_or_data_source: {
      // No `minLength`: DSH's enforced schema subset rejects it, and the PTC SDK
      // then degrades this whole tool's argument type to `unknown`. The empty case
      // is guarded at execution instead.
      type: "string",
      description: QUERY_PARAMS.database_or_data_source
    },
    limit: {
      type: "integer",
      description: QUERY_PARAMS.limit({ fallback: DEFAULT_QUERY_LIMIT, max: MAX_QUERY_LIMIT })
    },
    start_cursor: {
      oneOf: [{ type: "string" }, { type: "null" }],
      description: QUERY_PARAMS.start_cursor
    },
    filter: {
      type: "object",
      additionalProperties: true,
      description: QUERY_PARAMS.filter
    },
    under: {
      type: "string",
      description: QUERY_PARAMS.sort
    },
    sort: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      description: QUERY_PARAMS.under
    },
    include_content: {
      type: "boolean",
      description: QUERY_PARAMS.include_content
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
    has_more: { type: "boolean" },
    limit: { type: "integer" }
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
    description: TOOL_DESCRIPTIONS.query,
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
          throw new NotionToolError(error.message, {
            code: NOTION_ERROR_CODES.invalidInput,
            details: error.details
          });
        }
        throw codedError(error);
      }
    }
  });
}

// src/tools/search.ts
var DEFAULT_LIMIT = 10;
var MAX_LIMIT = 50;
var SEARCH_PATH = "v1/search";
var defaultDeps = { run: runNtn };
function normalizeQuery(query) {
  const value = typeof query === "string" ? query.trim() : "";
  if (!value) {
    throw inputError(
      SEARCH_ERRORS.emptyQuery
    );
  }
  return value;
}
function normalizeLimit(limit) {
  if (limit === void 0 || limit === null) return DEFAULT_LIMIT;
  return readInteger(limit, `notion_search limit (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`, 1, MAX_LIMIT);
}
function buildSearchBody(params) {
  const body = { query: params.query, page_size: params.limit };
  if (params.filter_object !== void 0) {
    const object = readEnum(params.filter_object, "filter_object", [
      { value: "page", aliases: ["pages"] },
      { value: "database", aliases: ["databases", "data_source", "data_sources", "db"] }
    ]);
    body.filter = {
      property: "object",
      // Notion 2025-09 起把 database 改名为 data_source；旧值会被接口判非法。
      value: object === "database" ? "data_source" : "page"
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
async function searchNotion(params, runner = defaultDeps.run) {
  const query = normalizeQuery(params.query);
  const limit = normalizeLimit(params.limit);
  const body = buildSearchBody({ query, limit, filter_object: params.filter_object });
  const result = await runner({ args: buildSearchArgs(body) });
  if (!result.ok) throw new Error(describeFailure(result, "notion_search failed"));
  const { results, hasMore } = parseSearchResponse(result.stdout);
  return { query, limit, results: results.slice(0, limit), hasMore };
}
function formatOutcome(outcome) {
  const header = `Notion search "${outcome.query}": ${outcome.results.length} result(s) (limit ${outcome.limit}).`;
  const body = outcome.results.length === 0 ? [
    'No matches. Notion search scans TITLES only (never body text): retry the EXACT title in double quotes, e.g. "My Page Title".',
    "Do NOT simply shorten the query: matching is token-OR, so fewer words means MORE unrelated hits, not fewer."
  ] : outcome.results.map((hit, index) => {
    const title = hit.title || "(untitled)";
    const url = hit.url ? `
   ${hit.url}` : "";
    return `${index + 1}. ${hit.object} \xB7 ${title}
   id: ${hit.id}${url}`;
  });
  const footer = outcome.hasMore && outcome.results.length > 0 ? [`More results exist upstream: narrow the query or raise limit (max ${MAX_LIMIT}).`] : [];
  return [header, ...body, ...footer].join("\n");
}
function createNotionSearchTool(deps = {}) {
  const runner = deps.run ?? defaultDeps.run;
  return defineNotionTool({
    name: "notion_search",
    description: TOOL_DESCRIPTIONS.search,
    timeoutMs: TOOL_TIMEOUTS.search,
    // Read-only and independent of every other call: safe to run alongside siblings.
    isConcurrencySafe: () => true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: SEARCH_PARAMS.query
        },
        limit: {
          type: "integer",
          description: SEARCH_PARAMS.limit({ fallback: DEFAULT_LIMIT, max: MAX_LIMIT })
        },
        filter_object: {
          type: "string",
          enum: ["page", "database"],
          description: SEARCH_PARAMS.filter_object
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
        const limit = normalizeLimit(params.limit);
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
  if (raw.startsWith("~")) return expandHome(raw);
  if (raw.startsWith("/")) return raw;
  return join(PLUGIN_ROOT, raw);
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
  ctx.tools.register(createNotionPageCreateTool({ runNtn: run }));
  ctx.tools.register(createNotionPageEditTool({ runNtn: run }));
  ctx.tools.register(
    createNotionPageTrashTool({ runNtn: run, getDoublecheck: () => ctx.get("doublecheck") })
  );
  ctx.tools.register(createNotionQueryTool({ runNtn: run }));
}
export {
  apply,
  inject,
  name
};
