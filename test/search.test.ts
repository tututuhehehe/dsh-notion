/**
 * notion_search 单测：不碰 PATH 上的 ntn、不联网。
 * runNtn 通过 registerNotionSearch(pi, { run }) 注入假实现顶替（就是 mock runNtn）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildSearchArgs,
  buildSearchBody,
  extractTitle,
  formatOutcome,
  normalizeHit,
  normalizeLimit,
  normalizeQuery,
  parseSearchResponse,
  registerNotionSearch,
  searchNotion,
} from "../src/tools/search.ts";
import type { SearchRunner } from "../src/tools/search.ts";
import type { RunNtnOptions } from "../src/lib/runNtn.ts";

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: { required?: string[]; properties: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: {
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown>;
    }) => void
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
    structuredContent?: unknown;
  }>;
};

/** 假 pi：只实现 registerTool（扩展只用到这一个 API） */
function fakePi(): { pi: Parameters<typeof registerNotionSearch>[0]; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool);
    },
  } as unknown as Parameters<typeof registerNotionSearch>[0];
  return { pi, tools };
}

function registerWith(runner: SearchRunner): RegisteredTool {
  const { pi, tools } = fakePi();
  registerNotionSearch(pi, { run: runner });
  assert.equal(tools.length, 1);
  return tools[0];
}

/** 记录 argv，并返回固定 stdout */
function runnerReturning(stdout: string, calls: RunNtnOptions[] = [], extra: Partial<{ ok: boolean; stderr: string; code: number | null }> = {}): SearchRunner {
  return async (options) => {
    calls.push(options);
    return {
      ok: extra.ok ?? true,
      stdout,
      stderr: extra.stderr ?? "",
      code: extra.code ?? 0,
    };
  };
}

const PAGE_AND_DB = {
  object: "list",
  results: [
    {
      object: "page",
      id: "4077266d-1cb4-8153-8f4e-d5d1a1ba6ec1",
      url: "https://app.notion.com/p/4077266d1cb481538f4ed5d1a1ba6ec1",
      properties: {
        Name: {
          id: "title",
          type: "title",
          title: [{ type: "text", plain_text: "Pi 设计", text: { content: "Pi 设计" } }],
        },
        Status: { id: "st", type: "status", status: { name: "Done" } },
      },
    },
    {
      object: "data_source",
      id: "716f546f-1824-45f0-b73a-481bf8b5f5db",
      url: "https://app.notion.com/p/2f14f95bc14a49859b9d71d43663559a",
      title: [{ type: "text", plain_text: "测试库" }],
      properties: { Name: { id: "title", type: "title", title: {} } },
    },
  ],
  has_more: false,
  next_cursor: null,
};

describe("normalizeQuery", () => {
  it("trims a real query", () => {
    assert.equal(normalizeQuery("  pi-notion "), "pi-notion");
  });
  it("rejects missing / blank query with a clear message", () => {
    assert.throws(() => normalizeQuery(""), /non-empty query/);
    assert.throws(() => normalizeQuery("   "), /non-empty query/);
    assert.throws(() => normalizeQuery(undefined), /non-empty query/);
  });
});

describe("normalizeLimit", () => {
  it("defaults to 10", () => {
    assert.equal(normalizeLimit(undefined), DEFAULT_LIMIT);
  });
  it("clamps above 25", () => {
    assert.equal(normalizeLimit(25), 25);
    assert.equal(normalizeLimit(26), MAX_LIMIT);
    assert.equal(normalizeLimit(1000), MAX_LIMIT);
  });
  it("rejects <= 0 and non-numbers", () => {
    assert.throws(() => normalizeLimit(0), /must be >= 1/);
    assert.throws(() => normalizeLimit(-2), /must be >= 1/);
    assert.throws(() => normalizeLimit(Number.NaN), /positive integer/);
  });
  it("truncates fractions instead of sending them to Notion", () => {
    assert.equal(normalizeLimit(2.9), 2);
  });
});

describe("buildSearchBody / buildSearchArgs", () => {
  it("sends query + page_size only when no filter is asked", () => {
    const body = buildSearchBody({ query: "pi", limit: 5 });
    assert.deepEqual(body, { query: "pi", page_size: 5 });
    assert.deepEqual(buildSearchArgs(body), ["api", "v1/search", "--data", '{"query":"pi","page_size":5}']);
  });
  it("translates database -> data_source for the API", () => {
    const body = buildSearchBody({ query: "pi", limit: 5, filter_object: "database" });
    assert.deepEqual(body.filter, { property: "object", value: "data_source" });
  });
  it("passes page through as page", () => {
    const body = buildSearchBody({ query: "pi", limit: 5, filter_object: "page" });
    assert.deepEqual(body.filter, { property: "object", value: "page" });
  });
});

