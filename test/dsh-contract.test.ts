/**
 * Contract tests against DSH's OWN schema rules.
 *
 * `test/fixtures/dsh-json-schema.ts` is a verbatim copy of the validator the running
 * DeepSeek Harness uses, so these assertions fail exactly when the real registry would
 * reject a definition. `mount()` already applies them on every success; this file pins
 * the rules themselves so a regression names the cause.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertOutput, mount } from "./fixtures/dsh.ts";
import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from "./fixtures/dsh-json-schema.ts";
import { createNotionGetTool } from "../src/tools/get.ts";
import {
  createNotionPageCreateTool,
  createNotionPageEditTool,
  createNotionPageTrashTool,
} from "../src/tools/page.ts";
import { createNotionQueryTool } from "../src/tools/query.ts";
import { createNotionSearchTool } from "../src/tools/search.ts";

const inertRun = async () => ({ ok: true, stdout: "{}", stderr: "", code: 0 });

const DEFINITIONS = [
  createNotionSearchTool({ run: inertRun }),
  createNotionGetTool(inertRun),
  createNotionPageCreateTool({ runNtn: inertRun }),
  createNotionPageEditTool({ runNtn: inertRun }),
  createNotionPageTrashTool({ runNtn: inertRun }),
  createNotionQueryTool({ runNtn: inertRun }),
];

describe("DSH schema compliance", () => {
  it("every definition's parameters and output schema are inside the enforced subset", () => {
    for (const tool of DEFINITIONS) {
      assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters), tool.name);
      assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), tool.name);
    }
  });

  it("rejects the constraint keywords DSH does not enforce", () => {
    // These are what a hand-written schema reaches for and what DSH refuses; keeping
    // them out is why notion_query's parameter type survives PTC rendering.
    for (const keyword of ["minLength", "maxLength", "pattern", "minimum", "format"]) {
      const schema = { type: "object", properties: { x: { type: "string", [keyword]: 1 } } };
      assert.throws(() => assertSupportedJsonSchema(schema), /not a supported keyword/, keyword);
    }
  });

  it("declares additionalProperties on every tool so the PTC type is closed", () => {
    for (const tool of DEFINITIONS) {
      assert.equal(
        (tool.parameters as { additionalProperties?: unknown }).additionalProperties,
        false,
        `${tool.name} should close its parameter object`
      );
    }
  });

  it("keeps notion_get's page/database union expressible as a legal oneOf root", () => {
    const get = createNotionGetTool(inertRun);
    assert.ok(Array.isArray((get.output.schema as { oneOf?: unknown }).oneOf));
    assert.doesNotThrow(() => assertSupportedJsonSchema(get.output.schema));
  });
});

/* ------------------------------------------------------------------ *
 * The three-tool split, pinned at the schema level
 * ------------------------------------------------------------------ */

type ParamSchema = {
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
};

function paramSchema(tool: { parameters: unknown }): ParamSchema {
  return tool.parameters as ParamSchema;
}

