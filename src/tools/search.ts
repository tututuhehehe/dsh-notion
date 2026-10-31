/**
 * notion_search — 工作区标题搜索（底层 `ntn api v1/search`，只经 src/lib/runNtn.ts 起进程）。
 *
 * 对外契约：`{ results: [{ id, title, url, object }] }`。
 * `ntn` 的 JSON 由 runNtn 收集后在这里归一化：模型只看到稳定的小结构，
 * 不用去啃 Notion 原始 page/data_source 对象（那玩意儿一条就上千 token）。
 *
 * 设计要点：
 * - limit 默认 10、上限 25（一次 `page_size` 就能覆盖，所以不做翻页；见 AGENTS「out of scope v1」）。
 * - `filter_object` 用 `page` / `database` 这套模型熟悉的词；Notion 新版 API 把 database 改叫
 *   data_source，所以只在**发请求时**翻译（`value: "data_source"`），返回里再翻回 `database`。
 * - 依赖注入 runner：单测拿假 runner 顶替 runNtn，不需要 PATH 上的 ntn、不需要真 Notion 账号。
 */
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { parseJsonStdout, runNtn } from "../lib/runNtn.ts";
import type { RunNtnOptions, RunNtnResult } from "../lib/runNtn.ts";

export const DEFAULT_LIMIT = 10;
/** Notion `v1/search` 的 `page_size` 上限是 100，我们的上限（25）在它之内，一次请求就够。 */
export const MAX_LIMIT = 25;
const SEARCH_PATH = "v1/search";

export type FilterObject = "page" | "database";

/** 一条搜索结果（`object` 是 `page` 或 `database`） */
export type SearchHit = {
  id: string;
  /**
   * 匹配到的标题。没标题时是空字符串（真实标题就是空），不是 "(untitled)" ——
   * 机器可读字段不乱编，只在给模型看的文本里才渲染成 "(untitled)"。
   */
  title: string;
  url: string;
  object: string;
};

export type SearchParams = {
  query: string;
  limit?: number;
  filter_object?: FilterObject;
};

/** `details`：本次调用的形态（UI/日志用），`pending` 只在 onUpdate 预览里为 true */
export type SearchDetails = {
  query: string;
  limit: number;
  filter_object?: FilterObject;
  count: number;
  pending?: boolean;
};

export type SearchOutcome = {
  query: string;
  limit: number;
  results: SearchHit[];
  /** 上游说还有更多（本次没取；limit 已经卡在 MAX_LIMIT 内） */
  hasMore: boolean;
};

/** runNtn 的最小形状：单测注入假实现，生产就是 runNtn 本身 */
export type SearchRunner = (options: RunNtnOptions) => Promise<RunNtnResult>;

export type SearchDeps = { run: SearchRunner };

const defaultDeps: SearchDeps = { run: runNtn };

// ---------------------------------------------------------------------------
// 参数归一化：模型给的脏值在这里变成确定值，绝不透传给 ntn
// ---------------------------------------------------------------------------

/**
 * query 必填。空白串要报**明确**的错：schema 校验失败时模型只看到 "参数非法"，
 * 分不清是漏了 query 还是别的问题（Notion 搜索只匹配标题，这点也要说）。
 */
export function normalizeQuery(query: unknown): string {
  const value = typeof query === "string" ? query.trim() : "";
  if (!value) {
    throw new Error(
      "notion_search requires a non-empty query: pass a keyword. Notion search matches titles " +
        "(page/database names), not page body text."
    );
  }
  return value;
}

/** limit：缺省 10，`<= 0` 直接拒绝，超过 25 夹到 25（不静默放大到 Notion 的 100） */
export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
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

/**
 * 组装 `v1/search` 请求体。
 * 只发 Notion 认识的字段：query / page_size / filter（filter 可选，不带就是全工作区）。
 */
export function buildSearchBody(params: { query: string; limit: number; filter_object?: FilterObject }): Record<string, unknown> {
  const body: Record<string, unknown> = { query: params.query, page_size: params.limit };
  if (params.filter_object) {
    body.filter = {
      property: "object",
      // Notion 2025-09 起把 database 改名为 data_source；旧值会被接口判非法。
      value: params.filter_object === "database" ? "data_source" : "page",
    };
  }
  return body;
}

/** ntn 的 argv（**只**是 argv，没有 shell 拼接；模型永远碰不到自由命令） */
export function buildSearchArgs(body: Record<string, unknown>): string[] {
  return ["api", SEARCH_PATH, "--data", JSON.stringify(body)];
}

// ---------------------------------------------------------------------------
// 响应归一化
// ---------------------------------------------------------------------------

