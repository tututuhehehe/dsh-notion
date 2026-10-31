import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createNotionPageTool } from "../src/tools/page.ts";
import type { NtnRunner, PageToolValue } from "../src/tools/page.ts";
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

/** Mount the real tool definition the way DSH does, with a scripted `ntn` runner. */
function harness(handler: (args: string[]) => RunNtnResult = () => ntnOk("{}")): {
  tool: MountedTool<PageToolValue>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: NtnRunner = async (options) => {
    calls.push(options.args);
    return handler(options.args);
  };
  const tool = mount(createNotionPageTool({ runNtn: runner }));
  assert.equal(tool.name, "notion_page");
  return { tool, calls };
}

function pageCreateResponse(pageId: string): RunNtnResult {
  return ntnOk({ object: "page", id: pageId, url: `https://app.notion.com/p/${pageId.replace(/-/g, "")}` });
}

function pageWithParent(parent: Record<string, unknown>): RunNtnResult {
  return ntnOk({ object: "page", id: "ignored", parent });
}

/** GET v1/pages body with both a parent and current property values (attach checks). */
function pageWithProps(
  parent: Record<string, unknown>,
  properties: Record<string, unknown>
): RunNtnResult {
  return ntnOk({ object: "page", id: "ignored", parent, properties });
}

const DS_PARENT = { type: "data_source_id", data_source_id: ACCEPTANCE.dataSourceId };

const NEW_PAGE_ID = "11111111-1111-4111-8111-111111111111";
const EDIT_PAGE_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_ROW_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ROW_ID = "44444444-4444-4444-8444-444444444444";

describe("notion_page registration", () => {
  it("exposes create/edit/attach/trash, no top-level content and no top-level icon", () => {
    const { tool } = harness();
    const properties = tool.parameters?.properties ?? {};
    assert.deepEqual(Object.keys(properties).sort(), ["action", "id", "parent", "props", "title", "yes"]);
    assert.equal("content" in properties, false);
    // icon is a reserved key inside props, never a top-level parameter.
    assert.equal("icon" in properties, false);
    assert.equal(tool.parameters?.additionalProperties, false);
    assert.deepEqual(tool.parameters?.required, ["action"]);
    assert.match(tool.description ?? "", /props\.body_content/);
    assert.match(tool.description ?? "", /props\.icon/);
  });
});

describe("notion_page dispatch guards", () => {
  it("rejects an unknown action (including the rejected move name) without calling ntn", async () => {
    const { tool, calls } = harness();
    for (const action of ["move", "delete", ""]) {
      const result = await tool.execute("call-action", {
        action,
        id: EDIT_PAGE_ID,
        parent: `page:${NEW_PAGE_ID}`,
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /未知 action/);
      assert.match(result.content[0].text, /没有 move/);
    }
    assert.equal(calls.length, 0);
  });

  it("rejects parameters that the action does not own instead of silently dropping them", async () => {
    const { tool, calls } = harness();
    const cases: { params: Record<string, unknown>; expected: RegExp }[] = [
      {
        params: { action: "trash", id: EDIT_PAGE_ID, yes: true, props: { body_content: "x" } },
        expected: /trash 只接受 \{ action, id, yes \}/,
      },
      {
        params: { action: "create", id: EDIT_PAGE_ID, parent: `page:${ACCEPTANCE.parentPageId}` },
        expected: /create 只接受/,
      },
      {
        params: {
          action: "create",
          parent: `page:${ACCEPTANCE.parentPageId}`,
          title: "t",
          yes: true,
        },
        expected: /create 只接受/,
      },
      {
        params: { action: "edit", id: EDIT_PAGE_ID, title: "t", yes: true },
        expected: /edit 只接受/,
      },
      {
        params: { action: "edit", id: EDIT_PAGE_ID, parent: `page:${NEW_PAGE_ID}`, props: { Done: true } },
        expected: /edit 只接受/,
      },
    ];
    for (const { params, expected } of cases) {
      const result = await tool.execute("call-params", params);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, expected);
      assert.ok(Array.isArray(result.details.unexpected_params));
    }
    assert.equal(calls.length, 0);
  });
});

