/**
 * notion_search — 工作区标题搜索（底层 `ntn api v1/search`，只经 src/lib/runNtn.ts 起进程）。
 *
 * 对外契约：`{ results: [{ id, title, url, object }] }`。
 * `ntn` 的 JSON 由 runNtn 收集后在这里归一化：模型只看到稳定的小结构，
 * 不用去啃 Notion 原始 page/data_source 对象（那玩意儿一条就上千 token）。
 *
 * 设计要点：
 * - limit 默认 10、上限 50（Notion 的 `page_size` 硬上限是 100；50 是产品取舍）。
 * - `filter_object` 用 `page` / `database` 这套模型熟悉的词；Notion 新版 API 把 database 改叫
 *   data_source，所以只在**发请求时**翻译（`value: "data_source"`），返回里再翻回 `database`。
 * - 依赖注入 runner：单测拿假 runner 顶替 runNtn，不需要 PATH 上的 ntn、不需要真 Notion 账号。
 */
import {
  abortError,
  bindSignal,
  codedError,
  defineNotionTool,
  inputError,
  readEnum,
  readInteger,
  textBlocks,
  TOOL_TIMEOUTS,
} from "../dsh/tool.ts";
import type { NotionTool } from "../dsh/tool.ts";
import { SEARCH_ERRORS } from "../text/errors.ts";
import { SEARCH_PARAMS } from "../text/params.ts";
import { TOOL_DESCRIPTIONS } from "../text/tools.ts";
import { describeFailure, snippet } from "../lib/failures.ts";
import { parseJsonStdout, runNtn } from "../lib/runNtn.ts";
import type { RunNtnOptions, RunNtnResult } from "../lib/runNtn.ts";

export const DEFAULT_LIMIT = 10;
/**
 * Notion `v1/search` accepts `page_size` up to 100. We expose 50: the API's own ceiling
 * would let one call pour 100 hits into the context, and trimming that is a product
 * choice the caller cannot override — so the number is stated in the description instead
 * of being discovered by failing.
 */
export const MAX_LIMIT = 50;
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
    throw inputError(
      SEARCH_ERRORS.emptyQuery
    );
  }
  return value;
}

/** limit：缺省 10，`<= 0` 拒绝，超过 50 夹到 50（Notion 的硬上限是 100） */
export function normalizeLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  // Same tolerance as notion_query: a numeric string or a fraction is a phrasing
  // difference, not a mistake, so it is read and truncated rather than rejected.
  // Only a size no caller means (`<= 0`, non-numeric) is an error.
  return readInteger(limit, `notion_search limit (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`, 1, MAX_LIMIT);
}

/**
 * 组装 `v1/search` 请求体。
 * 只发 Notion 认识的字段：query / page_size / filter（filter 可选，不带就是全工作区）。
 */
export function buildSearchBody(params: { query: string; limit: number; filter_object?: FilterObject }): Record<string, unknown> {
  const body: Record<string, unknown> = { query: params.query, page_size: params.limit };
  if (params.filter_object !== undefined) {
    // Normalize rather than compare to one literal: `"data_source"` is Notion's
    // current name, and the old `=== "database" ? ... : "page"` turned every other
    // value into a page-only search — silently the opposite of what was asked.
    const object = readEnum(params.filter_object, "filter_object", [
      { value: "page" as FilterObject, aliases: ["pages"] },
      { value: "database" as FilterObject, aliases: ["databases", "data_source", "data_sources", "db"] },
    ]);
    body.filter = {
      property: "object",
      // Notion 2025-09 起把 database 改名为 data_source；旧值会被接口判非法。
      value: object === "database" ? "data_source" : "page",
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
// 真正干活：构造 argv -> runNtn -> 归一化
// ---------------------------------------------------------------------------

export async function searchNotion(params: SearchParams, runner: SearchRunner = defaultDeps.run): Promise<SearchOutcome> {
  const query = normalizeQuery(params.query);
  const limit = normalizeLimit(params.limit);
  const body = buildSearchBody({ query, limit, filter_object: params.filter_object });
  const result = await runner({ args: buildSearchArgs(body) });
  // 失败诊断在 src/lib/failures.ts（四个 Notion 工具共用同一套提示）；这里只补工具名前缀，
  // 让模型看到的仍是 "notion_search failed: ntn exit N."。
  if (!result.ok) throw new Error(describeFailure(result, "notion_search failed"));
  const { results, hasMore } = parseSearchResponse(result.stdout);
  return { query, limit, results: results.slice(0, limit), hasMore };
}

/** 模型看到的结果文本：一行一条，标题 + id + url，够直接拿去 notion_get */
export function formatOutcome(outcome: SearchOutcome): string {
  const header = `Notion search "${outcome.query}": ${outcome.results.length} result(s) (limit ${outcome.limit}).`;
  const body =
    outcome.results.length === 0
      ? [
          "No matches. Notion search scans TITLES only (never body text): retry the EXACT title in double quotes, " +
            'e.g. "My Page Title".',
          "Do NOT simply shorten the query: matching is token-OR, so fewer words means MORE unrelated hits, not fewer.",
        ]
      : outcome.results.map((hit, index) => {
          const title = hit.title || "(untitled)";
          const url = hit.url ? `\n   ${hit.url}` : "";
          return `${index + 1}. ${hit.object} · ${title}\n   id: ${hit.id}${url}`;
        });
  // 0 条 + has_more 时不要同时说 "No matches" 和 "More results exist"，那是自相矛盾的
  const footer =
    outcome.hasMore && outcome.results.length > 0
      ? [`More results exist upstream: narrow the query or raise limit (max ${MAX_LIMIT}).`]
      : [];
  return [header, ...body, ...footer].join("\n");
}

/**
 * Build the `notion_search` tool definition.
 * `deps` exists for tests: injecting a fake runner replaces `runNtn` (no PATH lookup, no network).
 */
export function createNotionSearchTool(deps: Partial<SearchDeps> = {}): NotionTool<SearchOutcome> {
  const runner = deps.run ?? defaultDeps.run;

  return defineNotionTool<SearchOutcome>({
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
          description: SEARCH_PARAMS.query,
        },
        limit: {
          type: "integer",
          description: SEARCH_PARAMS.limit({ fallback: DEFAULT_LIMIT, max: MAX_LIMIT }),
        },
        filter_object: {
          type: "string",
          enum: ["page", "database"],
          description: SEARCH_PARAMS.filter_object,
        },
      },
      required: ["query"],
      additionalProperties: false,
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
                object: { type: "string" },
              },
              required: ["id", "title", "url", "object"],
              additionalProperties: false,
            },
          },
          hasMore: { type: "boolean" },
        },
        required: ["query", "limit", "results", "hasMore"],
        additionalProperties: false,
      },
      render: (_args, outcome) => textBlocks(formatOutcome(outcome)),
    },

    async execute(args, exec) {
      const params = args as unknown as SearchParams;
      try {
        // Normalize before anything spawns: dirty arguments must fail without spending a call.
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
    },
  });
}