/** rich text 数组 -> 纯文本（Notion 的 title 是 [{plain_text, text:{content}, ...}]） */
function plainText(rich: unknown): string {
  if (typeof rich === "string") return rich;
  if (!Array.isArray(rich)) return "";
  let text = "";
  for (const item of rich) {
    if (typeof item === "string") {
      text += item;
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as { plain_text?: unknown; text?: { content?: unknown } };
    if (typeof record.plain_text === "string") text += record.plain_text;
    else if (typeof record.text?.content === "string") text += record.text.content;
  }
  return text;
}

/**
 * 取标题。两条路径都要走：
 * - 在 data source 里的 page：标题在 `properties[<title 名>].title`（属性名各库不同，按 `type === "title"` 找）
 * - data source 本身：标题是顶层的 `title` 数组
 * 不在 data source 里的 page 两种形状都可能出现，所以先 properties 再顶层，都取不到就留空。
 */
export function extractTitle(object: Record<string, unknown>): string {
  const properties = object.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const value of Object.values(properties as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const property = value as { type?: unknown; title?: unknown };
      // data source 的 properties 是**schema**（title 配置是空对象），这里自然取不到文本
      if (property.type !== "title") continue;
      const text = plainText(property.title).trim();
      if (text) return text;
    }
  }
  return plainText(object.title).trim();
}

/** 单条结果 -> SearchHit；没有 id 的脏数据直接丢掉（拿去做 notion_get 也没法用） */
export function normalizeHit(raw: unknown): SearchHit | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const object = raw as Record<string, unknown>;
  const id = typeof object.id === "string" ? object.id : "";
  if (!id) return null;
  const rawObject = typeof object.object === "string" ? object.object : "";
  return {
    id,
    title: extractTitle(object),
    url: typeof object.url === "string" ? object.url : "",
    // 对外统一用 page / database（与 filter_object 同一套词），未知值原样保留
    object: rawObject === "data_source" ? "database" : rawObject || "unknown",
  };
}