describe("notion_page create", () => {
  it("creates a page body from props.body_content (no top-level content, no PATCH)", async () => {
    const { tool, calls } = harness(() => pageCreateResponse(NEW_PAGE_ID));

    const result = await tool.execute("call-1", {
      action: "create",
      parent: `page:${ACCEPTANCE.parentPageId}`,
      props: { body_content: "# Hello\n\nbody" },
    });

    assert.equal(result.isError, false);
    assert.equal(calls.length, 1);

    const args = calls[0];
    assert.deepEqual(args.slice(0, 3), ["pages", "create", "--json"]);
    assert.equal(args[args.indexOf("--parent") + 1], `page:${ACCEPTANCE.parentPageId}`);
    // Leading H1 becomes the frontmatter title ntn documents; body keeps the rest.
    const contentArg = args.find((arg) => arg.startsWith("--content="));
    assert.ok(contentArg, "create must pass --content=<markdown> as one argv element");
    assert.equal(contentArg, `--content=---\ntitle: "Hello"\n---\n\nbody`);
    assert.ok(!args.includes("-X"), "body_content must not trigger a property PATCH");
    assert.ok(!args.join(" ").includes("body_content"), "reserved key must never reach ntn");

    assert.equal(result.details.ok, true);
    assert.equal(result.details.id, NEW_PAGE_ID);
    assert.deepEqual(result.details.properties, []);
  });

  it("rejects the removed top-level content for every action without calling ntn", async () => {
    const { tool, calls } = harness();

    for (const action of ["create", "edit", "attach", "trash"]) {
      const result = await tool.execute(`content-${action}`, {
        action,
        id: EDIT_PAGE_ID,
        parent: `page:${ACCEPTANCE.parentPageId}`,
        content: "# body",
        yes: true,
      });
      assert.equal(result.isError, true);
      // DSH's schema has additionalProperties:false; the body still fails loudly instead of
      // silently dropping the argument, and says where the Markdown really goes.
      assert.match(text(result), /多余的参数：.*content/);
      if (action === "create" || action === "edit") {
        assert.match(text(result), /props\.body_content/);
      }
    }
    assert.equal(calls.length, 0);
  });

  it("rejects a non-string body_content before calling ntn", async () => {
    const { tool, calls } = harness();
    const result = await tool.execute("call-1b", {
      action: "create",
      parent: `page:${ACCEPTANCE.parentPageId}`,
      props: { body_content: { text: "nope" } },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /body_content.*Markdown 字符串/);
    assert.equal(calls.length, 0);
  });

  it("resolves database:<id> through datasources resolve and never reads v1/databases (C4)", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "datasources") return ntnOk(resolveResponse(ACCEPTANCE.dataSourceId));
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: NEW_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-2", {
      action: "create",
      parent: `database:${ACCEPTANCE_DATABASE_ID}`,
      props: { Name: "新行", Status: "待办" },
    });

    assert.equal(result.isError, false);
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
    const { tool, calls } = harness((args) =>
      args[0] === "datasources" ? ntnOk(resolveResponse(ACCEPTANCE.dataSourceId, other)) : ntnOk({})
    );

    const result = await tool.execute("call-3", {
      action: "create",
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
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      return pageCreateResponse(NEW_PAGE_ID);
    });

    const result = await tool.execute("call-4", {
      action: "create",
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      props: { Status: "待办" },
    });

    assert.equal(result.isError, true);
    // Only the schema lookup ran: no page was created without a title.
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
    const { tool, calls } = harness();

    const result = await tool.execute("call-5", {
      action: "create",
      parent: `page:${ACCEPTANCE.parentPageId}`,
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /props\.body_content 或 title/);
  });

  it("passes markdown starting with '-' as a single --content= argument", async () => {
    const { tool, calls } = harness(() => pageCreateResponse(NEW_PAGE_ID));

    const result = await tool.execute("call-6", {
      action: "create",
      parent: `page:${ACCEPTANCE.parentPageId}`,
      props: { body_content: "- one\n- two" },
    });

    assert.equal(result.isError, false);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("--content=- one\n- two"));
  });

  it("lets the title argument win over the title property in props", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: NEW_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-7", {
      action: "create",
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      title: "A",
      props: { Name: "B", body_content: "body" },
    });

    assert.equal(result.isError, false);
    assert.match(calls[1].find((arg) => arg.startsWith("--content=")) ?? "", /title: "A"/);
    assert.deepEqual(JSON.parse(calls[2][5]), {
      properties: { Name: { title: [{ type: "text", text: { content: "A" } }] } },
    });
    assert.equal(result.details.title, "A");
  });

  it("refuses to write a body when the data source has a real body_content column", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(BODY_COLUMN_SCHEMA);
      }
      return pageCreateResponse(NEW_PAGE_ID);
    });

    const result = await tool.execute("call-8", {
      action: "create",
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      props: { Name: "冲突", body_content: "正文" },
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 1, "no page may be created while the reserved key conflicts");
    assert.match(result.content[0].text, /保留键/);
    assert.equal(result.details.conflict, true);
  });

  it("creates a child row from a bare parent row id and links Parent-item", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) {
        return pageWithParent(DS_PARENT);
      }
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(SELF_RELATION_SCHEMA);
      }
      if (args[0] === "pages") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: NEW_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-9", {
      action: "create",
      parent: PARENT_ROW_ID,
      props: { Name: "子任务", Status: "待办" },
    });

    assert.equal(result.isError, false);
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
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) {
        return pageWithParent(DS_PARENT);
      }
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      return pageCreateResponse(NEW_PAGE_ID);
    });

    const result = await tool.execute("call-10", {
      action: "create",
      parent: PARENT_ROW_ID,
      props: { Name: "子任务" },
    });

    assert.equal(result.isError, true);
    assert.equal(calls.some((args) => args[0] === "pages"), false);
    assert.match(result.content[0].text, /Parent-item/);
    assert.match(result.content[0].text, /没有任何 relation 列/);
    assert.ok(
      (result.details.hint_properties ?? []).some(
        (hint: { name: string }) => hint.name === "Name"
      )
    );
  });

  it("rejects a bare id that is not a readable page with prefix guidance", async () => {
    const { tool, calls } = harness(() => ntnFail("404 object_not_found"));
    const result = await tool.execute("call-11", {
      action: "create",
      parent: ACCEPTANCE.dataSourceId,
      props: { Name: "x" },
    });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 1);
    assert.match(result.content[0].text, /database:<id> \/ data-source:<id>/);
  });
});

