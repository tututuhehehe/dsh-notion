/**
 * `notion_page_create`, `notion_page_edit` and `notion_page_trash`.
 *
 * The old single `notion_page` tool carried an `action` parameter and swapped the
 * whole page body on every content edit. Both are gone: the tool name is now the
 * action, and a content edit is a find-and-replace. Every suite is written against
 * a fake `ntn` runner, so assertions are about the contract — the canonical value
 * the tool returns and the exact argv it hands to `ntn`.
 *
 * `mount()` runs DSH's real output-schema validation on every success, so a value
 * that does not satisfy its own declared schema fails the test that produced it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createNotionPageCreateTool,
  createNotionPageEditTool,
  createNotionPageTrashTool,
} from "../src/tools/page.ts";
import type { NtnRunner } from "../src/tools/page.ts";
import type { NotionTool } from "../src/dsh/tool.ts";
import type { RunNtnResult } from "../src/lib/runNtn.ts";
import { mount, text } from "./fixtures/dsh.ts";
import type { MountedTool } from "./fixtures/dsh.ts";
import {
  ACCEPTANCE,
  ACCEPTANCE_DATABASE_ID,
  BODY_COLUMN_SCHEMA,
  DATA_SOURCE_SCHEMA,
  DUAL_RELATION_SCHEMA,
  ICON_COLUMN_SCHEMA,
  SELF_RELATION_SCHEMA,
  ntnFail,
  ntnOk,
  resolveResponse,
} from "./fixtures/notion.ts";

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

type Factory = (deps: { runNtn: NtnRunner }) => NotionTool<any>;

/**
 * Mount one of the three page tools with a scripted `ntn` runner.
 *
 * `calls` records the argv of every spawn, in order, so a test can assert both the
 * call count and the exact arguments — including that a multi-edit call is ONE
 * request rather than N.
 */
function harness(
  factory: Factory,
  handler: (args: string[]) => RunNtnResult = () => ntnOk("{}")
): { tool: MountedTool<any>; calls: string[][] } {
  const calls: string[][] = [];
  const runner: NtnRunner = async (options) => {
    calls.push(options.args);
    return handler(options.args);
  };
  return { tool: mount(factory({ runNtn: runner })), calls };
}

const createHarness = (handler?: (args: string[]) => RunNtnResult) =>
  harness(createNotionPageCreateTool, handler);
const editHarness = (handler?: (args: string[]) => RunNtnResult) =>
  harness(createNotionPageEditTool, handler);
const trashHarness = (handler?: (args: string[]) => RunNtnResult) =>
  harness(createNotionPageTrashTool, handler);

const NEW_PAGE_ID = "11111111-1111-4111-8111-111111111111";
const EDIT_PAGE_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_ROW_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ROW_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_PARENT_ID = "55555555-5555-4555-8555-555555555555";

const DS_PARENT = { type: "data_source_id", data_source_id: ACCEPTANCE.dataSourceId };
const PAGE_PARENT = { type: "page_id", page_id: ACCEPTANCE.parentPageId };

type Params = {
  type?: string;
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
};

function params(tool: MountedTool<any>): Params {
  return tool.parameters as Params;
}

function paramKeys(tool: MountedTool<any>): string[] {
  return Object.keys(params(tool).properties).sort();
}

/** The JSON body of the one PATCH `v1/pages/<id>` request (property/icon write). */
function patchBody(calls: string[][]): Record<string, any> {
  const patch = calls.find(
    (args) =>
      args[0] === "api" && /^v1\/pages\/[^/]+$/.test(args[1] ?? "") && args[3] === "PATCH"
  );
  if (!patch) throw new Error(`expected a PATCH v1/pages/<id> call, saw: ${JSON.stringify(calls)}`);
  return JSON.parse(patch[5]) as Record<string, any>;
}

function patchCalls(calls: string[][]): string[][] {
  return calls.filter(
    (args) =>
      args[0] === "api" && /^v1\/pages\/[^/]+$/.test(args[1] ?? "") && args[3] === "PATCH"
  );
}

/** The JSON body of the one `/markdown` request (find-replace or append). */
function markdownBody(calls: string[][]): Record<string, any> {
  const call = markdownCalls(calls)[0];
  if (!call) throw new Error(`expected a /markdown call, saw: ${JSON.stringify(calls)}`);
  const at = Math.max(call.indexOf("-d"), call.indexOf("--data"));
  if (at < 0) throw new Error(`/markdown call carried no data flag: ${JSON.stringify(call)}`);
  return JSON.parse(call[at + 1]) as Record<string, any>;
}

function markdownCalls(calls: string[][]): string[][] {
  return calls.filter((args) => args[0] === "api" && String(args[1]).endsWith("/markdown"));
}

function moveCalls(calls: string[][]): string[][] {
  return calls.filter((args) => args[0] === "api" && String(args[1]).endsWith("/move"));
}

/** A successful `PATCH v1/pages/<id>/markdown` response carrying the new page markdown. */
function markdownOk(markdown: string, extra: Record<string, unknown> = {}): RunNtnResult {
  return ntnOk({
    object: "page",
    id: EDIT_PAGE_ID,
    markdown,
    request_id: "req-1",
    truncated: false,
    unknown_block_ids: [],
    ...extra,
  });
}

function pageCreateResponse(pageId: string): RunNtnResult {
  return ntnOk({
    object: "page",
    id: pageId,
    url: `https://app.notion.com/p/${pageId.replace(/-/g, "")}`,
  });
}

function pageWithParent(parent: Record<string, unknown>): RunNtnResult {
  return ntnOk({ object: "page", id: "ignored", parent });
}

/** GET v1/pages body with both a parent and current property values (move checks). */
function pageWithProps(
  parent: Record<string, unknown>,
  properties: Record<string, unknown>
): RunNtnResult {
  return ntnOk({ object: "page", id: "ignored", parent, properties });
}

/* ------------------------------------------------------------------ *
 * Registration: the three tools and their parameter schemas
 * ------------------------------------------------------------------ */