describe("extractTitle / normalizeHit", () => {
  it("reads the title property of a page in a data source", () => {
    assert.equal(extractTitle(PAGE_AND_DB.results[0]), "Pi 设计");
  });
  it("reads the top-level title of a database (data source)", () => {
    assert.equal(extractTitle(PAGE_AND_DB.results[1]), "测试库");
  });
  it("returns an empty title when there is none", () => {
    assert.equal(extractTitle({ object: "page", id: "x" }), "");
  });
  it("maps data_source -> database and keeps page", () => {
    assert.deepEqual(normalizeHit(PAGE_AND_DB.results[1]), {
      id: "716f546f-1824-45f0-b73a-481bf8b5f5db",
      title: "测试库",
      url: "https://app.notion.com/p/2f14f95bc14a49859b9d71d43663559a",
      object: "database",
    });
    assert.equal(normalizeHit(PAGE_AND_DB.results[0])?.object, "page");
  });
  it("drops junk without an id", () => {
    assert.equal(normalizeHit(null), null);
    assert.equal(normalizeHit("nope"), null);
    assert.equal(normalizeHit({ object: "page" }), null);
  });
});

describe("parseSearchResponse", () => {
  it("normalizes results and has_more", () => {
    const parsed = parseSearchResponse(JSON.stringify(PAGE_AND_DB));
    assert.equal(parsed.results.length, 2);
    assert.equal(parsed.hasMore, false);
  });
  it("returns no results for an empty list", () => {
    assert.deepEqual(parseSearchResponse('{"object":"list","results":[]}'), { results: [], hasMore: false });
  });
  it("reports has_more", () => {
    const parsed = parseSearchResponse('{"object":"list","results":[],"has_more":true}');
    assert.equal(parsed.hasMore, true);
  });
  it("throws when results is present but not an array", () => {
    assert.throws(
      () => parseSearchResponse('{"object":"list","results":{"hits":[]}}'),
      /results is not an array/
    );
  });
  it("rejects non-JSON output readably", () => {
    assert.throws(() => parseSearchResponse("error: something went wrong"), /could not parse ntn output as JSON/);
  });
});

describe("searchNotion", () => {
  it("calls ntn api v1/search with the JSON body and returns hits", async () => {
    const calls: RunNtnOptions[] = [];
    const outcome = await searchNotion({ query: " pi ", limit: 5, filter_object: "page" }, runnerReturning(JSON.stringify(PAGE_AND_DB), calls));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "api",
      "v1/search",
      "--data",
      '{"query":"pi","page_size":5,"filter":{"property":"object","value":"page"}}',
    ]);
    assert.equal(outcome.query, "pi");
    assert.equal(outcome.limit, 5);
    assert.deepEqual(outcome.results.map((hit) => hit.object), ["page", "database"]);
  });

  it("slices overshooting upstream results down to limit", async () => {
    const outcome = await searchNotion({ query: "pi", limit: 1 }, runnerReturning(JSON.stringify(PAGE_AND_DB)));
    assert.equal(outcome.results.length, 1);
  });

  it("surfaces a rejected token with the token-specific hint, not the workspace one", async () => {
    // ntn 的真实文案（不带它自带的 hint 行，确保断言检验的是我们自己的提示逻辑）
    const runner = runnerReturning("", [], {
      ok: false,
      code: 4,
      stderr: "error: Public API request failed: API token is invalid.",
    });
    await assert.rejects(
      () => searchNotion({ query: "pi" }, runner),
      /the token was rejected — set a valid NOTION_API_TOKEN/
    );
  });

  it("surfaces a missing-workspace error with the login hint", async () => {
    const runner = runnerReturning("", [], {
      ok: false,
      code: 4,
      stderr: "error: No workspace selected.",
    });
    await assert.rejects(() => searchNotion({ query: "pi" }, runner), /authenticate first/);
  });

  it("surfaces an install hint when ntn is not on PATH", async () => {
    const runner = runnerReturning("", [], { ok: false, code: null, stderr: "spawn ntn ENOENT" });
    await assert.rejects(() => searchNotion({ query: "pi" }, runner), /install the Notion CLI/);
  });

  it("fails before spawning ntn when query is blank", async () => {
    const calls: RunNtnOptions[] = [];
    await assert.rejects(() => searchNotion({ query: "  " }, runnerReturning("{}", calls)), /non-empty query/);
    assert.equal(calls.length, 0);
  });

  it("keeps a flag-looking query inside the JSON body, never as an argv flag", async () => {
    const calls: RunNtnOptions[] = [];
    await searchNotion({ query: "--force -d /etc/passwd" }, runnerReturning(JSON.stringify(PAGE_AND_DB), calls));
    assert.equal(calls[0].args.length, 4);
    assert.deepEqual(calls[0].args.slice(0, 3), ["api", "v1/search", "--data"]);
    assert.equal(JSON.parse(calls[0].args[3]).query, "--force -d /etc/passwd");
  });

  it("truncates a huge stderr dump instead of pasting it into context", async () => {
    const runner = runnerReturning("", [], { ok: false, code: 500, stderr: `boom ${"x".repeat(5000)}` });
    await assert.rejects(async () => {
      try {
        await searchNotion({ query: "pi" }, runner);
      } catch (error) {
        const message = (error as Error).message;
        assert.ok(message.length < 400, `message too long: ${message.length}`);
        assert.match(message, /…$/);
        throw error;
      }
    }, /boom/);
  });
});

