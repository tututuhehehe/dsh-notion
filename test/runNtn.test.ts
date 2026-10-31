import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJsonStdout } from "../src/lib/runNtn.ts";

describe("parseJsonStdout", () => {
  it("parses object", () => {
    assert.deepEqual(parseJsonStdout('{"a":1}\n'), { a: 1 });
  });
  it("empty -> null", () => {
    assert.equal(parseJsonStdout("  "), null);
  });
});