describe("notion_page_* registration", () => {
  it("exposes three separate tools whose names carry the action", () => {
    // The split is the point: a caller cannot express "create" and "trash" in one
    // parameter object, so the name must differ per operation.
    assert.equal(createHarness().tool.name, "notion_page_create");
    assert.equal(editHarness().tool.name, "notion_page_edit");
    assert.equal(trashHarness().tool.name, "notion_page_trash");
  });

  it("declares exactly the arguments each operation accepts, with no action parameter", () => {
    assert.deepEqual(paramKeys(createHarness().tool), [
      "body_content",
      "icon",
      "parent",
      "props",
      "title",
    ]);
    assert.deepEqual(paramKeys(editHarness().tool), [
      "body_content",
      "edits",
      "icon",
      "id",
      "parent",
      "props",
      "title",
      "yes",
    ]);
    assert.deepEqual(paramKeys(trashHarness().tool), ["id", "recursive", "yes"]);
    for (const tool of [createHarness().tool, editHarness().tool, trashHarness().tool]) {
      assert.equal("action" in params(tool).properties, false, `${tool.name} must not take action`);
    }
  });

  it("closes every parameter object and declares no confirm_shrink escape hatch", () => {
    for (const tool of [createHarness().tool, editHarness().tool, trashHarness().tool]) {
      assert.equal(params(tool).additionalProperties, false, `${tool.name} should be closed`);
      // Whole-page replace is gone, so the consent parameter for it must be gone too.
      assert.equal(
        "confirm_shrink" in params(tool).properties,
        false,
        `${tool.name} must not declare confirm_shrink`
      );
    }
  });

  it("describes find-replace on the edit tool, not the whole-page replace it replaced", () => {
    const description = editHarness().tool.description;
    assert.match(description, /old_str/);
    assert.match(description, /new_str/);
    assert.doesNotMatch(description, /REPLACES the entire page body/);
    assert.doesNotMatch(description, /props\.body_content/);
    assert.doesNotMatch(description, /props\.icon/);
  });

  it("rejects the retired confirm_shrink argument instead of silently ignoring it", async () => {
    // A caller upgrading from the old tool still sends confirm_shrink. Ignoring it
    // would let them believe a destructive replace was consented to.
    const { tool, calls } = editHarness();
    const result = await tool.execute("call-shrink", {
      id: EDIT_PAGE_ID,
      body_content: "x",
      confirm_shrink: true,
    });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
    assert.match(text(result), /confirm_shrink/);
  });

  it("rejects an argument that belongs to a different one of the three tools", async () => {
    // The split only pays off if the stray argument is refused rather than ignored.
    const cases: { args: Record<string, unknown>; extra: string; make: () => ReturnType<typeof editHarness> }[] =
      [
        {
          make: trashHarness,
          args: { id: EDIT_PAGE_ID, yes: true, edits: [{ old_str: "a", new_str: "b" }] },
          extra: "edits",
        },
        {
          make: createHarness,
          args: {
            parent: `page:${ACCEPTANCE.parentPageId}`,
            title: "t",
            edits: [{ old_str: "a", new_str: "b" }],
          },
          extra: "edits",
        },
        {
          make: editHarness,
          args: { id: EDIT_PAGE_ID, title: "t", recursive: true, parent: `page:${NEW_PAGE_ID}` },
          extra: "recursive",
        },
        {
          make: trashHarness,
          args: { id: EDIT_PAGE_ID, yes: true, parent: `page:${NEW_PAGE_ID}` },
          extra: "parent",
        },
      ];
    for (const { args, extra, make } of cases) {
      const { tool, calls } = make();
      const result = await tool.execute("call-extra", args);
      assert.equal(result.isError, true, `${tool.name} accepted ${extra}`);
      assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
      assert.match(text(result), new RegExp(extra));
      assert.equal(calls.length, 0, `${tool.name} called ntn before rejecting ${extra}`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Top-level icon and body_content
 * ------------------------------------------------------------------ */

describe("notion_page_create: top-level icon and body_content", () => {
  function createScript(): (args: string[]) => RunNtnResult {
    return (args) => {
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: NEW_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    };
  }

  it("writes top-level body_content as the create markdown, with no PATCH", async () => {
    const { tool, calls } = createHarness(() => pageCreateResponse(NEW_PAGE_ID));

    const result = await tool.execute("create-body", {
      parent: `page:${ACCEPTANCE.parentPageId}`,
      body_content: "# Hello\n\nbody",
    });

    assert.equal(result.isError, false, text(result));
    assert.equal(calls.length, 1);
    const args = calls[0];
    assert.deepEqual(args.slice(0, 3), ["pages", "create", "--json"]);
    assert.equal(args[args.indexOf("--parent") + 1], `page:${ACCEPTANCE.parentPageId}`);
    // The leading H1 becomes the frontmatter title ntn documents; the body keeps the rest.
    assert.ok(
      args.includes('--content=---\ntitle: "Hello"\n---\n\nbody'),
      `expected the H1 lifted into frontmatter, got: ${JSON.stringify(args)}`
    );
    assert.equal(result.details.created, true);
    assert.deepEqual(result.details.changed, ["body_content"]);
  });

  it("writes top-level icon as an emoji in the follow-up PATCH", async () => {
    const { tool, calls } = createHarness(createScript());

    const result = await tool.execute("create-icon-emoji", {
      parent: `page:${ACCEPTANCE.parentPageId}`,
      title: "Icon page",
      icon: "🎯",
    });

    assert.equal(result.isError, false, text(result));
    assert.equal(calls.find((args) => args[0] === "pages")?.[1], "create");
    // The explicit title is also written, as the title column of a row-less page.
    // Both the icon and the title travel in the ONE follow-up PATCH.
    assert.deepEqual(patchBody(calls).icon, { type: "emoji", emoji: "🎯" });
    assert.deepEqual(patchBody(calls).properties, {
      title: { title: [{ type: "text", text: { content: "Icon page" } }] },
    });
    assert.equal(result.details.icon, "🎯");
    assert.deepEqual(result.details.changed, ["body_content", "title", "icon"]);
  });

  it("writes a top-level http(s) icon as a Notion external file icon", async () => {
    const url = "https://x.test/a.png";
    const { tool, calls } = createHarness(createScript());

    const result = await tool.execute("create-icon-url", {
      parent: `page:${ACCEPTANCE.parentPageId}`,
      title: "Icon page",
      icon: url,
    });

    assert.equal(result.isError, false, text(result));
    assert.deepEqual(patchBody(calls).icon, { type: "external", external: { url } });
    assert.equal(result.details.icon, url);
  });

  it("sends icon: null to clear the icon", async () => {
    const { tool, calls } = createHarness(createScript());

    const result = await tool.execute("create-icon-clear", {
      parent: `page:${ACCEPTANCE.parentPageId}`,
      title: "Icon page",
      icon: null,
    });

    assert.equal(result.isError, false, text(result));
    assert.deepEqual(patchBody(calls).icon, null);
    assert.equal(result.details.icon, null);
  });

  it("rejects an over-long non-URL icon string as invalid input, before any ntn call", async () => {
    const { tool, calls } = createHarness(createScript());

    const result = await tool.execute("create-icon-invalid", {
      parent: `page:${ACCEPTANCE.parentPageId}`,
      title: "Icon page",
      icon: "this is definitely not an emoji",
    });

    assert.equal(result.isError, true);
    assert.match(text(result), /既不是 emoji 也不是图片 URL/);
    assert.equal(calls.length, 0);
  });

  it("rejects a non-string body_content before calling ntn", async () => {
    const { tool, calls } = createHarness();

    const result = await tool.execute("create-body-invalid", {
      parent: `page:${ACCEPTANCE.parentPageId}`,
      body_content: { text: "nope" },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /body_content.*Markdown 字符串/);
    assert.equal(calls.length, 0);
  });

  it("writes props.icon as the real column when the data source has one", async () => {
    // `icon` is no longer a reserved props key, so on a data source with an actual
    // column of that name it is an ordinary column write. Blanket-rejecting it
    // would make that column unwritable.
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(ICON_COLUMN_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: NEW_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("create-icon-column", {
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      title: "列名测试",
      props: { icon: "这一列的值" },
    });

    assert.equal(result.isError, false, text(result));
    const body = patchBody(calls);
    // The column is written as a rich_text column value...
    assert.deepEqual(body.properties.icon, {
      rich_text: [{ type: "text", text: { content: "这一列的值" } }],
    });
    // ...and it must NOT also be emitted as the page-level icon: `props.icon` is a
    // column here, so putting it in the PATCH's top-level `icon` would set the wrong thing.
    assert.equal("icon" in body, false);
    assert.deepEqual(Object.keys(body.properties).sort(), ["Name", "icon"]);
    assert.deepEqual([...result.details.properties].sort(), ["Name", "icon"]);
    assert.equal(result.details.icon, undefined);
  });

  it("writes props.body_content as the real column when the data source has one", async () => {
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(BODY_COLUMN_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: NEW_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("create-body-column", {
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      title: "列名测试",
      props: { body_content: "这是列的值，不是正文" },
    });

    assert.equal(result.isError, false, text(result));
    // The column carries the text as a rich_text value, alongside the title column.
    const body = patchBody(calls);
    assert.deepEqual(body.properties.body_content, {
      rich_text: [{ type: "text", text: { content: "这是列的值，不是正文" } }],
    });
    assert.deepEqual(Object.keys(body.properties).sort(), ["Name", "body_content"]);
    // The page BODY must not have become the column text: no body_content was passed
    // as the page body, so the create markdown carries only the frontmatter title.
    const createArgs = calls.find((args) => args[0] === "pages") ?? [];
    const content = createArgs.find((arg) => arg.startsWith("--content=")) ?? "";
    assert.doesNotMatch(content, /这是列的值/);
    assert.deepEqual([...result.details.properties].sort(), ["Name", "body_content"]);
  });
});

/* ------------------------------------------------------------------ *
 * create: container resolution and schema lookup
 * ------------------------------------------------------------------ */

describe("notion_page_create: parent resolution", () => {
  it("resolves database:<id> through datasources resolve and never reads v1/databases (C4)", async () => {
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "datasources") return ntnOk(resolveResponse(ACCEPTANCE.dataSourceId));
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: NEW_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("create-db", {
      parent: `database:${ACCEPTANCE_DATABASE_ID}`,
      props: { Name: "新行", Status: "待办" },
    });

    assert.equal(result.isError, false, text(result));
    assert.deepEqual(calls[0], ["datasources", "resolve", ACCEPTANCE_DATABASE_ID, "--json"]);
    assert.deepEqual(calls[1], ["api", `v1/data_sources/${ACCEPTANCE.dataSourceId}`]);
    assert.deepEqual(calls[2].slice(0, 3), ["pages", "create", "--json"]);
    assert.deepEqual(calls[3].slice(0, 3), ["api", `v1/pages/${NEW_PAGE_ID}`, "-X"]);
    assert.equal(
      calls.some((args) => args[1]?.startsWith("v1/databases/")),
      false,
      "a database has no property schema in 2025-09+; it must not be read"
    );

    const createArgs = calls[2];
    assert.equal(
      createArgs[createArgs.indexOf("--parent") + 1],
      `data-source:${ACCEPTANCE.dataSourceId}`,
      "the resolved data source is used as the create parent"
    );
    assert.match(createArgs.find((arg) => arg.startsWith("--content=")) ?? "", /title: "新行"/);
    assert.deepEqual(JSON.parse(calls[3][5]), {
      properties: {
        Name: { title: [{ type: "text", text: { content: "新行" } }] },
        Status: { status: { name: "待办" } },
      },
    });
    assert.deepEqual(result.details.properties, ["Name", "Status"]);
  });

  it("errors with the data source ids when a database has several (no guessing)", async () => {
    const other = "55555555-5555-4555-8555-555555555555";
    const { tool, calls } = createHarness((args) =>
      args[0] === "datasources" ? ntnOk(resolveResponse(ACCEPTANCE.dataSourceId, other)) : ntnOk({})
    );

    const result = await tool.execute("create-multi-ds", {
      parent: `database:${ACCEPTANCE_DATABASE_ID}`,
      props: { Name: "x" },
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 1);
    assert.match(result.content[0].text, /2 个 data source/);
    assert.match(result.content[0].text, new RegExp(ACCEPTANCE.dataSourceId));
    assert.match(result.content[0].text, new RegExp(other));
    assert.deepEqual(result.details.data_source_ids, [ACCEPTANCE.dataSourceId, other]);
  });

  it("errors with hint_properties when a database page has no resolvable title", async () => {
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      return pageCreateResponse(NEW_PAGE_ID);
    });

    const result = await tool.execute("create-no-title", {
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      props: { Status: "待办" },
    });

    assert.equal(result.isError, true);
    // Only the schema lookup ran: no page may be created without a title.
    assert.equal(calls.length, 1);
    const hints = result.details.hint_properties;
    assert.ok(Array.isArray(hints));
    assert.deepEqual(
      hints.map((hint: { name: string }) => hint.name),
      ["Name", "Status", "标签", "截止日期", "Done"]
    );
    assert.ok(result.content[0].text.includes("Name (title)"));
    assert.ok(result.content[0].text.includes("需要标题"));
  });

  it("rejects a bare page parent with no body/title and never calls ntn", async () => {
    const { tool, calls } = createHarness();

    const result = await tool.execute("create-bare", {
      parent: `page:${ACCEPTANCE.parentPageId}`,
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /body_content 或 title/);
  });

  it("passes markdown starting with '-' as a single --content= argument", async () => {
    const { tool, calls } = createHarness(() => pageCreateResponse(NEW_PAGE_ID));

    const result = await tool.execute("create-dash", {
      parent: `page:${ACCEPTANCE.parentPageId}`,
      body_content: "- one\n- two",
    });

    assert.equal(result.isError, false, text(result));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("--content=- one\n- two"));
  });

  it("lets the title argument win over the title property in props", async () => {
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: NEW_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("create-title-wins", {
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      title: "A",
      props: { Name: "B" },
      body_content: "body",
    });

    assert.equal(result.isError, false, text(result));
    assert.match(calls[1].find((arg) => arg.startsWith("--content=")) ?? "", /title: "A"/);
    assert.deepEqual(JSON.parse(calls[2][5]), {
      properties: { Name: { title: [{ type: "text", text: { content: "A" } }] } },
    });
    assert.equal(result.details.title, "A");
  });
});

/* ------------------------------------------------------------------ *
 * create: child rows and the Parent-item relation
 * ------------------------------------------------------------------ */

describe("notion_page_create: child rows", () => {
  it("creates a child row from a bare parent row id and links Parent-item", async () => {
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(SELF_RELATION_SCHEMA);
      }
      if (args[0] === "pages") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: NEW_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("create-child", {
      parent: PARENT_ROW_ID,
      props: { Name: "子任务", Status: "待办" },
    });

    assert.equal(result.isError, false, text(result));
    const createArgs = calls.find((args) => args[0] === "pages") ?? [];
    assert.equal(
      createArgs[createArgs.indexOf("--parent") + 1],
      `data-source:${ACCEPTANCE.dataSourceId}`,
      "a child row is created in the parent row's data source"
    );
    const patch = calls.find((args) => args[2] === "-X") ?? [];
    assert.deepEqual(JSON.parse(patch[5]), {
      properties: {
        Name: { title: [{ type: "text", text: { content: "子任务" } }] },
        Status: { status: { name: "待办" } },
        "Parent-item": { relation: [{ id: PARENT_ROW_ID }] },
      },
    });
    assert.deepEqual(result.details.properties, ["Name", "Status", "Parent-item"]);
    assert.equal(result.details.parent_item_row_id, PARENT_ROW_ID);
  });

  it("explains a missing Parent-item relation instead of creating an orphan row", async () => {
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      return pageCreateResponse(NEW_PAGE_ID);
    });

    const result = await tool.execute("create-orphan", {
      parent: PARENT_ROW_ID,
      props: { Name: "子任务" },
    });

    assert.equal(result.isError, true);
    assert.equal(calls.some((args) => args[0] === "pages"), false);
    assert.match(result.content[0].text, /Parent-item/);
    assert.match(result.content[0].text, /没有任何 relation 列/);
    assert.ok(
      (result.details.hint_properties ?? []).some((hint: { name: string }) => hint.name === "Name")
    );
  });

  it("writes the named Parent item column, never the Sub-item dual", async () => {
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) {
        return pageWithProps(DS_PARENT, {});
      }
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DUAL_RELATION_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: NEW_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const created = await tool.execute("create-dual", {
      parent: PARENT_ROW_ID,
      body_content: "# Child",
    });
    assert.equal(created.isError, false, created.content[0].text);
    const patch = calls.filter((args) => args[2] === "-X").at(-1) ?? [];
    const body = JSON.parse(patch[5]).properties;
    // A dual relation exposes both sides; writing the wrong one silently detaches the row.
    assert.deepEqual(body[ACCEPTANCE.parentItemColumn], { relation: [{ id: PARENT_ROW_ID }] });
    assert.equal("Sub-item" in body, false);
  });
});

/* ------------------------------------------------------------------ *
 * create: atomicity (the page must not be left half-made)
 * ------------------------------------------------------------------ */

describe("notion_page_create: atomicity", () => {
  it("trashes the new page when the follow-up props PATCH fails", async () => {
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnFail("validation_error: Status is broken");
      if (args[0] === "pages" && args[1] === "trash") return ntnOk("trashed");
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("create-rollback", {
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      body_content: "# Rollback me",
      props: { Status: "待办" },
    });

    assert.equal(result.isError, true);
    assert.deepEqual(
      calls.map((args) => args.slice(0, 2)),
      [
        ["api", `v1/data_sources/${ACCEPTANCE.dataSourceId}`],
        ["pages", "create"],
        ["api", `v1/pages/${NEW_PAGE_ID}`],
        ["pages", "trash"],
      ]
    );
    assert.deepEqual(calls[3], ["pages", "trash", NEW_PAGE_ID, "--yes"]);
    assert.equal(result.details.partial, false);
    assert.equal(result.details.created_id, NEW_PAGE_ID);
    assert.equal(result.details.rollback, "trashed");
    assert.match(result.content[0].text, /validation_error/);
    assert.match(result.content[0].text, /已回滚/);
  });

  it("reports partial:true + created_id when the rollback trash also fails", async () => {
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnFail("validation_error");
      if (args[0] === "pages" && args[1] === "trash") return ntnFail("trash exploded");
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("create-rollback-fail", {
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      body_content: "# Orphan",
      props: { Status: "待办" },
    });

    assert.equal(result.isError, true);
    assert.equal(result.details.partial, true);
    assert.equal(result.details.created_id, NEW_PAGE_ID);
    assert.equal(result.details.rollback, "trash_failed");
    assert.match(result.content[0].text, /仍然存在/);
    assert.match(result.content[0].text, /trash exploded/);
    assert.equal(calls[3][2], NEW_PAGE_ID);
  });

  it("rolls back a child row when the Parent-item relation PATCH fails", async () => {
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(SELF_RELATION_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnFail("relation write rejected");
      if (args[0] === "pages" && args[1] === "trash") return ntnOk("trashed");
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("create-child-rollback", {
      parent: PARENT_ROW_ID,
      body_content: "# Child",
    });

    assert.equal(result.isError, true);
    // The failed PATCH carried the Parent-item relation, so that is the write rolled back.
    const patch = calls.find((args) => args[2] === "-X");
    assert.deepEqual(JSON.parse(patch?.[5] ?? "{}").properties["Parent-item"], {
      relation: [{ id: PARENT_ROW_ID }],
    });
    assert.deepEqual(calls.at(-1), ["pages", "trash", NEW_PAGE_ID, "--yes"]);
    assert.equal(result.details.partial, false);
    assert.equal(result.details.created_id, NEW_PAGE_ID);
    assert.match(result.content[0].text, /relation write rejected/);
  });

  it("reports an unrollable create when ntn returns no page id", async () => {
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return ntnOk("created (no json)");
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("create-no-id", {
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      body_content: "# No id",
      props: { Status: "待办" },
    });

    assert.equal(result.isError, true);
    assert.equal(result.details.partial, true);
    assert.equal(result.details.rollback, "unknown_id");
    assert.equal(calls.some((args) => args[0] === "pages" && args[1] === "trash"), false);
  });

  it("does not trash on a create that never reached ntn successfully", async () => {
    const { tool, calls } = createHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return ntnFail("parent not found");
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("create-never", {
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      body_content: "# Nope",
      props: { Status: "待办" },
    });

    assert.equal(result.isError, true);
    assert.equal(calls.some((args) => args[0] === "pages" && args[1] === "trash"), false);
    assert.match(result.content[0].text, /parent not found/);
  });
});

/* ------------------------------------------------------------------ *
 * create: failure codes
 * ------------------------------------------------------------------ */

describe("notion_page_create: error codes", () => {
  it("passes an ntn failure through with its own code, without nesting a second prefix", async () => {
    const { tool, calls } = createHarness(() => ntnFail("404 object_not_found"));
    const result = await tool.execute("create-ntn-fail", {
      parent: ACCEPTANCE.dataSourceId,
      props: { Name: "x" },
    });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 1);
    // A 404 from ntn is [NTN_FAILED]; wrapping it as INVALID_INPUT would blame the
    // arguments and put two [CODE] markers in one message.
    assert.match(result.content[0].text, /^Error: \[NTN_FAILED\] /);
    assert.equal((result.content[0].text.match(/\[[A-Z_]+\]/g) ?? []).length, 1);
  });

  it("prefixes a rejected argument with [INVALID_INPUT]", async () => {
    const { tool, calls } = createHarness();
    const result = await tool.execute("create-bad-args", {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
    assert.equal(calls.length, 0);
  });

  it("still guides the caller when a bare id is genuinely not a page", async () => {
    const { tool } = createHarness((args) => {
      if (args[0] === "api" && args[1]?.startsWith("v1/pages/")) return ntnOk({ object: "page" });
      return ntnFail(`unexpected: ${args.join(" ")}`);
    });
    const result = await tool.execute("create-bad-bare", {
      parent: ACCEPTANCE.dataSourceId,
      props: { Name: "x" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
    assert.match(result.content[0].text, /database:<id> \/ data-source:<id>/);
  });
});

/* ------------------------------------------------------------------ *
 * edit: find-and-replace (the core new behavior)
 * ------------------------------------------------------------------ */

describe("notion_page_edit: find-and-replace", () => {
  /** A page whose only interesting state is that it exists under a page parent. */
  function editScript(
    markdown: RunNtnResult = markdownOk("# 标题\n\n新的正文")
  ): (args: string[]) => RunNtnResult {
    return (args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
        return pageWithParent(PAGE_PARENT);
      }
      if (args[0] === "api" && String(args[1]).endsWith("/markdown")) return markdown;
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: EDIT_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    };
  }

  it("sends one update_content request carrying every edit, and reports how many applied", async () => {
    const { tool, calls } = editHarness(editScript());

    const result = await tool.execute("edit-replace", {
      id: EDIT_PAGE_ID,
      edits: [
        { old_str: "旧的", new_str: "新的" },
        { old_str: "第二处", new_str: "改好了" },
      ],
    });

    assert.equal(result.isError, false, text(result));
    // N edits are ONE request, not N: the API applies them sequentially server-side.
    const markdown = markdownCalls(calls);
    assert.equal(markdown.length, 1, "all edits must go in one /markdown request");
    assert.deepEqual(markdown[0].slice(0, 4), [
      "api",
      `v1/pages/${EDIT_PAGE_ID}/markdown`,
      "-X",
      "PATCH",
    ]);
    assert.deepEqual(markdownBody(calls), {
      markdown_version: "v2",
      type: "update_content",
      update_content: {
        content_updates: [
          { old_str: "旧的", new_str: "新的" },
          { old_str: "第二处", new_str: "改好了" },
        ],
      },
    });
    assert.equal(result.details.edits_applied, 2);
    assert.equal(result.details.edits_missed, 0);
    assert.deepEqual(result.details.changed, ["body_content"]);
  });

  it("sends markdown_version v2 and never allow_deleting_content", async () => {
    // v2 is what makes find-replace predictable; allow_deleting_content is the
    // escape hatch for deletions that swallow child pages, which must stay off.
    const { tool, calls } = editHarness(editScript());

    await tool.execute("edit-version", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "a", new_str: "b" }],
    });

    const body = markdownBody(calls);
    assert.equal(body.markdown_version, "v2");
    assert.equal("allow_deleting_content" in body, false);
    assert.equal("allow_deleting_content" in (body.update_content ?? {}), false);
  });

  it("passes replace_all_matches through only when the caller set it", async () => {
    const { tool, calls } = editHarness(editScript());

    await tool.execute("edit-replace-all", {
      id: EDIT_PAGE_ID,
      edits: [
        { old_str: "a", new_str: "b", replace_all_matches: true },
        { old_str: "c", new_str: "d" },
      ],
    });

    const updates = markdownBody(calls).update_content.content_updates;
    assert.equal(updates[0].replace_all_matches, true);
    // Omitted rather than sent as false: the field is optional in the API.
    assert.equal("replace_all_matches" in updates[1], false);
  });

  it("treats new_str: \"\" as a deletion instead of rejecting it", async () => {
    // Deleting the matched text is a legitimate edit; an empty new_str is NOT
    // "missing new_str". Confusing the two would make deletion impossible.
    const { tool, calls } = editHarness(editScript(markdownOk("# 标题\n\n")));

    const result = await tool.execute("edit-delete", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "删掉我", new_str: "" }],
    });

    assert.equal(result.isError, false, text(result));
    assert.deepEqual(markdownBody(calls).update_content.content_updates, [
      { old_str: "删掉我", new_str: "" },
    ]);
    assert.equal(result.details.edits_applied, 1);
  });

  it("rejects an edit with no new_str at all, before calling ntn", async () => {
    // Omitting new_str is a caller mistake (did they mean to delete? to replace?);
    // silently defaulting to "" would delete text they meant to keep.
    const { tool, calls } = editHarness();

    const result = await tool.execute("edit-missing-new", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "只有 old" }],
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
    assert.match(text(result), /new_str/);
  });

  it("surfaces a refusal to delete child pages instead of overriding allow_deleting_content", async () => {
    // THE guard that replaces the old shrink guard. `allow_deleting_content` stays
    // false, so an old_str broad enough to swallow a child-page block is refused by
    // Notion. The tool must NOT re-send with the flag: that would trade the guard for
    // a silent subtree deletion. It says what happened and how to narrow old_str.
    const { tool, calls } = editHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
        return pageWithParent(PAGE_PARENT);
      }
      if (args[0] === "api" && String(args[1]).endsWith("/markdown")) {
        return ntnFail(
          "400 validation_error: Cannot delete child pages or databases. Set allow_deleting_content to true to proceed."
        );
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("edit-delete-children", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: '段落一\n\n<page url="https://x/p/abc">子页面</page>', new_str: "" }],
    });

    assert.equal(result.isError, true);
    // Exactly one request: no retry with the flag flipped.
    assert.equal(markdownCalls(calls).length, 1);
    assert.equal(
      markdownCalls(calls).some((args) => args.join(" ").includes('"allow_deleting_content":true')),
      false,
      "the tool must never escalate allow_deleting_content on its own"
    );
    assert.match(text(result), /子页面或子数据库/);
    assert.match(text(result), /old_str/);
    assert.equal(result.details.refused, "deleting_child_content");
  });

  it("rejects an empty old_str, which can never match", async () => {
    const { tool, calls } = editHarness();
    const result = await tool.execute("edit-empty-old", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "", new_str: "x" }],
    });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
  });

  it("surfaces Notion's ambiguous-match validation_error and writes nothing else", async () => {
    // An old_str matching several places is refused by the API with 400 and nothing
    // is written. The tool must not swallow that into a success, and must not try a
    // second request afterwards.
    const { tool, calls } = editHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
        return pageWithParent(PAGE_PARENT);
      }
      if (args[0] === "api" && String(args[1]).endsWith("/markdown")) {
        return ntnFail("400 validation_error: Multiple matches found for '目标'. Found 3 matches.");
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("edit-ambiguous", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "目标", new_str: "新" }],
    });

    assert.equal(result.isError, true);
    assert.match(text(result), /Multiple matches/);
    // Exactly one write attempt: refusing must not be followed by a fallback write.
    assert.equal(markdownCalls(calls).length, 1);
    assert.equal(patchCalls(calls).length, 0);
    assert.equal(moveCalls(calls).length, 0);
  });

  it("returns ok:true plus every warning when only some edits matched", async () => {
    // The API answers 200 with a warnings array when some edits miss. This is the
    // partial-success path: the call DID change the page, so it cannot be an error,
    // but the model has to be told which edits missed.
    const warnings = [
      { code: "no_match", message: "No matches found for '不存在的文字'" },
      { code: "no_match", message: "No matches found for '另一段也没找到'" },
    ];
    const { tool, calls } = editHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
        return pageWithParent(PAGE_PARENT);
      }
      if (args[0] === "api" && String(args[1]).endsWith("/markdown")) {
        return markdownOk("# 标题\n\n改好了", { warnings });
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("edit-partial", {
      id: EDIT_PAGE_ID,
      edits: [
        { old_str: "原文", new_str: "改好了" },
        { old_str: "不存在的文字", new_str: "x" },
        { old_str: "另一段也没找到", new_str: "y" },
      ],
    });

    assert.equal(result.isError, false, text(result));
    // Echoed verbatim: the model needs Notion's own wording to fix the old_str.
    assert.deepEqual(result.details.warnings, warnings);
    assert.equal(result.details.edits_sent, 3);
    assert.equal(result.details.edits_applied, 1);
    assert.equal(result.details.edits_missed, 2);
    // The tally is derived, not guessed: applied = sent − no_match warnings.
    assert.equal(
      result.details.edits_applied,
      result.details.edits_sent - result.details.edits_missed
    );
    // The rendered text is what the model actually reads, so the misses must be in it.
    const rendered = text(result);
    assert.match(rendered, /不存在的文字/);
    assert.match(rendered, /另一段也没找到/);
    assert.equal(markdownCalls(calls).length, 1);
  });

  it("derives applied = sent − no_match warnings from a 3-edit call with one miss", async () => {
    // The exact derivation the contract pins. A mock where "everything matched" would
    // pass even if the tally were hardcoded, so one edit has to miss.
    const { tool } = editHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
        return pageWithParent(PAGE_PARENT);
      }
      if (args[0] === "api" && String(args[1]).endsWith("/markdown")) {
        return markdownOk("# 标题", {
          warnings: [{ code: "no_match", message: "No matches found for '根本没出现'" }],
        });
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("edit-tally", {
      id: EDIT_PAGE_ID,
      edits: [
        { old_str: "一", new_str: "1" },
        { old_str: "二", new_str: "2" },
        { old_str: "根本没出现", new_str: "3" },
      ],
    });

    assert.equal(result.isError, false, text(result));
    assert.equal(result.details.edits_sent, 3);
    assert.equal(result.details.edits_missed, 1);
    assert.equal(result.details.edits_applied, 2);
  });

  it("counts only no_match warnings in the tally, not every warning", async () => {
    // `warnings` also carries categories like "unsupported_tag"; folding those into
    // the edit tally would report an applied edit as missed.
    const { tool } = editHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
        return pageWithParent(PAGE_PARENT);
      }
      if (args[0] === "api" && String(args[1]).endsWith("/markdown")) {
        return markdownOk("# 标题", {
          warnings: [
            { code: "no_match", message: "No matches found for '没出现'" },
            { code: "unsupported_tag", message: "Unsupported tag <foo> was dropped" },
          ],
        });
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("edit-other-warning", {
      id: EDIT_PAGE_ID,
      edits: [
        { old_str: "出现", new_str: "ok" },
        { old_str: "没出现", new_str: "x" },
      ],
    });

    assert.equal(result.isError, false, text(result));
    assert.equal(result.details.edits_sent, 2);
    assert.equal(result.details.edits_missed, 1);
    assert.equal(result.details.edits_applied, 1);
    // Both warnings are still surfaced verbatim: only the TALLY ignores non-no_match.
    assert.equal(result.details.warnings.length, 2);
    assert.match(text(result), /unsupported_tag/);
  });

  it("omits warnings entirely when the API returned none", async () => {
    // Absence is the clean signal; an always-present empty array trains the model
    // to ignore the field.
    const { tool } = editHarness(editScript(markdownOk("# ok", { warnings: [] })));
    const result = await tool.execute("edit-no-warnings", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "a", new_str: "b" }],
    });
    assert.equal(result.isError, false, text(result));
    assert.equal("warnings" in result.details, false);
  });

  it("surfaces truncated:true so the model knows the markdown is not the full page", async () => {
    // `truncated` is the only signal that the returned markdown cannot be trusted as
    // the whole body; silently dropping it would make the model reason about a page
    // it has only partly seen.
    const { tool } = editHarness(editScript(markdownOk("# 部分内容", { truncated: true })));

    const result = await tool.execute("edit-truncated", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "a", new_str: "b" }],
    });

    assert.equal(result.isError, false, text(result));
    assert.equal(result.details.truncated, true);
    assert.match(text(result), /truncat|截断|不完整/i);
  });

  it("folds props.block_update into edits as a compat alias", async () => {
    const { tool, calls } = editHarness(editScript());

    const result = await tool.execute("edit-block-update", {
      id: EDIT_PAGE_ID,
      props: { block_update: [{ old_str: "旧", new_str: "新" }] },
    });

    assert.equal(result.isError, false, text(result));
    assert.deepEqual(markdownBody(calls).update_content.content_updates, [
      { old_str: "旧", new_str: "新" },
    ]);
  });

  it("rejects edits and props.block_update together as ambiguous", async () => {
    // Two spellings of one intent with different content is a caller mistake:
    // picking one silently writes something they did not ask for.
    const { tool, calls } = editHarness();

    const result = await tool.execute("edit-both-spellings", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "a", new_str: "b" }],
      props: { block_update: [{ old_str: "c", new_str: "d" }] },
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
    assert.match(text(result), /edits/);
    assert.match(text(result), /block_update/);
  });
});