describe("the page split is expressible to the model", () => {
  const create = createNotionPageCreateTool({ runNtn: inertRun });
  const edit = createNotionPageEditTool({ runNtn: inertRun });
  const trash = createNotionPageTrashTool({ runNtn: inertRun });

  it("registers three distinct tool names and no combined notion_page", () => {
    const names = DEFINITIONS.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "notion_get",
      "notion_page_create",
      "notion_page_edit",
      "notion_page_trash",
      "notion_query",
      "notion_search",
    ]);
    assert.equal(
      names.includes("notion_page"),
      false,
      "the combined tool must be gone, not merely deprecated"
    );
  });

  it("exposes icon and body_content as TOP-LEVEL parameters on create and edit", () => {
    for (const tool of [create, edit]) {
      const properties = paramSchema(tool).properties;
      assert.equal(properties.icon !== undefined, true, `${tool.name} needs a top-level icon`);
      assert.equal(
        properties.body_content !== undefined,
        true,
        `${tool.name} needs a top-level body_content`
      );
      // Both are siblings of title, not props keys.
      assert.equal(properties.title !== undefined, true);
    }
    // The props description says "COLUMNS ONLY" so the model does not put the body in props.
    assert.match(String(paramSchema(create).properties.props.description), /COLUMNS ONLY/);
  });

  it("exposes `edits` on edit as an array of {old_str, new_str, replace_all_matches?}", () => {
    const edits = paramSchema(edit).properties.edits;
    assert.equal(edits.type, "array");
    assert.deepEqual(edits.items.required, ["old_str", "new_str"]);
    assert.deepEqual(Object.keys(edits.items.properties).sort(), [
      "new_str",
      "old_str",
      "replace_all_matches",
    ]);
    assert.equal(edits.items.additionalProperties, false);
  });

  it("never advertises `action` or `confirm_shrink` on any of the three tools", () => {
    for (const tool of [create, edit, trash]) {
      const properties = paramSchema(tool).properties;
      assert.equal("action" in properties, false, `${tool.name} must not take action`);
      assert.equal(
        "confirm_shrink" in properties,
        false,
        `${tool.name} must not take confirm_shrink`
      );
    }
  });

  it("keeps the runtime-only compat alias props.block_update out of the schema", () => {
    // `props.block_update` is accepted at runtime (folded into `edits`) but is
    // deliberately NOT advertised: it is a compat alias, not something to teach.
    const props = String(paramSchema(edit).properties.props.description);
    assert.doesNotMatch(props, /block_update/);
    assert.equal(paramSchema(edit).properties.block_update, undefined);
  });

  it("requires `yes` on trash, `parent` on create and `id` on edit/trash", () => {
    assert.deepEqual(paramSchema(trash).required, ["id", "yes"]);
    assert.deepEqual(paramSchema(create).required, ["parent"]);
    assert.deepEqual(paramSchema(edit).required, ["id"]);
  });
});

describe("output values satisfy their declared schema", () => {
  it("a search result validates", async () => {
    const tool = createNotionSearchTool({
      run: async () => ({
        ok: true,
        stdout: JSON.stringify({
          results: [{ object: "page", id: "p1", url: "https://x/p1", title: "T" }],
          has_more: false,
        }),
        stderr: "",
        code: 0,
      }),
    });
    const mounted = mount(tool);
    const result = await mounted.execute("c1", { query: "t" });
    assert.equal(result.isError, false);
    // mount() already asserted it; re-assert here so this file fails loudly if the
    // fixture ever stops validating.
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result.value, "value"), []);
  });

  it("a page create value validates, including created and the icon field", async () => {
    const tool = createNotionPageCreateTool({
      runNtn: async () => ({
        ok: true,
        stdout: JSON.stringify({ object: "page", id: "11111111-1111-4111-8111-111111111111" }),
        stderr: "",
        code: 0,
      }),
    });
    const value = {
      ok: true,
      created: true,
      id: "11111111-1111-4111-8111-111111111111",
      properties: [],
      changed: ["icon"],
      icon: "🎯",
    };
    assert.doesNotThrow(() => assertOutput(tool, value));
  });

  it("an edit value with warnings, the tally and truncated validates", async () => {
    const tool = createNotionPageEditTool({ runNtn: inertRun });
    const value = {
      ok: true,
      id: "11111111-1111-4111-8111-111111111111",
      properties: [],
      changed: ["body_content"],
      edits_sent: 3,
      edits_applied: 2,
      edits_missed: 1,
      warnings: [{ code: "no_match", message: "No matches found for 'x'" }],
      truncated: true,
    };
    assert.doesNotThrow(() => assertOutput(tool, value));
  });

  it("rejects a warning entry that is not {code, message}", () => {
    // The warnings schema is closed; a shape drift there would ship to the model.
    const tool = createNotionPageEditTool({ runNtn: inertRun });
    const bad = {
      ok: true,
      properties: [],
      changed: [],
      warnings: [{ code: "no_match" }],
    };
    assert.throws(() => assertOutput(tool, bad));
  });

  it("rejects an output value that still carries the removed `action` field", () => {
    // `action` was dropped from the value on purpose; the closed output schema must
    // refuse to let it back in silently.
    const tool = createNotionPageCreateTool({ runNtn: inertRun });
    assert.throws(() =>
      assertOutput(tool, {
        ok: true,
        action: "create",
        properties: [],
        changed: [],
      })
    );
  });
});

