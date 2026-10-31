import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { extractNotionId } from "../src/lib/ids.ts";
import type { RunNtnOptions, RunNtnResult } from "../src/lib/runNtn.ts";
import { executeNotionGet, registerNotionGet } from "../src/tools/get.ts";
import type {
  NtnRunner,
  NotionDatabaseResult,
  NotionGetToolResult,
  NotionPageResult,
} from "../src/tools/get.ts";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID_BARE = PAGE_ID.replace(/-/g, "");
const DB_ID = "33333333-3333-4333-8333-333333333333";
const DS_1 = "44444444-4444-4444-8444-444444444444";
const DS_2 = "55555555-5555-4555-8555-555555555555";
const VIEW_ID = "99999999-9999-4999-8999-999999999999";

const PAGE_MD = `---
Name: Hello
---

# Hello

Body text`;

const PAGE_MD_TRUNCATED = `---
Name: Hello
---

# Hello`;

const PAGE_JSON = JSON.stringify({
  markdown: {
    id: PAGE_ID,
    markdown: "# Hello\n\nBody text",
    object: "page_markdown",
    truncated: false,
    unknown_block_ids: [],
  },
  page: {
    object: "page",
    id: PAGE_ID,
    url: `https://app.notion.com/p/Hello-${PAGE_ID_BARE}`,
    properties: {
      Name: {
        id: "title",
        type: "title",
        title: [{ type: "text", plain_text: "Hello" }],
      },
    },
  },
});

const PAGE_JSON_TRUNCATED = JSON.stringify({
  markdown: {
    id: PAGE_ID,
    markdown: "# Hello",
    object: "page_markdown",
    truncated: true,
    unknown_block_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  },
  page: {
    object: "page",
    id: PAGE_ID,
    url: `https://app.notion.com/p/Hello-${PAGE_ID_BARE}`,
    properties: {
      Name: { id: "title", type: "title", title: [{ type: "text", plain_text: "Hello" }] },
    },
  },
});

const RESOLVE_JSON = JSON.stringify({
  data_sources: [
    { id: DS_1, name: "Tasks" },
    { id: DS_2, name: "Archive" },
  ],
  database_id: DB_ID,
});

const DB_META_JSON = JSON.stringify({
  object: "database",
  id: DB_ID,
  title: [{ type: "text", plain_text: "Test DB" }],
  url: `https://app.notion.com/p/Test-DB-${DB_ID.replace(/-/g, "")}`,
  data_sources: [
    { id: DS_1, name: "Tasks" },
    { id: DS_2, name: "Archive" },
  ],
});

const DS_1_SCHEMA_JSON = JSON.stringify({
  object: "data_source",
  id: DS_1,
  title: [{ type: "text", plain_text: "Tasks" }],
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    Status: { id: "status", name: "Status", type: "status", status: {} },
    Done: { id: "done", name: "Done", type: "checkbox", checkbox: {} },
  },
});

const DS_2_SCHEMA_JSON = JSON.stringify({
  object: "data_source",
  id: DS_2,
  title: [{ type: "text", plain_text: "Archive" }],
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    Archived: { id: "archived", name: "Archived", type: "checkbox", checkbox: {} },
  },
});

function ok(stdout: string, stderr = ""): RunNtnResult {
  return { ok: true, stdout, stderr, code: 0 };
}

function apiError(status: string, message: string, code = 5): RunNtnResult {
  return {
    ok: false,
    stdout: "",
    stderr: `error: Public API request failed (${status}): ${message}`,
    code,
  };
}

function notFound(what: string): RunNtnResult {
  return apiError(
    "404 Not Found object_not_found",
    `Could not find ${what} with ID: ${DB_ID}. Make sure the relevant pages and databases are shared with your integration.`
  );
}

/**
 * Fake `runNtn`: records argv and answers from a script. This is the only external boundary of the
 * tool, so injecting it gives full unit coverage without spawning `ntn`.
 */