/* ------------------------------------------------------------------ *
 * edit: append (edits empty + body_content)
 * ------------------------------------------------------------------ */

describe("notion_page_edit: append", () => {
  function appendScript(): (args: string[]) => RunNtnResult {
    return (args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
        return pageWithParent(PAGE_PARENT);
      }
      if (args[0] === "api" && String(args[1]).endsWith("/markdown")) {
        return markdownOk("# 标题\n\n原文\n\n追加的段落");
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    };
  }

  it("appends body_content at the end when edits are absent", async () => {
    const { tool, calls } = editHarness(appendScript());

    const result = await tool.execute("edit-append", {
      id: EDIT_PAGE_ID,
      body_content: "追加的段落",
    });

    assert.equal(result.isError, false, text(result));
    assert.equal(markdownCalls(calls).length, 1);
    assert.deepEqual(markdownBody(calls), {
      markdown_version: "v2",
      type: "insert_content",
      insert_content: {
        content: "追加的段落",
        position: { type: "end" },
      },
    });
    assert.deepEqual(result.details.changed, ["body_content"]);
    // `appended` is how the rendered value distinguishes "added to the end" from
    // "replaced text" now that there is no `action` field.
    assert.equal(result.details.appended, true);
    // An append is not a find-replace, so there is no edit tally to report.
    assert.equal(result.details.edits_sent, undefined);
    assert.match(text(result), /追加/);
  });

  it("appends when edits is an empty array and body_content is set", async () => {
    // An empty edits array means "no find-replace", which leaves append as the only
    // reading of body_content.
    const { tool, calls } = editHarness(appendScript());

    const result = await tool.execute("edit-append-empty", {
      id: EDIT_PAGE_ID,
      edits: [],
      body_content: "追加的段落",
    });

    assert.equal(result.isError, false, text(result));
    assert.equal(markdownBody(calls).type, "insert_content");
  });

  it("rejects body_content alongside a non-empty edits array", async () => {
    // Both together is genuinely ambiguous: append the text, or replace each match
    // with it? Refusing is the only reading that cannot silently do the wrong thing.
    const { tool, calls } = editHarness();

    const result = await tool.execute("edit-append-conflict", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "a", new_str: "b" }],
      body_content: "追加的段落",
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
  });

  it("refuses an edit with no content change and no property change", async () => {
    const { tool, calls } = editHarness();
    const result = await tool.execute("edit-empty", { id: EDIT_PAGE_ID });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
  });
});