/** ntn 输出里带点噪音时也别把整坨塞进错误消息 */
function snippet(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "<empty>";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

export function parseSearchResponse(stdout: string): { results: SearchHit[]; hasMore: boolean } {
  let payload: unknown;
  try {
    payload = parseJsonStdout(stdout);
  } catch {
    throw new Error(`notion_search could not parse ntn output as JSON: ${snippet(stdout)}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`notion_search got unexpected ntn output: ${snippet(stdout)}`);
  }
  const record = payload as Record<string, unknown>;
  // results 缺失 = 合法的空列表（Notion 总是给数组）；给了个非数组 = 契约变了，必须报错，
  // 否则模型会被告知 "No matches"，然后去改查询而不是发现工具挂了。
  if (record.results !== undefined && !Array.isArray(record.results)) {
    throw new Error(`notion_search got unexpected ntn output (results is not an array): ${snippet(stdout)}`);
  }
  const rawResults = Array.isArray(record.results) ? record.results : [];
  const results = rawResults
    .map((item) => normalizeHit(item))
    .filter((hit): hit is SearchHit => hit !== null);
  return { results, hasMore: record.has_more === true };
}

// ---------------------------------------------------------------------------
// 失败文案：ntn 的错误本身够具体，但"没装"和"没登录"必须给出可执行动作
// ---------------------------------------------------------------------------

const FAILURE_HINTS: Array<{ match: RegExp; hint: string }> = [
  {
    match: /not found on PATH|ENOENT/i,
    hint: "Hint: install the Notion CLI with `npm i -g ntn` (or `curl -fsSL https://ntn.dev | bash`), then run `ntn login`.",
  },
  // token 那条必须排在 workspace 之前：ntn 的 token 错误文案里**也**带 "run `ntn login`"，
  // 顺序反过来就会被 workspace 提示吞掉，而且 workspace 提示并不解决无效 token。
  {
    match: /api token is invalid|unauthorized|\b401\b/i,
    hint: "Hint: the token was rejected — set a valid NOTION_API_TOKEN or run `ntn login`, and make sure the target pages/databases are shared with that integration.",
  },
  {
    match: /no workspace selected|not logged in|not authenticated/i,
    hint: "Hint: authenticate first — run `ntn login`, or set NOTION_API_TOKEN (plus NOTION_WORKSPACE_ID). Then share the target pages/databases with that integration.",
  },
];

export function describeFailure(result: RunNtnResult): string {
  const stderr = result.stderr.trim();
  const status = result.code === null ? "no exit code (timed out or could not start)" : `exit ${result.code}`;
  const hint = FAILURE_HINTS.find((entry) => entry.match.test(stderr))?.hint;
  // stderr 也要截断：API 报错体/栈可能很长，别整坨塞进模型上下文
  const detail = stderr ? snippet(stderr) : "ntn printed no error text.";
  return [`notion_search failed: ntn ${status}.`, detail, hint].filter((part): part is string => Boolean(part)).join("\n");
}

// ---------------------------------------------------------------------------
// 真正干活：构造 argv -> runNtn -> 归一化
// ---------------------------------------------------------------------------

export async function searchNotion(params: SearchParams, runner: SearchRunner = defaultDeps.run): Promise<SearchOutcome> {
  const query = normalizeQuery(params.query);
  const limit = normalizeLimit(params.limit);
  const body = buildSearchBody({ query, limit, filter_object: params.filter_object });
  const result = await runner({ args: buildSearchArgs(body) });
  if (!result.ok) throw new Error(describeFailure(result));
  const { results, hasMore } = parseSearchResponse(result.stdout);
  return { query, limit, results: results.slice(0, limit), hasMore };
}

/** 模型看到的结果文本：一行一条，标题 + id + url，够直接拿去 notion_get */
export function formatOutcome(outcome: SearchOutcome): string {
  const header = `Notion search "${outcome.query}": ${outcome.results.length} result(s) (limit ${outcome.limit}).`;
  const body =
    outcome.results.length === 0
      ? ["No matches. Notion search matches titles only — try a shorter keyword or another language of the title."]
      : outcome.results.map((hit, index) => {
          const title = hit.title || "(untitled)";
          const url = hit.url ? `\n   ${hit.url}` : "";
          return `${index + 1}. ${hit.object} · ${title}\n   id: ${hit.id}${url}`;
        });
  // 0 条 + has_more 时不要同时说 "No matches" 和 "More results exist"，那是自相矛盾的
  const footer =
    outcome.hasMore && outcome.results.length > 0
      ? ["More results exist upstream: narrow the query or raise limit (max 25)."]
      : [];
  return [header, ...body, ...footer].join("\n");
}

/**
 * 注册 notion_search。
 * `deps` 只给单测用：注入假 runner 就等于 mock 掉了 runNtn（不碰 PATH、不联网）。
 */
export function registerNotionSearch(pi: ExtensionAPI, deps: Partial<SearchDeps> = {}): void {
  const runner = deps.run ?? defaultDeps.run;

  pi.registerTool({
    name: "notion_search",
    label: "Notion Search",
    description:
      "Search the Notion workspace by title through the official `ntn` CLI. Returns id, title, URL and " +
      "object type (page|database) for each hit. This finds objects only: read a page's content with " +
      "notion_get, and filter/sort rows of a returned database with notion_query.",
    promptSnippet:
      "Search Notion by title: id/title/url/object per hit, optional page-vs-database filter (limit 10, max 25)",
    promptGuidelines: [
      "Notion search matches titles only (page and database names), not page body text — pass a short keyword, not a sentence.",
      "Use filter_object:'page' or 'database' to cut noise; a returned database's id is a data source id for notion_query.",
      "Results are already limited: refine the query instead of raising limit, which is capped at 25.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Title keyword to match, searched verbatim (not full-text page search)." }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: `Max results (default ${DEFAULT_LIMIT}). Values above ${MAX_LIMIT} are clamped to ${MAX_LIMIT}.`,
        })
      ),
      filter_object: Type.Optional(
        Type.Union([Type.Literal("page"), Type.Literal("database")], {
          description: "Restrict hits to pages or databases (data sources). Omit to search both.",
        })
      ),
    }),
    outputSchema: Type.Object({
      results: Type.Array(
        Type.Object({
          id: Type.String(),
          title: Type.String(),
          url: Type.String(),
          object: Type.String(),
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, onUpdate): Promise<AgentToolResult<SearchDetails>> {
      // 先归一化再发 onUpdate：脏参数要在花钱/起进程之前失败
      const query = normalizeQuery(params.query);
      const limit = normalizeLimit(params.limit);

      onUpdate?.({
        content: [{ type: "text", text: `Searching Notion: ${query}` }],
        details: { query, limit, filter_object: params.filter_object, count: 0, pending: true },
      });

      const outcome = await searchNotion({ query, limit, filter_object: params.filter_object }, runner);
      return {
        content: [{ type: "text", text: formatOutcome(outcome) }],
        details: { query: outcome.query, limit: outcome.limit, filter_object: params.filter_object, count: outcome.results.length },
        structuredContent: { results: outcome.results },
      };
    },
  });
}