function mockNtn(script: (args: string[]) => RunNtnResult): {
  run: NtnRunner;
  calls: string[][];
  envs: RunNtnOptions["env"][];
} {
  const calls: string[][] = [];
  const envs: RunNtnOptions["env"][] = [];
  const run: NtnRunner = async (options) => {
    calls.push(options.args);
    envs.push(options.env);
    return script(options.args);
  };
  return { run, calls, envs };
}

function pageDetails(result: NotionGetToolResult): NotionPageResult {
  assert.equal(result.details.type, "page");
  return result.details as NotionPageResult;
}

function databaseDetails(result: NotionGetToolResult): NotionDatabaseResult {
  assert.equal(result.details.type, "database");
  return result.details as NotionDatabaseResult;
}

describe("extractNotionId", () => {
  it("canonicalizes bare 32-character ids", () => {
    assert.equal(extractNotionId(PAGE_ID_BARE), PAGE_ID);
  });

  it("keeps dashed UUIDs", () => {
    assert.equal(extractNotionId(PAGE_ID), PAGE_ID);
  });

  it("lowercases uppercase hex ids", () => {
    assert.equal(extractNotionId(PAGE_ID_BARE.toUpperCase()), PAGE_ID);
    assert.equal(extractNotionId(PAGE_ID.toUpperCase()), PAGE_ID);
  });

  it("extracts the id from an app.notion.com URL and ignores the view id", () => {
    assert.equal(
      extractNotionId(`https://app.notion.com/p/Hello-${PAGE_ID_BARE}?v=${VIEW_ID.replace(/-/g, "")}&pvs=4`),
      PAGE_ID
    );
  });

  it("extracts a dashed id from a notion.so URL", () => {
    assert.equal(extractNotionId(`https://www.notion.so/workspace/Hello-${PAGE_ID}?pvs=4`), PAGE_ID);
  });

  it("extracts the id from a custom notion.site domain", () => {
    assert.equal(extractNotionId(`https://team.notion.site/Hello-${PAGE_ID_BARE}`), PAGE_ID);
  });

  it("returns null for URLs with only a view id", () => {
    assert.equal(extractNotionId(`https://app.notion.com/p/?v=${VIEW_ID}`), null);
  });

  it("returns null for non-id input", () => {
    assert.equal(extractNotionId("my notes page"), null);
    assert.equal(extractNotionId("   "), null);
  });
});