/* ------------------------------------------------------------------ *
 * edit: properties, title, icon (still the PATCH v1/pages/<id> path)
 * ------------------------------------------------------------------ */

describe("notion_page_edit: property, title and icon writes", () => {
  function propsScript(schema: unknown = DATA_SOURCE_SCHEMA): (args: string[]) => RunNtnResult {
    return (args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
        return pageWithParent(DS_PARENT);
      }
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(schema);
      }
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: EDIT_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    };
  }

  it("maps multiple props keys to one Notion property PATCH", async () => {
    const { tool, calls } = editHarness(propsScript());

    const result = await tool.execute("edit-props", {
      id: EDIT_PAGE_ID,
      props: {
        Status: "待办",
        标签: ["键盘", "客制化"],
        截止日期: "2025-12-31",
        Done: true,
      },
    });

    assert.equal(result.isError, false, text(result));
    const patches = patchCalls(calls);
    assert.equal(patches.length, 1);
    assert.deepEqual(JSON.parse(patches[0][5]), {
      properties: {
        Status: { status: { name: "待办" } },
        标签: { multi_select: [{ name: "键盘" }, { name: "客制化" }] },
        截止日期: { date: { start: "2025-12-31" } },
        Done: { checkbox: true },
      },
    });
    assert.deepEqual(result.details.properties, ["Status", "标签", "截止日期", "Done"]);
    assert.deepEqual(result.details.changed, ["properties"]);
  });

  it("edits an icon-only page with exactly one PATCH and no property map", async () => {
    const { tool, calls } = editHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
        return pageWithParent(PAGE_PARENT);
      }
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: EDIT_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("edit-icon-only", {
      id: EDIT_PAGE_ID,
      icon: "🎯",
    });

    assert.equal(result.isError, false, text(result));
    const patches = patchCalls(calls);
    assert.equal(patches.length, 1, "an icon-only edit is exactly one PATCH");
    assert.equal("properties" in patchBody(calls), false);
    assert.deepEqual(patchBody(calls), { icon: { type: "emoji", emoji: "🎯" } });
    assert.deepEqual(result.details.changed, ["icon"]);
    assert.deepEqual(result.details.properties, []);
  });

  it("updates the title property when only title is given", async () => {
    const { tool, calls } = editHarness(propsScript());

    const result = await tool.execute("edit-title", { id: EDIT_PAGE_ID, title: "改名" });

    assert.equal(result.isError, false, text(result));
    assert.deepEqual(JSON.parse(patchCalls(calls)[0][5]), {
      properties: { Name: { title: [{ type: "text", text: { content: "改名" } }] } },
    });
    assert.deepEqual(result.details.changed, ["title"]);
  });

  it("rejects unknown property names and lists writable columns", async () => {
    const { tool, calls } = editHarness(propsScript());

    const result = await tool.execute("edit-unknown-prop", {
      id: EDIT_PAGE_ID,
      props: { 不存在的列: "x" },
    });

    assert.equal(result.isError, true);
    assert.equal(patchCalls(calls).length, 0, "no property write may run for an unknown property");
    assert.match(result.content[0].text, /未知属性/);
    assert.ok(
      (result.details.hint_properties ?? []).some((hint: { name: string }) => hint.name === "Name")
    );
  });

  it("writes props.icon as the real column when the data source has one", async () => {
    const { tool, calls } = editHarness(propsScript(ICON_COLUMN_SCHEMA));
    const result = await tool.execute("edit-icon-column", {
      id: EDIT_PAGE_ID,
      props: { icon: "列值" },
    });
    assert.equal(result.isError, false, text(result));
    assert.deepEqual(patchBody(calls), {
      properties: { icon: { rich_text: [{ type: "text", text: { content: "列值" } }] } },
    });
  });
});

