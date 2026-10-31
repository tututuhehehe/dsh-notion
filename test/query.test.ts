import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_QUERY_LIMIT,
  createNotionQueryTool,
  parseQueryResponse,
  parseResolveDataSources,
  queryDataSource,
  type QueryInputError,
  type QueryResult,
  type RunNtnFn,
} from "../src/tools/query.ts";
import type { RunNtnResult } from "../src/lib/runNtn.ts";
import { mount, text } from "./fixtures/dsh.ts";
import type { MountedTool } from "./fixtures/dsh.ts";
import {
  ACCEPTANCE,
  ACCEPTANCE_DATABASE_ID,
  DATA_SOURCE_SCHEMA,
  SELF_RELATION_SCHEMA,
} from "./fixtures/notion.ts";

type Call = { args: string[] };

function ok(stdout: string): RunNtnResult {
  return { ok: true, stdout, stderr: "", code: 0 };
}

function fail(stderr: string, code = 1): RunNtnResult {
  return { ok: false, stdout: "", stderr, code };
}

function listResponse(
  results: unknown[],
  extra: { next_cursor?: string | null; has_more?: boolean } = {}
): string {
  return JSON.stringify({
    object: "list",
    results,
    next_cursor: extra.next_cursor ?? null,
    has_more: extra.has_more ?? false,
  });
}