describe("argument guards: no internal TypeError may reach the model", () => {
  // The DSH registry does not validate arguments against `parameters`, so a missing or
  // mistyped value would otherwise surface as "Cannot read properties of undefined" —
  // an implementation detail with nothing the caller can act on.
  it("notion_get without id_or_url", async () => {
    const result = await mount(createNotionGetTool(inertRun)).execute("c1", {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
    assert.doesNotMatch(result.content[0].text, /Cannot read|is not a function/);
  });

  it("notion_get with a non-string id", async () => {
    const result = await mount(createNotionGetTool(inertRun)).execute("c2", { id_or_url: 123 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
  });

  it("notion_query with a numeric data source", async () => {
    const result = await mount(createNotionQueryTool({ runNtn: inertRun })).execute("c3", {
      database_or_data_source: 5,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
  });

  it("notion_query with a non-string sort entry", async () => {
    const result = await mount(createNotionQueryTool({ runNtn: inertRun })).execute("c4", {
      database_or_data_source: "ds-1",
      sort: 5,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
    assert.doesNotMatch(result.content[0].text, /is not a function/);
  });

  it("notion_search with a non-string query", async () => {
    const result = await mount(createNotionSearchTool({ run: inertRun })).execute("c5", {
      query: null,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
  });

  it("notion_page_create without parent", async () => {
    const result = await mount(createNotionPageCreateTool({ runNtn: inertRun })).execute("c6", {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
    assert.doesNotMatch(result.content[0].text, /Cannot read|is not a function/);
  });

  it("notion_page_edit without id", async () => {
    const result = await mount(createNotionPageEditTool({ runNtn: inertRun })).execute("c7", {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
    assert.doesNotMatch(result.content[0].text, /Cannot read|is not a function/);
  });

  it("notion_page_edit with a non-array edits", async () => {
    const result = await mount(createNotionPageEditTool({ runNtn: inertRun })).execute("c8", {
      id: "11111111-1111-4111-8111-111111111111",
      edits: "old -> new",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
  });

  it("notion_page_edit with an edit entry that is not an object", async () => {
    const result = await mount(createNotionPageEditTool({ runNtn: inertRun })).execute("c9", {
      id: "11111111-1111-4111-8111-111111111111",
      edits: ["plain string"],
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
    assert.doesNotMatch(result.content[0].text, /Cannot read|is not a function/);
  });

  it("notion_page_trash with a non-boolean yes", async () => {
    const result = await mount(createNotionPageTrashTool({ runNtn: inertRun })).execute("c10", {
      id: "11111111-1111-4111-8111-111111111111",
      yes: "maybe",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: \[INVALID_INPUT\] /);
  });

  it("accepts the documented boolean spellings for yes", async () => {
    // "true"/"yes"/1 must all count as consent; only a genuinely false value stops.
    for (const yes of [true, "true", "yes", 1, "1", "YES"]) {
      const tool = createNotionPageTrashTool({
        runNtn: async (options: { args: string[] }) => {
          if (options.args[0] === "api" && options.args[1]?.startsWith("v1/pages/")) {
            return { ok: true, stdout: JSON.stringify({ archived: false }), stderr: "", code: 0 };
          }
          if (options.args[0] === "api" && options.args[1]?.includes("/children")) {
            return {
              ok: true,
              stdout: JSON.stringify({ results: [], has_more: false }),
              stderr: "",
              code: 0,
            };
          }
          return { ok: true, stdout: "{}", stderr: "", code: 0 };
        },
      });
      const result = await mount(tool).execute("c11", {
        id: "11111111-1111-4111-8111-111111111111",
        yes,
      });
      assert.equal(result.isError, false, `yes=${JSON.stringify(yes)}: ${result.content[0].text}`);
    }
  });
});