/* ------------------------------------------------------------------ *
 * edit: combined content + properties + move, and failure debt
 * ------------------------------------------------------------------ */

describe("notion_page_edit: combined operations and failure debt", () => {
  /**
   * A page with a data-source parent and one target parent page.
   * `failPatch` / `failMove` let a test make the LATER step fail after content
   * has already landed.
   */
  function combinedScript(options: {
    failPatch?: boolean;
    failMove?: boolean;
  } = {}): (args: string[]) => RunNtnResult {
    return (args) => {
      const path = String(args[1] ?? "");
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
        return pageWithParent(DS_PARENT);
      }
      if (args[0] === "api" && args[1] === `v1/pages/${NEW_PAGE_ID}` && args[3] !== "PATCH") {
        return pageWithParent(PAGE_PARENT);
      }
      if (args[0] === "api" && args[1] === `v1/pages/${ACCEPTANCE.parentPageId}` && args[3] !== "PATCH") {
        return pageWithParent({ type: "workspace", workspace: true });
      }
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "api" && path.endsWith("/markdown")) {
        return markdownOk("# 标题\n\n新的正文");
      }
      if (args[0] === "api" && path.endsWith("/move")) {
        if (options.failMove) return ntnFail("move rejected");
        return ntnOk({ object: "page", id: EDIT_PAGE_ID, parent: PAGE_PARENT });
      }
      if (args[0] === "api" && args[2] === "-X") {
        if (options.failPatch) return ntnFail("property write rejected");
        return ntnOk({ object: "page", id: EDIT_PAGE_ID });
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    };
  }

  /** Index of a call the script would make, found by predicate. */
  function indexOfCall(calls: string[][], predicate: (args: string[]) => boolean): number {
    return calls.findIndex(predicate);
  }

  it("applies content, then properties, then the move, in that fixed order", async () => {
    const { tool, calls } = editHarness(combinedScript());

    const result = await tool.execute("edit-combined", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "旧的", new_str: "新的" }],
      props: { Done: true },
      parent: `page:${NEW_PAGE_ID}`,
    });

    assert.equal(result.isError, false, text(result));
    const contentAt = indexOfCall(calls, (args) => String(args[1]).endsWith("/markdown"));
    const propsAt = indexOfCall(calls, (args) => args[3] === "PATCH" && !String(args[1]).endsWith("/markdown"));
    const moveAt = indexOfCall(calls, (args) => String(args[1]).endsWith("/move"));
    assert.ok(contentAt >= 0, "content edit must run");
    assert.ok(propsAt >= 0, "property PATCH must run");
    assert.ok(moveAt >= 0, "move must run");
    // Content first is the user's explicit choice: a move can change the parent,
    // which can change which data source the property schema comes from.
    assert.ok(contentAt < propsAt, `content (${contentAt}) must precede properties (${propsAt})`);
    assert.ok(propsAt < moveAt, `properties (${propsAt}) must precede the move (${moveAt})`);
    assert.deepEqual(result.details.changed, ["body_content", "properties", "parent"]);
  });

  it("discloses that content already landed when the property PATCH fails", async () => {
    // THE most important new test. The old design's sin was reporting a plain
    // failure when a write had already happened: the model retried or gave up
    // believing the page was untouched. A failure after content landed must say so.
    const { tool, calls } = editHarness(combinedScript({ failPatch: true }));

    const result = await tool.execute("edit-debt-patch", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "旧的", new_str: "新的" }],
      props: { Done: true },
    });

    assert.equal(result.isError, true);
    // The content request DID happen and is not rolled back (find-replace cannot be).
    assert.equal(markdownCalls(calls).length, 1);
    assert.match(result.content[0].text, /property write rejected/);
    // The message must state what already landed, and which step failed.
    assert.match(text(result), /已经生效的部分：内容/);
    // The count is the actual value the model needs to judge a retry: 1 of 1 edits.
    assert.match(text(result), /内容（1\/1 条 edits）/);
    assert.match(text(result), /失败的部分：/);
    assert.match(text(result), /属性\/标题\/icon/);
    assert.match(text(result), /不会回滚/);
    // Structured: `partial` + the applied steps, mirroring the create-rollback details.
    assert.equal(result.details.partial, true);
    assert.deepEqual(result.details.applied, ["内容（1/1 条 edits）"]);
    assert.deepEqual(result.details.failed_steps, ["属性/标题/icon（PATCH 页面属性/icon）"]);
  });

  it("discloses that content and properties already landed when the move fails", async () => {
    // Same rule one step later: after a content edit succeeds and a property PATCH
    // succeeds, a failed move must report BOTH as already applied.
    const { tool, calls } = editHarness(combinedScript({ failMove: true }));

    const result = await tool.execute("edit-debt-move", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "旧的", new_str: "新的" }],
      props: { Done: true },
      parent: `page:${NEW_PAGE_ID}`,
    });

    assert.equal(result.isError, true);
    assert.equal(markdownCalls(calls).length, 1);
    assert.equal(patchCalls(calls).length, 1);
    assert.match(result.content[0].text, /move rejected/);
    // Both earlier writes are named, in the order they were applied.
    assert.match(text(result), /已经生效的部分：内容（1\/1 条 edits）、属性（Done）/);
    assert.match(text(result), /失败的部分：/);
    assert.match(text(result), /移动页面/);
    assert.equal(result.details.partial, true);
    assert.deepEqual(result.details.applied, ["内容（1/1 条 edits）", "属性（Done）"]);
    assert.deepEqual(result.details.failed_steps, ["移动页面（parent）"]);
  });

  it("reports a clean failure with no debt when the content request itself fails", async () => {
    // The mirror case: nothing landed, so nothing may be claimed as applied.
    const { tool } = editHarness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
        return pageWithParent(PAGE_PARENT);
      }
      if (args[0] === "api" && String(args[1]).endsWith("/markdown")) {
        return ntnFail("500 boom");
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("edit-debt-none", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "a", new_str: "b" }],
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /500 boom/);
    assert.notEqual(result.details.content_applied, true);
  });
});

