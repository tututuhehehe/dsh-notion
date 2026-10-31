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
import { createNotionPageTool } from "../src/tools/page.ts";
import { createNotionQueryTool } from "../src/tools/query.ts";
import { createNotionSearchTool } from "../src/tools/search.ts";

const inertRun = async () => ({ ok: true, stdout: "{}", stderr: "", code: 0 });

const DEFINITIONS = [
  createNotionSearchTool({ run: inertRun }),
  createNotionGetTool(inertRun),
  createNotionPageTool({ runNtn: inertRun }),
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

  it("a page create value validates, including the icon field", async () => {
    const tool = createNotionPageTool({
      runNtn: async () => ({
        ok: true,
        stdout: JSON.stringify({ object: "page", id: "11111111-1111-4111-8111-111111111111" }),
        stderr: "",
        code: 0,
      }),
    });
    const value = {
      ok: true,
      action: "create",
      id: "11111111-1111-4111-8111-111111111111",
      properties: [],
      changed: ["icon"],
      icon: "🎯",
    };
    assert.doesNotThrow(() => assertOutput(tool, value));
  });
});