/** Fake ntn that records argv and returns queued responses. */
function fakeRunner(responses: RunNtnResult[]): { run: RunNtnFn; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const run: RunNtnFn = async ({ args }) => {
    calls.push({ args });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected ntn call: ${args.join(" ")}`);
    return next;
  };
  return { run, calls };
}

/** Mount the real notion_query definition the way DSH does, with an injected fake runner. */
function registeredTool(run: RunNtnFn): MountedTool<QueryResult> {
  const tool = mount(createNotionQueryTool({ runNtn: run }));
  assert.equal(tool.name, "notion_query");
  return tool;
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function allArgValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) values.push(args[i + 1]);
  }
  return values;
}

const ROW = {
  object: "page",
  id: "page-1",
  url: "https://www.notion.so/page-1",
  properties: { Name: { title: [{ plain_text: "Task" }] } },
  created_time: "2026-01-01T00:00:00.000Z",
};

describe("notion_query registration", () => {
  it("registers the tool with its schema", () => {
    const tool = registeredTool(fakeRunner([]).run);
    assert.equal(tool.name, "notion_query");
    assert.equal(tool.parameters.properties.database_or_data_source.type, "string");
    assert.ok(tool.parameters.properties.limit);
    assert.ok(tool.parameters.properties.start_cursor);
    assert.ok(tool.parameters.properties.filter);
    assert.ok(tool.parameters.properties.sort);
    assert.ok(tool.parameters.properties.include_content);
    assert.equal(tool.parameters.additionalProperties, false);
  });

  it("returns JSON content and matching details", async () => {
    const { run } = fakeRunner([ok(listResponse([ROW], { next_cursor: "c2", has_more: true }))]);
    const tool = registeredTool(run);
    const result = await tool.execute("call-1", { database_or_data_source: "ds-1" });
    const payload = JSON.parse(result.content[0].text);
    assert.deepEqual(payload, {
      results: [{ id: "page-1", url: "https://www.notion.so/page-1", properties: ROW.properties }],
      next_cursor: "c2",
      has_more: true,
    });
    assert.deepEqual(result.details, payload);
  });
});

describe("notion_query parameters", () => {
  it("defaults limit to 25", async () => {
    const { run, calls } = fakeRunner([ok(listResponse([]))]);
    await queryDataSource({ database_or_data_source: "ds-1" }, run);
    assert.equal(argValue(calls[0].args, "--limit"), "25");
  });

  it("clamps limit above 100", async () => {
    const { run, calls } = fakeRunner([ok(listResponse([]))]);
    await queryDataSource({ database_or_data_source: "ds-1", limit: 500 }, run);
    assert.equal(argValue(calls[0].args, "--limit"), String(MAX_QUERY_LIMIT));
    assert.equal(MAX_QUERY_LIMIT, 100);
  });

  it("rejects limit <= 0", async () => {
    for (const limit of [0, -1]) {
      const { run } = fakeRunner([]);
      await assert.rejects(
        () => queryDataSource({ database_or_data_source: "ds-1", limit }, run),
        /greater than 0/
      );
    }
  });

  it("rejects a non-integer limit", async () => {
    const { run } = fakeRunner([]);
    await assert.rejects(
      () => queryDataSource({ database_or_data_source: "ds-1", limit: 2.5 }, run),
      /integer/
    );
  });

  it("omits start_cursor when absent, empty, or null", async () => {
    for (const start_cursor of [undefined, "", "   ", null]) {
      const { run, calls } = fakeRunner([ok(listResponse([]))]);
      await queryDataSource({ database_or_data_source: "ds-1", start_cursor }, run);
      assert.equal(argValue(calls[0].args, "--start-cursor"), undefined);
    }
  });

  it("rejects an empty database_or_data_source", async () => {
    const { run } = fakeRunner([]);
    await assert.rejects(
      () => queryDataSource({ database_or_data_source: "   " }, run),
      /non-empty/
    );
  });

  it("rejects a non-object filter", async () => {
    const { run } = fakeRunner([]);
    await assert.rejects(
      () =>
        queryDataSource(
          { database_or_data_source: "ds-1", filter: [] as unknown as Record<string, unknown> },
          run
        ),
      /filter must be/
    );
  });

  it("passes start_cursor through", async () => {
    const { run, calls } = fakeRunner([ok(listResponse([]))]);
    await queryDataSource({ database_or_data_source: "ds-1", start_cursor: " cursor-2 " }, run);
    assert.equal(argValue(calls[0].args, "--start-cursor"), "cursor-2");
  });

  it("passes filter JSON through verbatim", async () => {
    const filter = {
      and: [
        { property: "Done", checkbox: { equals: true } },
        { property: "标签", multi_select: { contains: "api" } },
      ],
    };
    const { run, calls } = fakeRunner([ok(listResponse([]))]);
    await queryDataSource({ database_or_data_source: "ds-1", filter }, run);
    const raw = argValue(calls[0].args, "--filter");
    if (raw === undefined) throw new Error("expected a --filter argument");
    assert.deepEqual(JSON.parse(raw), filter);
  });

  it("accepts one sort string or an ordered array", async () => {
    const single = fakeRunner([ok(listResponse([]))]);
    await queryDataSource({ database_or_data_source: "ds-1", sort: "Name desc" }, single.run);
    assert.deepEqual(allArgValues(single.calls[0].args, "--sort"), ["Name desc"]);

    const multiple = fakeRunner([ok(listResponse([]))]);
    await queryDataSource(
      { database_or_data_source: "ds-1", sort: ["Status asc", "截止日期 desc"] },
      multiple.run
    );
    assert.deepEqual(allArgValues(multiple.calls[0].args, "--sort"), [
      "Status asc",
      "截止日期 desc",
    ]);
  });

  it("rejects blank sort entries", async () => {
    const { run } = fakeRunner([]);
    await assert.rejects(
      () => queryDataSource({ database_or_data_source: "ds-1", sort: ["Name asc", "  "] }, run),
      /non-empty/
    );
  });

  it("uses ntn datasources query --json", async () => {
    const { run, calls } = fakeRunner([ok(listResponse([]))]);
    await queryDataSource({ database_or_data_source: "https://notion.so/db?v=1" }, run);
    assert.deepEqual(calls[0].args.slice(0, 4), [
      "datasources",
      "query",
      "https://notion.so/db?v=1",
      "--limit",
    ]);
    assert.ok(calls[0].args.includes("--json"));
  });
});

describe("notion_query result normalization", () => {
  it("keeps id/url/properties and drops other page fields", () => {
    const parsed = parseQueryResponse(JSON.parse(listResponse([ROW])), "ds-1");
    assert.deepEqual(parsed.results, [
      { id: "page-1", url: "https://www.notion.so/page-1", properties: ROW.properties },
    ]);
  });

  it("handles a bare results array", () => {
    const parsed = parseQueryResponse([ROW], "ds-1");
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.has_more, false);
    assert.equal(parsed.next_cursor, null);
  });

  it("derives has_more from next_cursor when the flag is missing", () => {
    const parsed = parseQueryResponse({ results: [], next_cursor: "cursor-2" }, "ds-1");
    assert.equal(parsed.next_cursor, "cursor-2");
    assert.equal(parsed.has_more, true);

    assert.equal(
      parseQueryResponse({ results: [], next_cursor: null, has_more: false }, "ds-1").has_more,
      false
    );
  });

  it("rejects rows without an id", () => {
    assert.throws(
      () => parseQueryResponse({ results: [{ url: "https://x" }] }, "ds-1"),
      /without an id/
    );
  });

  it("rejects a malformed JSON response", async () => {
    const { run } = fakeRunner([ok("not json")]);
    await assert.rejects(
      () => queryDataSource({ database_or_data_source: "ds-1" }, run),
      /Could not parse/
    );
  });
});

describe("notion_query database resolution", () => {
  it("errors with the data source ids when a database has several", async () => {
    const { run, calls } = fakeRunner([
      fail("database has multiple data sources"),
      ok(
        JSON.stringify({
          database_id: "db-1",
          data_sources: [
            { id: "ds-1", name: "Tasks" },
            { id: "ds-2", name: "Archive" },
          ],
        })
      ),
    ]);
    await assert.rejects(
      () => queryDataSource({ database_or_data_source: "db-1" }, run),
      (error: Error) => {
        assert.match(error.message, /2 data sources/);
        assert.match(error.message, /ds-1 \(Tasks\)/);
        assert.match(error.message, /ds-2 \(Archive\)/);
        return true;
      }
    );
    // No blind retry with the first data source.
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args, ["datasources", "resolve", "db-1", "--json"]);
  });

  it("retries with the single resolved data source", async () => {
    const { run, calls } = fakeRunner([
      fail("could not resolve database"),
      ok(JSON.stringify({ data_sources: [{ id: "ds-only", name: "Only" }] })),
      ok(listResponse([ROW])),
    ]);
    const result = await queryDataSource({ database_or_data_source: "db-1" }, run);
    assert.equal(result.results.length, 1);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].args[2], "ds-only");
    assert.ok(calls[2].args.includes("--json"));
  });

  it("surfaces the original query failure when resolution finds nothing", async () => {
    const { run } = fakeRunner([
      fail("integration cannot access database"),
      fail("resolve failed"),
    ]);
    await assert.rejects(
      () => queryDataSource({ database_or_data_source: "db-1" }, run),
      /integration cannot access database/
    );
  });

  it("surfaces the original query failure when resolve output is unparseable", async () => {
    const { run } = fakeRunner([fail("original failure"), ok("not json")]);
    await assert.rejects(
      () => queryDataSource({ database_or_data_source: "db-1" }, run),
      /original failure/
    );
  });

  it("does not retry a query that already targeted that data source", async () => {
    const { run, calls } = fakeRunner([
      fail("insufficient permissions"),
      ok(JSON.stringify({ data_sources: [{ id: "ds-1", name: "Tasks" }] })),
    ]);
    await assert.rejects(
      () => queryDataSource({ database_or_data_source: "ds-1" }, run),
      (error: Error) => {
        assert.match(error.message, /insufficient permissions/);
        assert.doesNotMatch(error.message, /retry with data source/);
        return true;
      }
    );
    assert.equal(calls.length, 2);
  });

  it("reports both failures when the single-data-source retry also fails", async () => {
    const { run } = fakeRunner([
      fail("original query failure"),
      ok(JSON.stringify({ data_sources: [{ id: "ds-only", name: "Only" }] })),
      fail("retry query failure"),
    ]);
    await assert.rejects(
      () => queryDataSource({ database_or_data_source: "db-1" }, run),
      (error: Error) => {
        assert.match(error.message, /original query failure/);
        assert.match(error.message, /retry with data source ds-only also failed/);
        assert.match(error.message, /retry query failure/);
        return true;
      }
    );
  });

  it("does not resolve when the query succeeds", async () => {
    const { run, calls } = fakeRunner([ok(listResponse([ROW]))]);
    await queryDataSource({ database_or_data_source: "ds-1" }, run);
    assert.equal(calls.length, 1);
  });
});

describe("notion_query include_content", () => {
  it("does not fetch page Markdown by default", async () => {
    const { run, calls } = fakeRunner([ok(listResponse([ROW]))]);
    const result = await queryDataSource({ database_or_data_source: "ds-1" }, run);
    assert.equal(calls.length, 1);
    assert.equal("markdown" in result.results[0], false);
  });

  it("does not fetch page Markdown when the query fails", async () => {
    const { run, calls } = fakeRunner([
      fail("query failed"),
      ok(JSON.stringify({ data_sources: [{ id: "ds-only" }] })),
      fail("retry failed"),
    ]);
    await assert.rejects(
      () =>
        queryDataSource(
          { database_or_data_source: "db-1", include_content: true },
          run
        ),
      /original|query failed/
    );
    assert.equal(calls.some((call) => call.args[0] === "pages"), false);
  });

  it("adds markdown per row when enabled", async () => {
    const { run, calls } = fakeRunner([
      ok(listResponse([ROW, { ...ROW, id: "page-2", url: null }])),
      ok("# Task\n\nBody"),
      fail("page not found"),
    ]);
    const result = await queryDataSource(
      { database_or_data_source: "ds-1", include_content: true },
      run
    );
    assert.equal(result.results[0].markdown, "# Task\n\nBody");
    assert.match(result.results[1].markdown_error ?? "", /page not found/);
    assert.deepEqual(calls[1].args, ["pages", "get", "page-1"]);
    assert.deepEqual(calls[2].args, ["pages", "get", "page-2"]);
  });
});

describe("parseResolveDataSources", () => {
  it("accepts data_sources, bare arrays, and bare ids", () => {
    assert.deepEqual(
      parseResolveDataSources({ data_sources: [{ id: "a", name: "A" }, { id: "b" }] }),
      [{ id: "a", name: "A" }, { id: "b" }]
    );
    assert.deepEqual(parseResolveDataSources({ results: [{ id: "a" }] }), [{ id: "a" }]);
    assert.deepEqual(parseResolveDataSources(["a", "b", "a"]), [{ id: "a" }, { id: "b" }]);
    assert.deepEqual(parseResolveDataSources({ id: "a" }), [{ id: "a" }]);
    assert.deepEqual(parseResolveDataSources({ data_sources: [{ data_source_id: "a" }] }), [
      { id: "a" },
    ]);
  });

  it("returns an empty list for unknown shapes", () => {
    assert.deepEqual(parseResolveDataSources(null), []);
    assert.deepEqual(parseResolveDataSources("nope"), []);
    assert.deepEqual(parseResolveDataSources({ data_sources: [{}] }), []);
  });
});

describe("notion_query under", () => {
  const PARENT_ROW_ID = "33333333-3333-4333-8333-333333333333";
  const PARENT_ROW_URL = `https://app.notion.com/p/${PARENT_ROW_ID.replace(/-/g, "")}`;

  /** Two unnamed self-relations: the shared selector must refuse to guess. */
  const AMBIGUOUS_SCHEMA = {
    object: "data_source",
    id: ACCEPTANCE.dataSourceId,
    properties: {
      Name: { id: "title", name: "Name", type: "title", title: {} },
      Related: {
        id: "rel-a",
        name: "Related",
        type: "relation",
        relation: { data_source_id: ACCEPTANCE.dataSourceId },
      },
      Blocks: {
        id: "rel-b",
        name: "Blocks",
        type: "relation",
        relation: { data_source_id: ACCEPTANCE.dataSourceId },
      },
    },
  };

  function schemaCall(dsId: string = ACCEPTANCE.dataSourceId): string {
    return `v1/data_sources/${dsId}`;
  }

  it("is registered as an optional parameter", () => {
    const tool = registeredTool(fakeRunner([]).run);
    assert.ok(tool.parameters.properties.under);
  });

  it("turns under into a Parent-item relation filter (schema read first)", async () => {
    const { run, calls } = fakeRunner([
      ok(JSON.stringify(SELF_RELATION_SCHEMA)),
      ok(listResponse([ROW])),
    ]);

    const result = await queryDataSource(
      { database_or_data_source: ACCEPTANCE.dataSourceId, under: PARENT_ROW_ID },
      run
    );

    assert.equal(result.results.length, 1);
    assert.deepEqual(calls[0].args, ["api", schemaCall()]);
    assert.equal(calls[1].args[0], "datasources");
    assert.deepEqual(JSON.parse(argValue(calls[1].args, "--filter") ?? "{}"), {
      property: "Parent-item",
      relation: { contains: PARENT_ROW_ID },
    });
  });

  it("treats filter:{} as absent so the merged filter is a real Notion filter", async () => {
    const { run, calls } = fakeRunner([
      ok(JSON.stringify(SELF_RELATION_SCHEMA)),
      ok(listResponse([])),
    ]);

    await queryDataSource(
      { database_or_data_source: ACCEPTANCE.dataSourceId, under: PARENT_ROW_ID, filter: {} },
      run
    );

    assert.deepEqual(JSON.parse(argValue(calls[1].args, "--filter") ?? "{}"), {
      property: "Parent-item",
      relation: { contains: PARENT_ROW_ID },
    });
  });

  it("accepts a bare 32-hex under id", async () => {
    const { run, calls } = fakeRunner([
      ok(JSON.stringify(SELF_RELATION_SCHEMA)),
      ok(listResponse([])),
    ]);

    await queryDataSource(
      {
        database_or_data_source: ACCEPTANCE.dataSourceId,
        under: PARENT_ROW_ID.replace(/-/g, ""),
      },
      run
    );

    assert.deepEqual(JSON.parse(argValue(calls[1].args, "--filter") ?? "{}"), {
      property: "Parent-item",
      relation: { contains: PARENT_ROW_ID },
    });
  });

  it("accepts a Notion URL for under and canonicalizes the id", async () => {
    const { run, calls } = fakeRunner([
      ok(JSON.stringify(SELF_RELATION_SCHEMA)),
      ok(listResponse([])),
    ]);

    await queryDataSource(
      { database_or_data_source: ACCEPTANCE.dataSourceId, under: PARENT_ROW_URL },
      run
    );

    assert.deepEqual(JSON.parse(argValue(calls[1].args, "--filter") ?? "{}"), {
      property: "Parent-item",
      relation: { contains: PARENT_ROW_ID },
    });
  });

  it("ANDs under with a caller filter", async () => {
    const filter = { property: "Done", checkbox: { equals: true } };
    const { run, calls } = fakeRunner([
      ok(JSON.stringify(SELF_RELATION_SCHEMA)),
      ok(listResponse([])),
    ]);

    await queryDataSource(
      { database_or_data_source: ACCEPTANCE.dataSourceId, under: PARENT_ROW_ID, filter },
      run
    );

    assert.deepEqual(JSON.parse(argValue(calls[1].args, "--filter") ?? "{}"), {
      and: [{ property: "Parent-item", relation: { contains: PARENT_ROW_ID } }, filter],
    });
  });

  it("errors with hint_properties when there is no Parent-item column", async () => {
    const { run, calls } = fakeRunner([ok(JSON.stringify(DATA_SOURCE_SCHEMA))]);
    const tool = registeredTool(run);

    const result = await tool.execute("under-none", {
      database_or_data_source: ACCEPTANCE.dataSourceId,
      under: PARENT_ROW_ID,
    });

    assert.equal(result.isError, true);
    assert.match(text(result), /没有可用的 Parent-item/);
    assert.deepEqual(result.details.relation_properties, []);
    assert.deepEqual(
      result.details.hint_properties.map((entry: { name: string }) => entry.name),
      ["Name", "Status", "标签", "截止日期", "Done"]
    );
    assert.equal(calls.length, 1, "must not query without a Parent-item column");
  });

  it("refuses ambiguous unnamed self-relations instead of guessing", async () => {
    const { run, calls } = fakeRunner([ok(JSON.stringify(AMBIGUOUS_SCHEMA))]);

    await assert.rejects(
      () =>
        queryDataSource(
          { database_or_data_source: ACCEPTANCE.dataSourceId, under: PARENT_ROW_ID },
          run
        ),
      (error: Error) => {
        assert.match(error.message, /没有可用的 Parent-item/);
        assert.deepEqual((error as QueryInputError).details.relation_properties, [
          "Related",
          "Blocks",
        ]);
        return true;
      }
    );
    assert.equal(calls.length, 1);
  });

  it("refuses when the caller filter already targets the Parent-item column", async () => {
    const { run, calls } = fakeRunner([ok(JSON.stringify(SELF_RELATION_SCHEMA))]);
    const filter = { property: "Parent-item", relation: { does_not_contain: PARENT_ROW_ID } };

    await assert.rejects(
      () =>
        queryDataSource(
          { database_or_data_source: ACCEPTANCE.dataSourceId, under: PARENT_ROW_ID, filter },
          run
        ),
      (error: Error) => {
        assert.match(error.message, /不能自动合并/);
        assert.equal((error as QueryInputError).details.conflicting_property, "Parent-item");
        return true;
      }
    );
    assert.equal(calls.length, 1, "must not run the query with a guessed merge");
  });

  it("detects the conflicting column inside a nested and/or filter", async () => {
    const filter = {
      or: [
        { property: "Done", checkbox: { equals: true } },
        { property: "Parent-item", relation: { contains: PARENT_ROW_ID } },
      ],
    };
    const { run } = fakeRunner([ok(JSON.stringify(SELF_RELATION_SCHEMA))]);

    await assert.rejects(
      () =>
        queryDataSource(
          { database_or_data_source: ACCEPTANCE.dataSourceId, under: PARENT_ROW_ID, filter },
          run
        ),
      /不能自动合并/
    );
  });

  it("resolves a database id for the schema before filtering under", async () => {
    const { run, calls } = fakeRunner([
      fail("database id is not a data source"),
      ok(JSON.stringify({ data_sources: [{ id: ACCEPTANCE.dataSourceId }] })),
      ok(JSON.stringify(SELF_RELATION_SCHEMA)),
      ok(listResponse([ROW])),
    ]);

    const result = await queryDataSource(
      { database_or_data_source: ACCEPTANCE_DATABASE_ID, under: PARENT_ROW_ID },
      run
    );

    assert.equal(result.results.length, 1);
    assert.deepEqual(calls[0].args, ["api", schemaCall(ACCEPTANCE_DATABASE_ID)]);
    assert.deepEqual(calls[1].args, ["datasources", "resolve", ACCEPTANCE_DATABASE_ID, "--json"]);
    assert.equal(calls[3].args[0], "datasources");
    assert.deepEqual(JSON.parse(argValue(calls[3].args, "--filter") ?? "{}"), {
      property: "Parent-item",
      relation: { contains: PARENT_ROW_ID },
    });
  });

  it("rejects an under value that contains no Notion id, without calling ntn", async () => {
    const { run, calls } = fakeRunner([]);
    await assert.rejects(
      () => queryDataSource({ database_or_data_source: "ds-1", under: "not an id" }, run),
      /没有可识别的 Notion 行 id/
    );
    assert.equal(calls.length, 0);
  });

  it("rejects multi data sources for the schema instead of picking one", async () => {
    const { run } = fakeRunner([
      fail("not a data source"),
      ok(
        JSON.stringify({
          data_sources: [{ id: "ds-a", name: "A" }, { id: "ds-b", name: "B" }],
        })
      ),
    ]);

    await assert.rejects(
      () =>
        queryDataSource(
          { database_or_data_source: ACCEPTANCE_DATABASE_ID, under: PARENT_ROW_ID },
          run
        ),
      (error: Error) => {
        assert.match(error.message, /2 data sources/);
        assert.deepEqual((error as QueryInputError).details.data_source_ids, ["ds-a", "ds-b"]);
        return true;
      }
    );
  });

  it("reports a schema read failure when neither data source nor database resolves", async () => {
    // A non-id target never becomes an API path: resolve is the only attempt.
    const { run, calls } = fakeRunner([fail("resolve failed")]);
    await assert.rejects(
      () => queryDataSource({ database_or_data_source: "db-1", under: PARENT_ROW_ID }, run),
      /无法读取 db-1 的属性 schema/
    );
    assert.deepEqual(calls[0].args, ["datasources", "resolve", "db-1", "--json"]);
    assert.equal(calls.length, 1, "no query is attempted without a schema");
  });

  it("does not build an API path from a non-id target", async () => {
    const { run, calls } = fakeRunner([fail("resolve failed")]);
    await assert.rejects(
      () =>
        queryDataSource(
          { database_or_data_source: "../../v1/users/me", under: PARENT_ROW_ID },
          run
        ),
      /无法读取/
    );
    assert.equal(
      calls.some((call) => call.args[0] === "api"),
      false,
      "raw model text must not reach an api path"
    );
  });
});