describe("notion_page_trash: the refusal must SHOW the children, not just count them", () => {
  /**
   * A refused recursive delete is only useful if the caller can see what it would
   * have destroyed. `details` is never model-facing (DSH drops it before rendering),
   * so the ids have to live in the MESSAGE. This regressed once already: the text
   * said "有 2 个子页面" with no ids at all, so a model could not report what was at
   * risk without extra round trips.
   */
  const CHILD_A = "aaaaaaaa-1111-4111-8111-111111111111";
  const CHILD_B = "bbbbbbbb-2222-4222-8222-222222222222";

  const scripted = (args: string[]): RunNtnResult => {
    const joined = args.join(" ");
    // The page itself: a normal, readable page.
    if (joined.startsWith("api v1/pages/")) {
      return ntnOk({ id: EDIT_PAGE_ID, object: "page", in_trash: false, parent: PAGE_PARENT });
    }
    // Its children: one real child page and one child database.
    if (joined.includes("/children")) {
      return ntnOk({
        object: "list",
        has_more: false,
        next_cursor: null,
        results: [
          { id: CHILD_A, type: "child_page", has_children: false, child_page: { title: "A 子页面" } },
          {
            id: CHILD_B,
            type: "child_database",
            has_children: false,
            child_database: { title: "B 子数据库" },
          },
        ],
      });
    }
    return ntnFail("unexpected call");
  };

  it("lists every child id and title in the error text the model receives", async () => {
    const { tool, calls } = trashHarness(scripted);
    const result = await tool.execute("trash-children", { id: EDIT_PAGE_ID, yes: true });

    assert.equal(result.isError, true);
    const rendered = text(result);
    // Both children must be named, with their ids, in the message itself.
    assert.match(rendered, new RegExp(CHILD_A), "child page id missing from the message");
    assert.match(rendered, new RegExp(CHILD_B), "child database id missing from the message");
    assert.match(rendered, /A 子页面/);
    assert.match(rendered, /B 子数据库/);
    // And it must still say how to proceed.
    assert.match(rendered, /recursive/);
    // The refusal must never reach ntn pages trash: nothing may be deleted.
    assert.equal(
      calls.some((args) => args[0] === "pages" && args[1] === "trash"),
      false,
      "a refused recursive delete must not call ntn pages trash"
    );
  });

  it("distinguishes a nesting CONTAINER from a real child page in the message", async () => {
    // A toggle with content is reported by listChildPages as a container, not a page.
    // Saying "1 个子页面" for it would be factually wrong and send the caller looking
    // for a child page that does not exist.
    const toggleOnly = (args: string[]): RunNtnResult => {
      const joined = args.join(" ");
      if (joined.startsWith("api v1/pages/")) {
        return ntnOk({ id: EDIT_PAGE_ID, object: "page", in_trash: false, parent: PAGE_PARENT });
      }
      if (joined.includes("/children")) {
        return ntnOk({
          object: "list",
          has_more: false,
          next_cursor: null,
          results: [
            { id: CHILD_A, type: "toggle", has_children: true, toggle: { rich_text: [] } },
          ],
        });
      }
      return ntnFail("unexpected call");
    };

    const { tool } = trashHarness(toggleOnly);
    const rendered = text(await tool.execute("trash-toggle", { id: EDIT_PAGE_ID, yes: true }));
    assert.match(rendered, /嵌套容器/);
    assert.doesNotMatch(rendered, /\[子页面\]/);
  });
});