describe("notion_get: pages", () => {
  it("returns Markdown by default with a single `ntn pages get` call", async () => {
    const { run, calls } = mockNtn(() => ok(PAGE_MD));
    const result = await executeNotionGet({ id_or_url: PAGE_ID }, run);

    assert.deepEqual(calls, [["pages", "get", PAGE_ID]]);
    assert.equal(result.content[0].text, PAGE_MD);
    const details = pageDetails(result);
    assert.equal(details.id, PAGE_ID);
    assert.equal(details.format, "md");
    assert.equal(details.markdown, PAGE_MD);
    assert.equal(details.truncated, undefined);
  });

  it("marks Markdown output as truncated when ntn warns on stderr", async () => {
    const { run } = mockNtn(() =>
      ok(PAGE_MD_TRUNCATED, "warning: Page content was truncated. Re-run `ntn pages get`")
    );
    const result = await executeNotionGet({ id_or_url: PAGE_ID }, run);
    assert.equal(pageDetails(result).truncated, true);
    // details are not shown to the model: the warning has to be in the text too
    assert.match(result.content[0].text, /\[notion_get\] ntn truncated this page/);
  });

  it("does not treat unrelated stderr containing 'truncated' as truncation", async () => {
    const { run } = mockNtn(() => ok(PAGE_MD, "warning: 0 blocks truncated"));
    const result = await executeNotionGet({ id_or_url: PAGE_ID }, run);
    assert.equal(pageDetails(result).truncated, undefined);
    assert.doesNotMatch(result.content[0].text, /ntn truncated this page/);
  });

  it("passes --json and returns structured page metadata in json format", async () => {
    const { run, calls } = mockNtn(() => ok(PAGE_JSON));
    const result = await executeNotionGet({ id_or_url: PAGE_ID, format: "json" }, run);

    assert.deepEqual(calls, [["pages", "get", PAGE_ID, "--json"]]);
    const details = pageDetails(result);
    assert.deepEqual(details, {
      type: "page",
      id: PAGE_ID,
      url: `https://app.notion.com/p/Hello-${PAGE_ID_BARE}`,
      title: "Hello",
      format: "json",
      markdown: "# Hello\n\nBody text",
      properties: {
        Name: {
          id: "title",
          type: "title",
          title: [{ type: "text", plain_text: "Hello" }],
        },
      },
      truncated: false,
      unknown_block_ids: [],
    });
    // json format keeps the structured payload as the model-facing text
    assert.deepEqual(JSON.parse(result.content[0].text), details);
  });

  it("surfaces truncation and unknown blocks from json output", async () => {
    const { run } = mockNtn(() => ok(PAGE_JSON_TRUNCATED));
    const details = pageDetails(await executeNotionGet({ id_or_url: PAGE_ID, format: "json" }, run));
    assert.equal(details.truncated, true);
    assert.deepEqual(details.unknown_block_ids, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  });

  it("accepts a Notion URL instead of an id", async () => {
    const { run, calls } = mockNtn(() => ok(PAGE_MD));
    await executeNotionGet(
      { id_or_url: `https://app.notion.com/p/Hello-${PAGE_ID_BARE}?v=${VIEW_ID.replace(/-/g, "")}` },
      run
    );
    assert.deepEqual(calls, [["pages", "get", PAGE_ID]]);
  });

  it("accepts a bare 32-character id", async () => {
    const { run, calls } = mockNtn(() => ok(PAGE_MD));
    await executeNotionGet({ id_or_url: PAGE_ID_BARE }, run);
    assert.deepEqual(calls, [["pages", "get", PAGE_ID]]);
  });

  it("rejects input without an id before spawning ntn", async () => {
    const { run, calls } = mockNtn(() => ok(PAGE_MD));
    await assert.rejects(() => executeNotionGet({ id_or_url: "not an id" }, run), /Could not find a Notion ID/);
    assert.deepEqual(calls, []);
  });

  it("rejects an unsupported format before spawning ntn", async () => {
    const { run, calls } = mockNtn(() => ok(PAGE_MD));
    await assert.rejects(
      () => executeNotionGet({ id_or_url: PAGE_ID, format: "html" as "md" }, run),
      /Unsupported format/
    );
    assert.deepEqual(calls, []);
  });

  it("fails fast on authentication errors instead of retrying as a database", async () => {
    const { run, calls } = mockNtn(() =>
      apiError("401 Unauthorized unauthorized", "API token is invalid.")
    );
    await assert.rejects(
      () => executeNotionGet({ id_or_url: PAGE_ID }, run),
      /not authenticated or configured.*NOTION_API_TOKEN/s
    );
    assert.equal(calls.length, 1);
  });

  it("fails fast when no workspace is selected", async () => {
    const { run, calls } = mockNtn(() => ({
      ok: false,
      stdout: "",
      stderr: "error: No workspace selected.\n  hint: Run `ntn login` first, or set NOTION_WORKSPACE_ID.",
      code: 4,
    }));
    await assert.rejects(() => executeNotionGet({ id_or_url: PAGE_ID }, run), /ntn login/);
    assert.equal(calls.length, 1);
  });

  it("does not fall back to the database path on transient errors", async () => {
    const { run, calls } = mockNtn(() => apiError("503 Service Unavailable service_unavailable", "try later"));
    await assert.rejects(() => executeNotionGet({ id_or_url: PAGE_ID }, run), /Could not read page/);
    assert.equal(calls.length, 1);
  });

  it("maps spawn and timeout failures to actionable errors", async () => {
    const cases: { stderr: string; expected: RegExp }[] = [
      { stderr: "ntn timed out after 60000ms", expected: /timed out/ },
      { stderr: "ntn not found on PATH. Install: npm i -g ntn", expected: /ntn not found on PATH/ },
      { stderr: "spawn EACCES", expected: /Could not run `ntn`/ },
    ];
    for (const { stderr, expected } of cases) {
      const { run, calls } = mockNtn(() => ({ ok: false, stdout: "", stderr, code: null }));
      await assert.rejects(() => executeNotionGet({ id_or_url: PAGE_ID }, run), expected);
      assert.equal(calls.length, 1);
    }
  });

  it("forces plain-text output for every ntn call", async () => {
    const { run, envs } = mockNtn(() => ok(PAGE_MD));
    await executeNotionGet({ id_or_url: PAGE_ID }, run);
    assert.equal(envs.length, 1);
    assert.equal(envs[0]?.NO_COLOR, "1");
    assert.equal(envs[0]?.NO_HYPERLINK, "1");
  });
});

describe("notion_get: databases", () => {
  function databaseScript(options?: { failSchemaFor?: string }): (args: string[]) => RunNtnResult {
    return (args) => {
      if (args[0] === "pages") return notFound("page");
      if (args[0] === "datasources") return ok(RESOLVE_JSON);
      if (args[0] === "api" && args[1] === `v1/databases/${DB_ID}`) return ok(DB_META_JSON);
      if (args[0] === "api" && args[1] === `v1/data_sources/${DS_1}`) {
        return options?.failSchemaFor === DS_1
          ? apiError("500 Internal Server Error internal_server_error", "boom")
          : ok(DS_1_SCHEMA_JSON);
      }
      if (args[0] === "api" && args[1] === `v1/data_sources/${DS_2}`) return ok(DS_2_SCHEMA_JSON);
      throw new Error(`unexpected ntn args: ${args.join(" ")}`);
    };
  }

  it("returns schema, all data source ids and no rows", async () => {
    const { run, calls } = mockNtn(databaseScript());
    const result = await executeNotionGet({ id_or_url: DB_ID }, run);
    const details = databaseDetails(result);

    assert.deepEqual(calls, [
      ["pages", "get", DB_ID],
      ["datasources", "resolve", DB_ID, "--json"],
      ["api", `v1/databases/${DB_ID}`],
      ["api", `v1/data_sources/${DS_1}`],
      ["api", `v1/data_sources/${DS_2}`],
    ]);
    // The whole point of notion_get for databases: schema only, never rows.
    assert.equal(
      calls.some((args) => args.includes("query")),
      false
    );

    assert.equal(details.id, DB_ID);
    assert.equal(details.title, "Test DB");
    assert.equal(details.url, `https://app.notion.com/p/Test-DB-${DB_ID.replace(/-/g, "")}`);
    assert.deepEqual(details.data_source_ids, [DS_1, DS_2]);
    assert.deepEqual(details.properties, [
      { name: "Name", type: "title", writable: true },
      { name: "Status", type: "status", writable: true },
      { name: "Done", type: "checkbox", writable: true },
      { name: "Archived", type: "checkbox", writable: true },
    ]);
    assert.deepEqual(
      details.data_sources.map((dataSource) => ({ id: dataSource.id, name: dataSource.name })),
      [
        { id: DS_1, name: "Tasks" },
        { id: DS_2, name: "Archive" },
      ]
    );

    const text = result.content[0].text;
    assert.match(text, /Test DB/);
    assert.match(text, new RegExp(DS_1));
    assert.match(text, /Name: title/);
    assert.match(text, /notion_query/);
  });

  it("keeps the resolved ids when a schema call fails, and reports a warning", async () => {
    const { run } = mockNtn(databaseScript({ failSchemaFor: DS_1 }));
    const details = databaseDetails(await executeNotionGet({ id_or_url: DB_ID }, run));

    assert.deepEqual(details.data_source_ids, [DS_1, DS_2]);
    assert.deepEqual(details.properties, [
      { name: "Name", type: "title", writable: true },
      { name: "Archived", type: "checkbox", writable: true },
    ]);
    assert.equal(details.data_sources[0].error !== undefined, true);
    assert.equal(details.warnings?.length, 1);
  });

  it("flags read-only properties and marks the Parent-item self-relation candidate", async () => {
    const relationSchema = JSON.stringify({
      object: "data_source",
      id: DS_1,
      properties: {
        Name: { id: "title", name: "Name", type: "title", title: {} },
        "Parent-item": {
          id: "parent",
          name: "Parent-item",
          type: "relation",
          relation: { data_source_id: DS_1.replace(/-/g, ""), type: "dual_property" },
        },
        Related: {
          id: "related",
          name: "Related",
          type: "relation",
          relation: { data_source_id: DS_2, type: "single_property" },
        },
        // Parent-ish name, wrong target: attach would refuse it, so get must not advertise it.
        上级: {
          id: "parentish",
          name: "上级",
          type: "relation",
          relation: { data_source_id: DS_2, type: "single_property" },
        },
        Total: { id: "total", name: "Total", type: "rollup", rollup: {} },
      },
    });
    const { run } = mockNtn((args) => {
      if (args[0] === "pages") return notFound("page");
      if (args[0] === "datasources") {
        return ok(JSON.stringify({ data_sources: [{ id: DS_1, name: "Tasks" }] }));
      }
      if (args[0] === "api" && args[1] === `v1/databases/${DB_ID}`) return ok(DB_META_JSON);
      if (args[0] === "api" && args[1] === `v1/data_sources/${DS_1}`) return ok(relationSchema);
      throw new Error(`unexpected ntn args: ${args.join(" ")}`);
    });

    const result = await executeNotionGet({ id_or_url: DB_ID }, run);
    const details = databaseDetails(result);
    const byName = new Map(details.properties.map((property) => [property.name, property]));

    assert.equal(byName.get("Name")?.writable, true);
    assert.equal(byName.get("Total")?.writable, false);
    assert.equal(byName.get("Parent-item")?.self_relation, true);
    // Bare hex vs dashed id: the flags must survive both spellings.
    assert.equal(byName.get("Parent-item")?.relation_data_source_id, DS_1.replace(/-/g, ""));
    assert.equal(byName.get("Parent-item")?.parent_item_candidate, true);
    assert.equal(byName.get("Related")?.self_relation, false);
    assert.equal(byName.get("Related")?.parent_item_candidate, undefined);
    assert.equal(byName.get("上级")?.self_relation, false);
    assert.equal(
      byName.get("上级")?.parent_item_candidate,
      undefined,
      "a parent-named relation pointing at another data source is not usable for attach"
    );
    assert.deepEqual(details.parent_item_candidates, [
      { data_source_id: DS_1, property: "Parent-item" },
    ]);

    const text = result.content[0].text;
    assert.match(text, /Total: rollup — read-only/);
    assert.match(text, /Parent-item: relation — .*self.*Parent-item candidate/);
    assert.match(text, /Parent-item candidates \(use one with notion_page attach/);
  });

  it("accepts a database URL", async () => {
    const { run, calls } = mockNtn(databaseScript());
    await executeNotionGet(
      { id_or_url: `https://app.notion.com/p/Test-DB-${DB_ID.replace(/-/g, "")}?v=${VIEW_ID.replace(/-/g, "")}` },
      run
    );
    assert.deepEqual(calls[0], ["pages", "get", DB_ID]);
  });

  it("detects a database in json format too", async () => {
    const { run, calls } = mockNtn(databaseScript());
    const details = databaseDetails(await executeNotionGet({ id_or_url: DB_ID, format: "json" }, run));
    assert.deepEqual(calls[0], ["pages", "get", DB_ID, "--json"]);
    assert.deepEqual(details.data_source_ids, [DS_1, DS_2]);
  });

  it("dedupes repeated data source ids from resolve", async () => {
    const resolveWithDuplicate = JSON.stringify({
      data_sources: [
        { id: DS_1, name: "Tasks" },
        { id: DS_1, name: "Tasks" },
        { id: DS_2, name: "Archive" },
      ],
      database_id: DB_ID,
    });
    const { run, calls } = mockNtn((args) => {
      if (args[0] === "pages") return notFound("page");
      if (args[0] === "datasources") return ok(resolveWithDuplicate);
      if (args[0] === "api" && args[1] === `v1/databases/${DB_ID}`) return ok(DB_META_JSON);
      if (args[0] === "api" && args[1] === `v1/data_sources/${DS_1}`) return ok(DS_1_SCHEMA_JSON);
      if (args[0] === "api" && args[1] === `v1/data_sources/${DS_2}`) return ok(DS_2_SCHEMA_JSON);
      throw new Error(`unexpected ntn args: ${args.join(" ")}`);
    });

    const details = databaseDetails(await executeNotionGet({ id_or_url: DB_ID }, run));
    assert.deepEqual(details.data_source_ids, [DS_1, DS_2]);
    assert.equal(calls.filter((args) => args[1] === `v1/data_sources/${DS_1}`).length, 1);
  });

  it("reports both attempts when the id is neither an accessible page nor database", async () => {
    const { run, calls } = mockNtn((args) => {
      if (args[0] === "pages") return notFound("page");
      if (args[0] === "datasources") return notFound("database");
      throw new Error(`unexpected ntn args: ${args.join(" ")}`);
    });

    await assert.rejects(
      () => executeNotionGet({ id_or_url: PAGE_ID }, run),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /as a Notion page or database/);
        assert.match(message, /- page: .*404/);
        assert.match(message, /- database: .*404/);
        assert.match(message, /shared with the Notion integration/);
        return true;
      }
    );
    assert.equal(calls.length, 2);
  });

  it("throws on malformed datasources resolve JSON instead of guessing", async () => {
    const { run } = mockNtn((args) => {
      if (args[0] === "pages") return notFound("page");
      if (args[0] === "datasources") return ok("{}");
      throw new Error(`unexpected ntn args: ${args.join(" ")}`);
    });
    await assert.rejects(
      () => executeNotionGet({ id_or_url: DB_ID }, run),
      /did not include data_sources/
    );
  });

  it("rejects data sources that have no usable id", async () => {
    const { run } = mockNtn((args) => {
      if (args[0] === "pages") return notFound("page");
      if (args[0] === "datasources") {
        return ok(JSON.stringify({ data_sources: [{ name: "no id" }], database_id: DB_ID }));
      }
      throw new Error(`unexpected ntn args: ${args.join(" ")}`);
    });
    await assert.rejects(
      () => executeNotionGet({ id_or_url: DB_ID }, run),
      /no usable data source ids/
    );
  });
});

describe("registerNotionGet", () => {
  it("registers notion_get with the documented parameters and uses the injected runner", async () => {
    const tools: {
      name: string;
      parameters: { required?: string[]; properties?: Record<string, unknown> };
      execute: (
        toolCallId: string,
        params: { id_or_url: string; format?: "md" | "json" }
      ) => Promise<NotionGetToolResult>;
    }[] = [];
    const pi = {
      registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
    } as unknown as ExtensionAPI;

    const { run, calls } = mockNtn(() => ok(PAGE_MD));
    registerNotionGet(pi, run);

    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "notion_get");
    assert.deepEqual(tools[0].parameters.required, ["id_or_url"]);
    assert.deepEqual(Object.keys(tools[0].parameters.properties ?? {}).sort(), ["format", "id_or_url"]);

    const result = await tools[0].execute("call-1", { id_or_url: PAGE_ID });
    assert.deepEqual(calls, [["pages", "get", PAGE_ID]]);
    assert.equal(result.details.type, "page");
  });
});