describe("formatOutcome", () => {
  it("lists hits with object, title, id and url", () => {
    const text = formatOutcome({
      query: "pi",
      limit: 5,
      hasMore: false,
      results: [{ id: "abc", title: "Pi 设计", url: "https://app.notion.com/p/x", object: "page" }],
    });
    assert.match(text, /1 result\(s\)/);
    assert.match(text, /1\. page · Pi 设计/);
    assert.match(text, /id: abc/);
    assert.match(text, /https:\/\/app\.notion\.com\/p\/x/);
  });

  it("explains an empty result set", () => {
    const text = formatOutcome({ query: "zzz", limit: 10, hasMore: false, results: [] });
    assert.match(text, /0 result\(s\)/);
    assert.match(text, /matches titles only/);
  });

  it("tells the model when upstream has more", () => {
    const text = formatOutcome({
      query: "pi",
      limit: 1,
      hasMore: true,
      results: [{ id: "abc", title: "Pi 设计", url: "https://app.notion.com/p/x", object: "page" }],
    });
    assert.match(text, /1 result\(s\)/);
    assert.match(text, /More results exist upstream/);
  });

  it("does not pair 'No matches' with the has_more footer", () => {
    const text = formatOutcome({ query: "zzz", limit: 10, hasMore: true, results: [] });
    assert.match(text, /No matches/);
    assert.doesNotMatch(text, /More results exist upstream/);
  });
});

describe("registerNotionSearch", () => {
  it("registers notion_search with the documented schema", () => {
    const tool = registerWith(runnerReturning("{}"));
    assert.equal(tool.name, "notion_search");
    assert.equal(tool.label, "Notion Search");
    assert.deepEqual(tool.parameters.required, ["query"]);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["filter_object", "limit", "query"]);
  });

  it("executes end-to-end with an injected runner and returns structuredContent", async () => {
    const calls: RunNtnOptions[] = [];
    const tool = registerWith(runnerReturning(JSON.stringify(PAGE_AND_DB), calls));

    const updates: Array<{ text: string; details: Record<string, unknown> }> = [];
    const result = await tool.execute("call-1", { query: "pi", limit: 10 }, undefined, (update) => {
      updates.push({ text: update.content[0].text, details: update.details });
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 3), ["api", "v1/search", "--data"]);
    assert.match(updates[0].text, /Searching Notion: pi/);
    assert.equal(updates[0].details.pending, true);
    assert.equal(updates[0].details.count, 0);
    assert.deepEqual(result.structuredContent, {
      results: [
        {
          id: "4077266d-1cb4-8153-8f4e-d5d1a1ba6ec1",
          title: "Pi 设计",
          url: "https://app.notion.com/p/4077266d1cb481538f4ed5d1a1ba6ec1",
          object: "page",
        },
        {
          id: "716f546f-1824-45f0-b73a-481bf8b5f5db",
          title: "测试库",
          url: "https://app.notion.com/p/2f14f95bc14a49859b9d71d43663559a",
          object: "database",
        },
      ],
    });
    assert.equal(result.details.count, 2);
    assert.match(result.content[0].text, /2 result\(s\)/);
  });

  it("throws a clear error (and does not run ntn) when query is missing", async () => {
    const calls: RunNtnOptions[] = [];
    const tool = registerWith(runnerReturning("{}", calls));
    await assert.rejects(() => tool.execute("call-2", {}), /non-empty query/);
    assert.equal(calls.length, 0);
  });

  it("rejects limit 0 at the tool boundary", async () => {
    const calls: RunNtnOptions[] = [];
    const tool = registerWith(runnerReturning("{}", calls));
    await assert.rejects(() => tool.execute("call-3", { query: "pi", limit: 0 }), /limit must be >= 1/);
    assert.equal(calls.length, 0);
  });
});
