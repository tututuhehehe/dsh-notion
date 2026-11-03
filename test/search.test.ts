/**
 * notion_search 单测：不碰 PATH 上的 ntn、不联网。
 * runNtn 通过 createNotionSearchTool({ run }) 注入假实现顶替（就是 mock runNtn），
 * 再用 test/fixtures/dsh.ts 按 DSH registry 的方式把 tool 定义挂出来。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildSearchArgs,
  buildSearchBody,
  createNotionSearchTool,
  extractTitle,
  formatOutcome,
  normalizeHit,
  normalizeLimit,
  normalizeQuery,
  parseSearchResponse,
  searchNotion,
  type SearchOutcome,
} from "../src/tools/search.ts";
import type { SearchRunner } from "../src/tools/search.ts";
import type { RunNtnOptions } from "../src/lib/runNtn.ts";
import { mount, text } from "./fixtures/dsh.ts";
import type { MountedTool } from "./fixtures/dsh.ts";

/** Mount the real tool definition the way DSH does, with an injected fake runner. */
function mountWith(runner: SearchRunner): MountedTool<SearchOutcome> {
  const tool = mount(createNotionSearchTool({ run: runner }));
  assert.equal(tool.name, "notion_search");
  return tool;
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
          title: [{ type: "text", plain_text: "设计评审", text: { content: "设计评审" } }],
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
    assert.equal(normalizeQuery("  notion-tools "), "notion-tools");
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
  it("clamps above 50", () => {
    assert.equal(normalizeLimit(50), 50);
    assert.equal(normalizeLimit(51), MAX_LIMIT);
    assert.equal(normalizeLimit(1000), MAX_LIMIT);
  });
  it("rejects <= 0 and non-numeric values", () => {
    assert.throws(() => normalizeLimit(0), /must be >= 1/);
    assert.throws(() => normalizeLimit(-2), /must be >= 1/);
    assert.throws(() => normalizeLimit("abc"), /must be an integer/);
    assert.throws(() => normalizeLimit(Number.NaN), /must be an integer/);
  });
  it("truncates fractions instead of sending them to Notion", () => {
    assert.equal(normalizeLimit(2.9), 2);
  });
  it("accepts a numeric string, like notion_query does", () => {
    assert.equal(normalizeLimit("7"), 7);
  });
  it("clamps above the documented maximum", () => {
    assert.equal(normalizeLimit(999), MAX_LIMIT);
  });
});

describe("buildSearchBody / buildSearchArgs", () => {
  it("sends query + page_size only when no filter is asked", () => {
    const body = buildSearchBody({ query: "notion", limit: 5 });
    assert.deepEqual(body, { query: "notion", page_size: 5 });
    assert.deepEqual(buildSearchArgs(body), ["api", "v1/search", "--data", '{"query":"notion","page_size":5}']);
  });
  it("translates database -> data_source for the API", () => {
    const body = buildSearchBody({ query: "notion", limit: 5, filter_object: "database" });
    assert.deepEqual(body.filter, { property: "object", value: "data_source" });
  });
  it("passes page through as page", () => {
    const body = buildSearchBody({ query: "notion", limit: 5, filter_object: "page" });
    assert.deepEqual(body.filter, { property: "object", value: "page" });
  });
});