describe("notion_page error codes", () => {
  // DSH forwards only `message` to the model, so every code must be visible in it.
  it("prefixes a rejected argument with [INVALID_INPUT]", async () => {
    const { tool, calls } = harness();
    const result = await tool.execute("call-code-1", { action: "create" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
    assert.equal(calls.length, 0);
  });

  it("prefixes a failed ntn call with [NTN_FAILED]", async () => {
    const { tool } = harness(() => ntnFail("boom: not logged in"));
    const result = await tool.execute("call-code-2", {
      action: "trash",
      id: EDIT_PAGE_ID,
      yes: true,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[NTN_FAILED\] /);
    assert.match(result.content[0].text, /boom: not logged in/);
  });

  it("reports a cleanup that left a page behind as [PARTIAL_WRITE]", async () => {
    const { tool } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(SELF_RELATION_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnFail("relation write rejected");
      if (args[0] === "pages" && args[1] === "trash") return ntnFail("trash rejected");
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });
    const result = await tool.execute("call-code-3", {
      action: "create",
      parent: PARENT_ROW_ID,
      props: { body_content: "# Child" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[PARTIAL_WRITE\] /);
    assert.match(result.content[0].text, /partial: true/);
    assert.match(result.content[0].text, /回滚失败/);
    assert.equal(result.details.partial, true);
  });

  it("reports a successful rollback under the original code, not PARTIAL_WRITE", async () => {
    const { tool } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(SELF_RELATION_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnFail("relation write rejected");
      if (args[0] === "pages" && args[1] === "trash") return ntnOk("trashed");
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });
    const result = await tool.execute("call-code-4", {
      action: "create",
      parent: PARENT_ROW_ID,
      props: { body_content: "# Child" },
    });
    assert.equal(result.isError, true);
    // The page was trashed, so this is an ordinary ntn failure, not a partial write.
    assert.match(result.content[0].text, /^Error: \[NTN_FAILED\] /);
    assert.match(result.content[0].text, /partial: false/);
    assert.doesNotMatch(result.content[0].text, /PARTIAL_WRITE/);
    assert.equal(result.details.partial, false);
  });
});

describe("notion_page icon", () => {
  function createScript(): (args: string[]) => RunNtnResult {
    return (args) => {
      if (args[0] === "pages") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: NEW_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    };
  }

  function patchBody(calls: string[][]): Record<string, unknown> {
    const patch = calls.find((args) => args[2] === "-X");
    if (!patch) throw new Error("expected a PATCH call");
    return JSON.parse(patch[5]) as Record<string, unknown>;
  }

  it("writes props.icon as an emoji in the follow-up PATCH, with no properties key", async () => {
    const { tool, calls } = harness(createScript());

    const result = await tool.execute("icon-create-emoji", {
      action: "create",
      parent: `page:${ACCEPTANCE.parentPageId}`,
      title: "Icon page",
      props: { icon: "🎯" },
    });

    assert.equal(result.isError, false, text(result));
    const create = calls.find((args) => args[0] === "pages") ?? [];
    assert.equal(create[1], "create");
    assert.deepEqual(patchBody(calls), { icon: { type: "emoji", emoji: "🎯" } });
    assert.equal("properties" in patchBody(calls), false);
    assert.deepEqual(result.details.properties, []);
    assert.equal(result.details.icon, "🎯");
    assert.deepEqual(result.details.changed, ["icon"]);
  });

  it("writes an http(s) props.icon as a Notion external file icon", async () => {
    const url = "https://x.test/a.png";
    const { tool, calls } = harness(createScript());

    const result = await tool.execute("icon-create-url", {
      action: "create",
      parent: `page:${ACCEPTANCE.parentPageId}`,
      title: "Icon page",
      props: { icon: url },
    });

    assert.equal(result.isError, false, text(result));
    assert.deepEqual(patchBody(calls), { icon: { type: "external", external: { url } } });
    assert.equal("properties" in patchBody(calls), false);
    assert.equal(result.details.icon, url);
  });

  it("sends icon: null to clear the icon, still without a properties key", async () => {
    const { tool, calls } = harness(createScript());

    const result = await tool.execute("icon-create-clear", {
      action: "create",
      parent: `page:${ACCEPTANCE.parentPageId}`,
      title: "Icon page",
      props: { icon: null },
    });

    assert.equal(result.isError, false, text(result));
    assert.deepEqual(patchBody(calls), { icon: null });
    assert.equal("properties" in patchBody(calls), false);
    assert.equal(result.details.icon, null);
  });

  it("edits an icon-only page with exactly one PATCH and no property map", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}`) {
        return pageWithParent({ type: "page_id", page_id: ACCEPTANCE.parentPageId });
      }
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: EDIT_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("icon-edit-only", {
      action: "edit",
      id: EDIT_PAGE_ID,
      props: { icon: "🎯" },
    });

    assert.equal(result.isError, false, text(result));
    const patches = calls.filter((args) => args[2] === "-X");
    assert.equal(patches.length, 1, "an icon-only edit is exactly one PATCH");
    assert.equal("properties" in patchBody(calls), false);
    assert.deepEqual(patchBody(calls), { icon: { type: "emoji", emoji: "🎯" } });
    assert.deepEqual(result.details.changed, ["icon"]);
    assert.deepEqual(result.details.properties, []);
  });

  it("refuses props.icon when the data source has a real column named icon", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(ICON_COLUMN_SCHEMA);
      }
      return pageCreateResponse(NEW_PAGE_ID);
    });

    const result = await tool.execute("icon-conflict", {
      action: "create",
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      title: "冲突",
      props: { icon: "🎯" },
    });

    assert.equal(result.isError, true);
    assert.match(text(result), /保留键/);
    assert.match(text(result), /icon/);
    assert.deepEqual(result.details.reserved_keys, ["icon"]);
    assert.equal(result.details.conflict, true);
    // Only the schema read ran: the reserved-key conflict must never create a page.
    assert.equal(calls.length, 1);
    assert.equal(calls.some((args) => args[0] === "pages"), false);
  });

  it("rejects an over-long non-URL icon string as invalid input, before any ntn call", async () => {
    const { tool, calls } = harness(createScript());

    const result = await tool.execute("icon-invalid", {
      action: "create",
      parent: `page:${ACCEPTANCE.parentPageId}`,
      title: "Icon page",
      props: { icon: "this is definitely not an emoji" },
    });

    assert.equal(result.isError, true);
    assert.match(text(result), /既不是 emoji 也不是图片 URL/);
    assert.equal(result.details.property, "icon");
    assert.equal(calls.length, 0);
  });
});

describe("notion_page edit", () => {
  it("refuses edit with neither props nor title, without calling ntn", async () => {
    const { tool, calls } = harness();

    const result = await tool.execute("call-12", { action: "edit", id: EDIT_PAGE_ID });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /edit 需要 props.*至少一项/);
  });

  it("edits the body via props.body_content using pages edit", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}`) {
        return pageWithParent({ type: "page_id", page_id: ACCEPTANCE.parentPageId });
      }
      if (args[0] === "pages") return ntnOk({ object: "page", id: EDIT_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-13", {
      action: "edit",
      id: EDIT_PAGE_ID,
      props: { body_content: "# New body" },
    });

    assert.equal(result.isError, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].slice(0, 3), ["pages", "edit", EDIT_PAGE_ID]);
    assert.equal(calls[1][3], "--content=# New body");
    assert.equal(calls[1][4], "--json");
    assert.deepEqual(result.details.changed, ["body_content"]);
  });

  it("maps multiple props keys to one Notion property PATCH", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: EDIT_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-14", {
      action: "edit",
      id: EDIT_PAGE_ID,
      props: {
        Status: "待办",
        标签: ["键盘", "客制化"],
        截止日期: "2025-12-31",
        Done: true,
      },
    });

    assert.equal(result.isError, false);
    assert.equal(calls.length, 3);
    const patch = calls[2];
    assert.deepEqual(patch.slice(0, 5), ["api", `v1/pages/${EDIT_PAGE_ID}`, "-X", "PATCH", "--data"]);
    assert.deepEqual(JSON.parse(patch[5]), {
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

  it("runs pages edit and then PATCH when body_content and props are both given", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages") return ntnOk({ object: "page", id: EDIT_PAGE_ID });
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: EDIT_PAGE_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-15", {
      action: "edit",
      id: EDIT_PAGE_ID,
      props: { body_content: "更新后的正文", Done: true },
    });

    assert.equal(result.isError, false);
    assert.equal(calls.length, 4);
    assert.equal(calls[2][0], "pages");
    assert.equal(calls[2][1], "edit");
    assert.equal(calls[3][3], "PATCH");
    assert.deepEqual(result.details.changed, ["body_content", "properties"]);
  });

  it("rejects unknown property names and lists writable columns", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      return ntnOk({ object: "page", id: EDIT_PAGE_ID });
    });

    const result = await tool.execute("call-16", {
      action: "edit",
      id: EDIT_PAGE_ID,
      props: { 不存在的列: "x" },
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 2, "no PATCH may run for an unknown property");
    assert.match(result.content[0].text, /未知属性/);
    assert.ok(
      (result.details.hint_properties ?? []).some(
        (hint: { name: string }) => hint.name === "Name"
      )
    );
  });

  it("updates the title property when only title is given", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      return ntnOk({ object: "page", id: EDIT_PAGE_ID });
    });

    const result = await tool.execute("call-17", {
      action: "edit",
      id: EDIT_PAGE_ID,
      title: "改名",
    });

    assert.equal(result.isError, false);
    assert.equal(calls.length, 3);
    assert.deepEqual(JSON.parse(calls[2][5]), {
      properties: {
        Name: { title: [{ type: "text", text: { content: "改名" } }] },
      },
    });
  });

  it("refuses a body edit when the data source has a real body_content column", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(BODY_COLUMN_SCHEMA);
      }
      return ntnOk({ object: "page", id: EDIT_PAGE_ID });
    });

    const result = await tool.execute("call-18", {
      action: "edit",
      id: EDIT_PAGE_ID,
      props: { body_content: "正文" },
    });

    assert.equal(result.isError, true);
    assert.equal(calls.some((args) => args[0] === "pages"), false);
    assert.match(result.content[0].text, /body_content/);
  });

  it("resolves a legacy database_id parent via datasources resolve (no v1/databases read)", async () => {
    const legacyRow = "77777777-7777-4777-8777-777777777777";
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${legacyRow}`) {
        return pageWithParent({ type: "database_id", database_id: ACCEPTANCE_DATABASE_ID });
      }
      if (args[0] === "datasources") return ntnOk(resolveResponse(ACCEPTANCE.dataSourceId));
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: legacyRow });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-19b", {
      action: "edit",
      id: legacyRow,
      props: { Done: true },
    });

    assert.equal(result.isError, false, result.content[0].text);
    assert.deepEqual(calls[1], ["datasources", "resolve", ACCEPTANCE_DATABASE_ID, "--json"]);
    assert.equal(
      calls.some((args) => args[1]?.startsWith("v1/databases/")),
      false,
      "legacy database_id must still resolve through data sources"
    );
  });

  it("treats a whitespace-only body as no body and refuses the empty edit", async () => {
    const { tool, calls } = harness();
    const result = await tool.execute("call-19", {
      action: "edit",
      id: EDIT_PAGE_ID,
      props: { body_content: "   " },
    });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /edit 需要 props.*至少一项/);
  });
});

describe("notion_page attach", () => {
  it("moves a page under another page with POST /v1/pages/{id}/move", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}`) {
        return pageWithParent({ type: "page_id", page_id: ACCEPTANCE.parentPageId });
      }
      if (args[0] === "api" && args[1] === `v1/pages/${NEW_PAGE_ID}`) {
        return pageWithParent({ type: "page_id", page_id: ACCEPTANCE.parentPageId });
      }
      if (args[0] === "api" && args[1] === `v1/pages/${ACCEPTANCE.parentPageId}`) {
        return pageWithParent({ type: "workspace", workspace: true });
      }
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}/move`) {
        return ntnOk({ object: "page", id: EDIT_PAGE_ID, parent: { type: "page_id", page_id: NEW_PAGE_ID } });
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-20", {
      action: "attach",
      id: EDIT_PAGE_ID,
      parent: `page:${NEW_PAGE_ID}`,
    });

    assert.equal(result.isError, false, result.content[0].text);
    assert.deepEqual(calls, [
      ["api", `v1/pages/${EDIT_PAGE_ID}`],
      ["api", `v1/pages/${NEW_PAGE_ID}`],
      ["api", `v1/pages/${ACCEPTANCE.parentPageId}`],
      ["api", `v1/pages/${EDIT_PAGE_ID}/move`, "-X", "POST", "--data", JSON.stringify({ parent: { page_id: NEW_PAGE_ID } })],
    ]);
    assert.deepEqual(result.details.changed, ["parent"]);
    assert.equal(result.details.parent, `page:${NEW_PAGE_ID}`);
    assert.equal(result.details.cycle_check, "walked");
  });

  it("accepts a bare page id parent by classifying it with GET v1/pages", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${NEW_PAGE_ID}`) {
        return pageWithParent({ type: "page_id", page_id: ACCEPTANCE.parentPageId });
      }
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}`) {
        return pageWithParent({ type: "page_id", page_id: ACCEPTANCE.parentPageId });
      }
      if (args[0] === "api" && args[1] === `v1/pages/${ACCEPTANCE.parentPageId}`) {
        return pageWithParent({ type: "workspace", workspace: true });
      }
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}/move`) {
        return ntnOk({ object: "page", id: EDIT_PAGE_ID });
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-20b", {
      action: "attach",
      id: EDIT_PAGE_ID,
      parent: NEW_PAGE_ID,
    });

    assert.equal(result.isError, false, result.content[0].text);
    assert.equal(result.details.parent, `page:${NEW_PAGE_ID}`);
    // classify the bare id once, read the child once, walk the page ancestors, then move.
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0], ["api", `v1/pages/${NEW_PAGE_ID}`]);
  });

  it("rejects props/title on attach (it is not a write, not a file upload)", async () => {
    const { tool, calls } = harness();
    for (const extra of [{ props: { body_content: "x" } }, { title: "x" }]) {
      const result = await tool.execute("call-21", {
        action: "attach",
        id: EDIT_PAGE_ID,
        parent: `page:${NEW_PAGE_ID}`,
        ...extra,
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /只接受 \{ action, id, parent, yes \}/);
    }
    assert.equal(calls.length, 0);
  });

  it("rejects database/data-source parents for attach before calling ntn", async () => {
    const { tool, calls } = harness();
    const result = await tool.execute("call-22", {
      action: "attach",
      id: EDIT_PAGE_ID,
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
    });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /attach 的 parent 只支持 page:<id>/);
  });

  it("links a row under a parent row through the Parent-item self-relation", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(SELF_RELATION_SCHEMA);
      }
      if (args[0] === "api" && args[1] === `v1/pages/${OTHER_ROW_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: OTHER_ROW_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-23", {
      action: "attach",
      id: OTHER_ROW_ID,
      parent: PARENT_ROW_ID,
    });

    assert.equal(result.isError, false);
    const patch = calls.find((args) => args[2] === "-X") ?? [];
    assert.deepEqual(JSON.parse(patch[5]), {
      properties: { "Parent-item": { relation: [{ id: PARENT_ROW_ID }] } },
    });
    assert.equal(result.details.parent_item_property, "Parent-item");
    assert.deepEqual(result.details.changed, ["parent_item_relation"]);
  });

  it("explains when the data source has no Parent-item relation", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "api" && args[1] === `v1/pages/${OTHER_ROW_ID}`) return pageWithParent(DS_PARENT);
      return ntnOk({ object: "page", id: OTHER_ROW_ID });
    });

    const result = await tool.execute("call-24", {
      action: "attach",
      id: OTHER_ROW_ID,
      parent: PARENT_ROW_ID,
    });

    assert.equal(result.isError, true);
    assert.equal(calls.some((args) => args[2] === "-X"), false);
    assert.match(result.content[0].text, /Parent-item/);
    assert.match(result.content[0].text, /没有任何 relation 列/);
  });

  it("refuses to link a page under a row", async () => {
    const { tool } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(SELF_RELATION_SCHEMA);
      }
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}`) {
        return pageWithParent({ type: "page_id", page_id: ACCEPTANCE.parentPageId });
      }
      return ntnOk({});
    });

    const result = await tool.execute("call-25", {
      action: "attach",
      id: EDIT_PAGE_ID,
      parent: PARENT_ROW_ID,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /不在数据库里/);
  });

  it("refuses to link rows from different data sources", async () => {
    const otherDs = "66666666-6666-4666-8666-666666666666";
    const { tool } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(SELF_RELATION_SCHEMA);
      }
      if (args[0] === "api" && args[1] === `v1/pages/${OTHER_ROW_ID}`) {
        return pageWithParent({ type: "data_source_id", data_source_id: otherDs });
      }
      return ntnOk({});
    });

    const result = await tool.execute("call-26", {
      action: "attach",
      id: OTHER_ROW_ID,
      parent: PARENT_ROW_ID,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /同一 data source/);
  });

  it("rejects attaching a page that is already a child of the target", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}`) {
        return pageWithParent({ type: "page_id", page_id: NEW_PAGE_ID });
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-27", {
      action: "attach",
      id: EDIT_PAGE_ID,
      parent: `page:${NEW_PAGE_ID}`,
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 1);
    assert.match(result.content[0].text, /已经是/);
  });
});

describe("notion_page create atomicity", () => {
  const THIRD_ROW_ID = "55555555-5555-4555-8555-555555555555";

  it("trashes the new page when the follow-up props PATCH fails", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnFail("validation_error: Status is broken");
      if (args[0] === "pages" && args[1] === "trash") return ntnOk("trashed");
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-40", {
      action: "create",
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      props: { body_content: "# Rollback me", Status: "待办" },
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
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnFail("validation_error");
      if (args[0] === "pages" && args[1] === "trash") return ntnFail("trash exploded");
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-41", {
      action: "create",
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      props: { body_content: "# Orphan", Status: "待办" },
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
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) return pageWithParent(DS_PARENT);
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(SELF_RELATION_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnFail("relation write rejected");
      if (args[0] === "pages" && args[1] === "trash") return ntnOk("trashed");
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-42", {
      action: "create",
      parent: PARENT_ROW_ID,
      props: { body_content: "# Child" },
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
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return ntnOk("created (no json)");
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-43", {
      action: "create",
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      props: { body_content: "# No id", Status: "待办" },
    });

    assert.equal(result.isError, true);
    assert.equal(result.details.partial, true);
    assert.equal(result.details.rollback, "unknown_id");
    assert.equal(calls.some((args) => args[0] === "pages" && args[1] === "trash"), false);
  });

  it("does not trash on a create that never reached ntn successfully", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DATA_SOURCE_SCHEMA);
      }
      if (args[0] === "pages" && args[1] === "create") return ntnFail("parent not found");
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-44", {
      action: "create",
      parent: `data-source:${ACCEPTANCE.dataSourceId}`,
      props: { body_content: "# Nope", Status: "待办" },
    });

    assert.equal(result.isError, true);
    assert.equal(calls.some((args) => args[0] === "pages" && args[1] === "trash"), false);
    assert.match(result.content[0].text, /parent not found/);
    assert.equal(THIRD_ROW_ID.length, 36);
  });
});

describe("notion_page attach guards", () => {
  const OTHER_PARENT_ID = "55555555-5555-4555-8555-555555555555";

  function rowHarness(options: {
    parentProps?: Record<string, unknown>;
    childProps?: Record<string, unknown>;
    patch?: () => RunNtnResult;
  } = {}) {
    return harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) {
        return pageWithProps(DS_PARENT, options.parentProps ?? {});
      }
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(SELF_RELATION_SCHEMA);
      }
      if (args[0] === "api" && args[1] === `v1/pages/${OTHER_ROW_ID}`) {
        return pageWithProps(DS_PARENT, options.childProps ?? {});
      }
      if (args[0] === "api" && args[1] === `v1/pages/${OTHER_PARENT_ID}`) {
        return pageWithProps(DS_PARENT, {});
      }
      if (args[0] === "api" && args[2] === "-X") {
        return options.patch ? options.patch() : ntnOk({ object: "page", id: OTHER_ROW_ID });
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });
  }

  it("refuses to attach a page under itself without calling ntn beyond the lookup", async () => {
    const { tool, calls } = harness(() =>
      pageWithParent({ type: "page_id", page_id: ACCEPTANCE.parentPageId })
    );

    const result = await tool.execute("call-50", {
      action: "attach",
      id: NEW_PAGE_ID,
      parent: `page:${NEW_PAGE_ID}`,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /不能挂到自己下面/);
    assert.equal(calls.some((args) => args.includes("/move")), false);
    assert.equal(calls.length, 1);
  });

  it("refuses a deep page cycle (A→B→A) before moving", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${NEW_PAGE_ID}`) {
        return pageWithParent({ type: "page_id", page_id: ACCEPTANCE.parentPageId });
      }
      if (args[0] === "api" && args[1] === `v1/pages/${EDIT_PAGE_ID}`) {
        return pageWithParent({ type: "page_id", page_id: NEW_PAGE_ID });
      }
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const result = await tool.execute("call-51", {
      action: "attach",
      id: NEW_PAGE_ID,
      parent: `page:${EDIT_PAGE_ID}`,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /会形成环/);
    assert.equal(calls.some((args) => args.includes("/move")), false);
    assert.equal(result.details.cycle, true);
    assert.deepEqual(result.details.cycle_path, [EDIT_PAGE_ID, NEW_PAGE_ID]);
  });

  it("refuses a row cycle (A→B→A) before writing the relation", async () => {
    const { tool, calls } = rowHarness({
      childProps: { "Parent-item": { relation: [{ id: PARENT_ROW_ID }] } },
    });

    // Attaching PARENT_ROW_ID under OTHER_ROW_ID would close the existing A→B chain.
    const result = await tool.execute("call-52", {
      action: "attach",
      id: PARENT_ROW_ID,
      parent: OTHER_ROW_ID,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /会形成 Parent-item 环/);
    assert.equal(calls.some((args) => args[2] === "-X"), false);
  });

  it("refuses to overwrite a different Parent-item parent without yes:true", async () => {
    const { tool, calls } = rowHarness({
      childProps: { "Parent-item": { relation: [{ id: OTHER_PARENT_ID }] } },
    });

    const result = await tool.execute("call-53", {
      action: "attach",
      id: OTHER_ROW_ID,
      parent: PARENT_ROW_ID,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /yes: true/);
    assert.deepEqual(result.details.current_parent_ids, [OTHER_PARENT_ID]);
    assert.equal(result.details.overwrite, true);
    assert.equal(calls.some((args) => args[2] === "-X"), false);
  });

  it("overwrites the Parent-item parent with yes:true (replacing, not merging)", async () => {
    const { tool, calls } = rowHarness({
      childProps: { "Parent-item": { relation: [{ id: OTHER_PARENT_ID }] } },
    });

    const result = await tool.execute("call-54", {
      action: "attach",
      id: OTHER_ROW_ID,
      parent: PARENT_ROW_ID,
      yes: true,
    });

    assert.equal(result.isError, false, result.content[0].text);
    const patch = calls.find((args) => args[2] === "-X") ?? [];
    assert.deepEqual(JSON.parse(patch[5]), {
      properties: { "Parent-item": { relation: [{ id: PARENT_ROW_ID }] } },
    });
    assert.deepEqual(result.details.replaced_parent_ids, [OTHER_PARENT_ID]);
    assert.deepEqual(result.details.changed, ["parent_item_relation"]);
  });

  it("treats attaching to the same parent as an idempotent no-op", async () => {
    const { tool, calls } = rowHarness({
      childProps: { "Parent-item": { relation: [{ id: PARENT_ROW_ID }] } },
    });

    const result = await tool.execute("call-55", {
      action: "attach",
      id: OTHER_ROW_ID,
      parent: PARENT_ROW_ID,
    });

    assert.equal(result.isError, false, result.content[0].text);
    assert.equal(result.details.already_linked, true);
    assert.deepEqual(result.details.changed, []);
    assert.equal(calls.some((args) => args[2] === "-X"), false);
  });

  it("treats a multi-parent relation containing the target as an overwrite, not a no-op", async () => {
    const { tool, calls } = rowHarness({
      childProps: {
        "Parent-item": { relation: [{ id: PARENT_ROW_ID }, { id: OTHER_PARENT_ID }] },
      },
    });

    const refused = await tool.execute("call-55b", {
      action: "attach",
      id: OTHER_ROW_ID,
      parent: PARENT_ROW_ID,
    });
    assert.equal(refused.isError, true);
    assert.deepEqual(refused.details.current_parent_ids, [PARENT_ROW_ID, OTHER_PARENT_ID]);

    const replaced = await tool.execute("call-55c", {
      action: "attach",
      id: OTHER_ROW_ID,
      parent: PARENT_ROW_ID,
      yes: true,
    });
    assert.equal(replaced.isError, false, replaced.content[0].text);
    const patch = calls.find((args) => args[2] === "-X") ?? [];
    assert.deepEqual(JSON.parse(patch[5]), {
      properties: { "Parent-item": { relation: [{ id: PARENT_ROW_ID }] } },
    });
    assert.deepEqual(replaced.details.replaced_parent_ids, [PARENT_ROW_ID, OTHER_PARENT_ID]);
  });

  it("writes the named Parent item column, never the Sub-item dual", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) return pageWithProps(DS_PARENT, {});
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(DUAL_RELATION_SCHEMA);
      }
      if (args[0] === "api" && args[1] === `v1/pages/${OTHER_ROW_ID}`) return pageWithProps(DS_PARENT, {});
      if (args[0] === "pages" && args[1] === "create") return pageCreateResponse(NEW_PAGE_ID);
      if (args[0] === "api" && args[2] === "-X") return ntnOk({ object: "page", id: OTHER_ROW_ID });
      return ntnFail(`unexpected call: ${args.join(" ")}`);
    });

    const attach = await tool.execute("call-55d", {
      action: "attach",
      id: OTHER_ROW_ID,
      parent: PARENT_ROW_ID,
    });
    assert.equal(attach.isError, false, attach.content[0].text);
    assert.equal(attach.details.parent_item_property, ACCEPTANCE.parentItemColumn);
    const patch = calls.find((args) => args[2] === "-X") ?? [];
    const body = JSON.parse(patch[5]).properties;
    assert.deepEqual(Object.keys(body), [ACCEPTANCE.parentItemColumn]);
    assert.equal("Sub-item" in body, false);

    const created = await tool.execute("call-55e", {
      action: "create",
      parent: PARENT_ROW_ID,
      props: { body_content: "# Child" },
    });
    assert.equal(created.isError, false, created.content[0].text);
    const createPatch = calls.filter((args) => args[2] === "-X").at(-1) ?? [];
    const createdBody = JSON.parse(createPatch[5]).properties;
    assert.deepEqual(createdBody[ACCEPTANCE.parentItemColumn], {
      relation: [{ id: PARENT_ROW_ID }],
    });
    assert.equal("Sub-item" in createdBody, false);
  });

  it("refuses when an ancestor row cannot be read (cannot prove there is no cycle)", async () => {
    const { tool, calls } = harness((args) => {
      if (args[0] === "api" && args[1] === `v1/pages/${PARENT_ROW_ID}`) {
        // The parent row's own ancestor exists but cannot be read.
        return pageWithProps(DS_PARENT, { "Parent-item": { relation: [{ id: OTHER_PARENT_ID }] } });
      }
      if (args[0] === "api" && args[1] === `v1/data_sources/${ACCEPTANCE.dataSourceId}`) {
        return ntnOk(SELF_RELATION_SCHEMA);
      }
      if (args[0] === "api" && args[1] === `v1/pages/${OTHER_ROW_ID}`) {
        return pageWithProps(DS_PARENT, {});
      }
      if (args[0] === "api" && args[1] === `v1/pages/${OTHER_PARENT_ID}`) {
        return ntnFail("insufficient permissions");
      }
      return ntnOk({});
    });

    const result = await tool.execute("call-56", {
      action: "attach",
      id: OTHER_ROW_ID,
      parent: PARENT_ROW_ID,
      yes: true,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /无法读取祖先行/);
    assert.equal(result.details.cycle_check, "unreadable");
    assert.equal(calls.some((args) => args[2] === "-X"), false);
  });
});

describe("notion_page trash", () => {
  it("rejects a malformed id without building an API path", async () => {
    const { tool, calls } = harness();

    const result = await tool.execute("call-28", {
      action: "trash",
      id: "abc/../blocks?x=1",
      yes: true,
    });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /id 无效/);
  });

  it("refuses trash without yes:true and never calls ntn", async () => {
    const { tool, calls } = harness();

    const result = await tool.execute("call-29", { action: "trash", id: EDIT_PAGE_ID });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /yes: true/);
  });

  it("trashes with yes:true", async () => {
    const { tool, calls } = harness(() => ntnOk("trashed"));

    const result = await tool.execute("call-30", {
      action: "trash",
      id: EDIT_PAGE_ID,
      yes: true,
    });

    assert.equal(result.isError, false);
    assert.deepEqual(calls, [["pages", "trash", EDIT_PAGE_ID, "--yes"]]);
    assert.deepEqual(result.details.changed, ["trashed"]);
  });
});