describe("notion_page_edit: LOCAL validation failures must also disclose prior writes", () => {
  /**
   * The content edit lands BEFORE properties/title/icon are validated. A LOCAL
   * validation error in step 2 (a bad title, a props array, an unknown column) is
   * thrown by the validators, not by the network — so a disclosure that only wraps
   * the PATCH misses every one of them. A caller then sees "bad argument", fixes the
   * argument and retries, double-applying an edit that had already succeeded.
   */
  const script = (args: string[]): RunNtnResult => {
    const path = String(args[1] ?? "");
    if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
      return pageWithParent(DS_PARENT);
    }
    if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
      return ntnOk(DATA_SOURCE_SCHEMA);
    }
    if (args[0] === "api" && path.endsWith("/markdown")) {
      return markdownOk("# 标题\n\n新的正文");
    }
    return ntnFail(`unexpected call: ${args.join(" ")}`);
  };

  it("names the already-written content when the title is rejected by LOCAL validation", async () => {
    const { tool, calls } = editHarness(script);
    const result = await tool.execute("edit-local-title", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "旧", new_str: "新" }],
      // Setting a title column to null is refused by buildPropertyWrite, locally.
      props: { title: null },
    });

    assert.equal(result.isError, true);
    // The content request DID run and is not rolled back.
    assert.equal(calls.filter((args) => String(args[1] ?? "").endsWith("/markdown")).length, 1);
    const rendered = text(result);
    // The model must be told the content already landed...
    assert.match(rendered, /已经生效的部分：内容/);
    assert.match(rendered, /不会回滚/);
    // ...and what failed.
    assert.match(rendered, /属性\/标题\/icon/);
    assert.equal(result.details.partial, true);
    assert.deepEqual(result.details.applied, ["内容（1/1 条 edits）"]);
    assert.deepEqual(result.details.failed_steps, ["属性/标题/icon（PATCH 页面属性/icon）"]);
  });

  it("names the already-written content when an UNKNOWN COLUMN is rejected by LOCAL validation", async () => {
    // buildPropertyWrite rejects an unknown column locally, after the content landed.
    const { tool } = editHarness(script);
    const result = await tool.execute("edit-local-column", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "旧", new_str: "新" }],
      props: { "No Such Column": 1 },
    });

    assert.equal(result.isError, true);
    const rendered = text(result);
    assert.match(rendered, /已经生效的部分：内容/);
    assert.match(rendered, /不会回滚/);
    assert.equal(result.details.partial, true);
  });

  it("has NO debt to disclose when the props SHAPE is wrong, because that is rejected before any write", async () => {
    // `props` is normalized in execute() BEFORE editPage runs, so a wrong shape never
    // reaches the content edit. Claiming "content already written" here would be a lie
    // in the opposite direction, which matters just as much.
    const { tool, calls } = editHarness(script);
    const result = await tool.execute("edit-local-shape", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "旧", new_str: "新" }],
      props: [{ a: 1 }] as unknown as Record<string, unknown>,
    });

    assert.equal(result.isError, true);
    assert.doesNotMatch(text(result), /已经生效的部分/);
    assert.notEqual(result.details.partial, true);
    // Proof nothing was written: no markdown request was ever issued.
    assert.equal(calls.filter((args) => String(args[1] ?? "").endsWith("/markdown")).length, 0);
  });

  it("stays a plain error (no debt) when the content edit itself failed", async () => {
    // Nothing was written, so there is no debt to disclose: the failure must not
    // claim a partial write that did not happen.
    const failMarkdown = (args: string[]): RunNtnResult => {
      if (String(args[1] ?? "").endsWith("/markdown")) return ntnFail("no matches");
      return script(args);
    };
    const { tool } = editHarness(failMarkdown);
    const result = await tool.execute("edit-local-nocontent", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "旧", new_str: "新" }],
      props: { title: null },
    });
    assert.equal(result.isError, true);
    assert.doesNotMatch(text(result), /已经生效的部分/);
    assert.notEqual(result.details.partial, true);
  });
});