describe("extractTitle / normalizeHit", () => {
  it("reads the title property of a page in a data source", () => {
    assert.equal(extractTitle(PAGE_AND_DB.results[0]), "设计评审");
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
    const outcome = await searchNotion({ query: " notion ", limit: 5, filter_object: "page" }, runnerReturning(JSON.stringify(PAGE_AND_DB), calls));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "api",
      "v1/search",
      "--data",
      '{"query":"notion","page_size":5,"filter":{"property":"object","value":"page"}}',
    ]);
    assert.equal(outcome.query, "notion");
    assert.equal(outcome.limit, 5);
    assert.deepEqual(outcome.results.map((hit) => hit.object), ["page", "database"]);
  });

  it("slices overshooting upstream results down to limit", async () => {
    const outcome = await searchNotion({ query: "notion", limit: 1 }, runnerReturning(JSON.stringify(PAGE_AND_DB)));
    assert.equal(outcome.results.length, 1);
  });

  it("surfaces a rejected token with the token-specific hint, not the workspace one", async () => {
    // ntn 的真实文案（不带它自带的 hint 行，确保断言检验的是我们自己的提示逻辑）
    const runner = runnerReturning("", [], {
      ok: false,
      code: 4,
      stderr: "error: Public API request failed: API token is invalid.",
    });
    // The hint wording lives in src/lib/failures.ts (shared by every Notion tool), so this
    // pins WHICH hint is chosen — token, never the workspace advice that would also fire.
    await assert.rejects(() => searchNotion({ query: "notion" }, runner), (error: Error) => {
      assert.match(error.message, /the token was rejected\. Set a valid NOTION_API_TOKEN/);
      assert.doesNotMatch(error.message, /not authenticated yet/);
      return true;
    });
  });

  it("surfaces a missing-workspace error with the login hint", async () => {
    const runner = runnerReturning("", [], {
      ok: false,
      code: 4,
      stderr: "error: No workspace selected.",
    });
    await assert.rejects(() => searchNotion({ query: "notion" }, runner), /not authenticated yet\. Run `ntn login`/);
  });

  it("surfaces an install hint when ntn is not on PATH", async () => {
    const runner = runnerReturning("", [], { ok: false, code: null, stderr: "spawn ntn ENOENT" });
    await assert.rejects(() => searchNotion({ query: "notion" }, runner), /Notion CLI is not installed/);
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
        await searchNotion({ query: "notion" }, runner);
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
      query: "notion",
      limit: 5,
      hasMore: false,
      results: [{ id: "abc", title: "设计评审", url: "https://app.notion.com/p/x", object: "page" }],
    });
    assert.match(text, /1 result\(s\)/);
    assert.match(text, /1\. page · 设计评审/);
    assert.match(text, /id: abc/);
    assert.match(text, /https:\/\/app\.notion\.com\/p\/x/);
  });

  it("explains an empty result set", () => {
    const text = formatOutcome({ query: "zzz", limit: 10, hasMore: false, results: [] });
    assert.match(text, /0 result\(s\)/);
    assert.match(text, /scans TITLES only/);
    // Under token-OR matching, "try a shorter keyword" is actively harmful advice:
    // fewer words means MORE unrelated hits. The message must say the opposite.
    assert.match(text, /EXACT title in double quotes/);
    assert.match(text, /Do NOT simply shorten the query/);
    assert.doesNotMatch(text, /try a shorter keyword/);
  });

  it("tells the model when upstream has more", () => {
    const text = formatOutcome({
      query: "notion",
      limit: 1,
      hasMore: true,
      results: [{ id: "abc", title: "设计评审", url: "https://app.notion.com/p/x", object: "page" }],
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

describe("createNotionSearchTool", () => {
  it("defines notion_search with the documented schema", () => {
    const tool = mountWith(runnerReturning("{}"));
    assert.equal(tool.name, "notion_search");
    assert.deepEqual(tool.parameters.required, ["query"]);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["filter_object", "limit", "query"]);
    assert.equal(tool.parameters.additionalProperties, false);
  });

  // The reported bug: the tool description and the query parameter described matching
  // differently (token-OR vs the old "FUZZY match" wording), so a model read one mental
  // model or the other depending on where it looked. Semantics live in ONE place.
  it("states matching semantics once, in the tool description", () => {
    const tool = mountWith(runnerReturning("{}"));
    assert.match(tool.description, /TOKEN-OR, NOT SUBSTRING/);
    const query = String(tool.parameters.properties.query.description);
    assert.match(query, /See the tool description/);
    assert.doesNotMatch(query, /FUZZY|matches words inside the title/);
  });

  // DSH tool definitions have no per-call preview channel: there is no `onUpdate`, so there is
  // nothing to assert about a "pending" streaming update. The canonical value below is the
  // contract instead (it used to live in `structuredContent`).
  it("executes end-to-end with an injected runner and returns the canonical SearchOutcome", async () => {
    const calls: RunNtnOptions[] = [];
    const tool = mountWith(runnerReturning(JSON.stringify(PAGE_AND_DB), calls));

    const result = await tool.execute("call-1", { query: "notion", limit: 10 });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 3), ["api", "v1/search", "--data"]);
    const expected: SearchOutcome = {
      query: "notion",
      limit: 10,
      hasMore: false,
      results: [
        {
          id: "4077266d-1cb4-8153-8f4e-d5d1a1ba6ec1",
          title: "设计评审",
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
    };
    assert.equal(result.isError, false);
    assert.deepEqual(result.value, expected);
    assert.deepEqual(result.details, expected);
    assert.match(text(result), /2 result\(s\)/);
  });

  it("returns an error result (and does not run ntn) when query is missing", async () => {
    const calls: RunNtnOptions[] = [];
    const tool = mountWith(runnerReturning("{}", calls));
    const result = await tool.execute("call-2", {});
    assert.equal(result.isError, true);
    assert.match(text(result), /non-empty query/);
    assert.equal(calls.length, 0);
  });

  it("rejects limit 0 at the tool boundary", async () => {
    const calls: RunNtnOptions[] = [];
    const tool = mountWith(runnerReturning("{}", calls));
    const result = await tool.execute("call-3", { query: "notion", limit: 0 });
    assert.equal(result.isError, true);
    assert.match(text(result), /must be >= 1/);
    assert.equal(calls.length, 0);
  });
});