describe("notion_page_create: a leading H1 must never vanish", () => {
  /**
   * `ntn pages create` silently swallows a `# Heading` that directly follows the
   * frontmatter block the plugin prepends — the page comes back with the title set
   * and the heading GONE, reported as a clean success. A direct API call keeps it,
   * so this is the CLI's parser, but the plugin is the thing that fed it the content:
   * the user's words must survive. These tests pin the content the plugin SENDS.
   */
  function createScript(): (args: string[]) => RunNtnResult {
    return (args) => {
      if (args[0] === "pages" && args[1] === "create") {
        return ntnOk({ object: "page", id: NEW_PAGE_ID, url: "https://app.notion.com/p/x" });
      }
      if (args[0] === "api" && String(args[1] ?? "").startsWith("v1/pages/")) {
        return ntnOk({ object: "page", id: NEW_PAGE_ID });
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    };
  }

  const contentOf = (calls: string[][]): string => {
    const args = calls.find((a) => a[0] === "pages" && a[1] === "create");
    assert.ok(args, "no pages create call");
    const flag = args.find((a) => a.startsWith("--content="));
    assert.ok(flag, "no --content flag");
    return flag.slice("--content=".length);
  };

  it("keeps a differing H1 as text instead of letting the CLI swallow it", async () => {
    const { tool, calls } = createHarness(createScript());
    await tool.execute("create-h1-diff", {
      parent: `page:${ACCEPTANCE.parentPageId}`,
      title: "Diff H1",
      body_content: "# Other H1\n\nbody",
    });

    const content = contentOf(calls);
    // The heading TEXT must still be in the payload, escaped so the CLI does not eat it.
    assert.match(content, /Other H1/);
    assert.match(content, /\\# Other H1/, "the H1 must be escaped; an unescaped one is dropped");
    // And the body after it must survive too.
    assert.match(content, /body/);
  });

  it("still dedupes when the H1 equals the title (that case is intentional)", async () => {
    const { tool, calls } = createHarness(createScript());
    await tool.execute("create-h1-same", {
      parent: `page:${ACCEPTANCE.parentPageId}`,
      title: "Same Title",
      body_content: "# Same Title\n\nonly body",
    });

    const content = contentOf(calls);
    // The heading becomes the page title, so it must NOT be repeated as a heading.
    assert.doesNotMatch(content, /^# Same Title/m);
    assert.doesNotMatch(content, /\\# Same Title/);
    assert.match(content, /only body/);
  });
});

describe("notion_page_edit: steps are independent — one failing must not cancel the others", () => {
  /**
   * The three steps (content, properties/icon, move) do not depend on each other. An
   * old_str that matches nothing is a bad ARGUMENT, not a broken page, so a valid title
   * or a valid move must still be applied. Refusing them would leave the caller with
   * neither, and the natural retry (fix old_str, resend everything) would then
   * re-apply the steps that had already succeeded.
   */
  function ev(args: string[]): RunNtnResult {
    const path = String(args[1] ?? "");
    if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}` && args[3] !== "PATCH") {
      return pageWithParent(DS_PARENT);
    }
    if (args[0] === "api" && args[1] === `v1/pages/${NEW_PAGE_ID}` && args[3] !== "PATCH") {
      return pageWithParent(PAGE_PARENT);
    }
    if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
      return ntnOk(DATA_SOURCE_SCHEMA);
    }
    // The content step always misses: Notion answers with a validation_error.
    if (args[0] === "api" && path.endsWith("/markdown")) {
      return ntnFail("No matches found for NOT PRESENT.\n\nFetch the page again");
    }
    if (args[0] === "api" && path.endsWith("/move")) {
      return ntnOk({ object: "page", id: EDIT_PAGE_ID, parent: PAGE_PARENT });
    }
    if (args[0] === "api" && args[2] === "-X") {
      return ntnOk({ object: "page", id: EDIT_PAGE_ID });
    }
    return ntnFail(`unexpected call: ${args.join(" ")}`);
  }

  it("still applies the title, icon and move when the content edit fails", async () => {
    const { tool, calls } = editHarness(ev);
    const result = await tool.execute("edit-independent", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "NOT PRESENT", new_str: "x" }],
      title: "新标题",
      icon: "🎯",
      parent: `page:${NEW_PAGE_ID}`,
    });

    assert.equal(result.isError, true);
    // The later steps really ran — this is the whole point of the change.
    const patches = calls.filter((a) => a[2] === "-X" && a[1] === `v1/pages/${EDIT_PAGE_ID}`);
    assert.equal(patches.length, 1, "properties/icon PATCH must still run");
    assert.equal(
      calls.filter((a) => String(a[1] ?? "").endsWith("/move")).length,
      1,
      "the move must still run"
    );
    // And the report separates what landed from what did not.
    // The acceptance data source names its title column "Name", not "title".
    assert.deepEqual(result.details.applied, ["属性（Name）", "icon"]);
    assert.deepEqual(result.details.failed_steps, ["正文（edits）"]);
    const rendered = text(result);
    assert.match(rendered, /部分成功/);
    assert.match(rendered, /已经生效的部分：属性（Name）、icon/);
    assert.match(rendered, /正文（edits）/);
    assert.match(rendered, /不会回滚/);
  });

  it("reports a plain error when EVERY step fails, with no misleading 'already written' text", async () => {
    const allFail = (args: string[]): RunNtnResult => {
      const path = String(args[1] ?? "");
      if (path.endsWith("/markdown")) return ntnFail("No matches found for NOT PRESENT.");
      if (path.endsWith("/move")) return ntnFail("move rejected");
      if (args[2] === "-X") return ntnFail("property write rejected");
      return ev(args);
    };
    const { tool } = editHarness(allFail);
    const result = await tool.execute("edit-allfail", {
      id: EDIT_PAGE_ID,
      edits: [{ old_str: "NOT PRESENT", new_str: "x" }],
      props: { Done: true },
      parent: `page:${NEW_PAGE_ID}`,
    });

    assert.equal(result.isError, true);
    // Nothing landed, so nothing may be claimed as applied.
    assert.doesNotMatch(text(result), /已经生效的部分/);
    assert.doesNotMatch(text(result), /部分成功/);
    assert.notEqual(result.details.partial, true);
  });
});
