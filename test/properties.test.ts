import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalNotionId,
  isParentItemName,
  isWritablePropertyType,
  sameNotionId,
  selectParentItemProperty,
} from "../src/lib/properties.ts";
import { parseResolveDataSources } from "../src/lib/datasources.ts";

const DS = "716f546f-1824-45f0-b73a-481bf8b5f5db";
const OTHER_DS = "99999999-9999-4999-8999-999999999999";

describe("properties: ids and writability", () => {
  it("compares dashed and bare ids as the same object", () => {
    assert.equal(canonicalNotionId(DS.toUpperCase()), DS.replace(/-/g, ""));
    assert.equal(sameNotionId(DS, DS.replace(/-/g, "")), true);
    assert.equal(sameNotionId(DS, OTHER_DS), false);
    assert.equal(sameNotionId(undefined, DS), false);
  });

  it("treats read-only property types as not writable", () => {
    for (const type of ["formula", "rollup", "created_time", "last_edited_by", "button"]) {
      assert.equal(isWritablePropertyType(type), false, type);
    }
    for (const type of ["title", "rich_text", "status", "relation", "checkbox"]) {
      assert.equal(isWritablePropertyType(type), true, type);
    }
  });

  it("recognizes Parent-item names in English and Chinese", () => {
    for (const name of ["Parent-item", "Parent", "parent item", "上级", "父任务"]) {
      assert.equal(isParentItemName(name), true, name);
    }
    for (const name of ["Related", "标签", "关联"]) {
      assert.equal(isParentItemName(name), false, name);
    }
  });
});

describe("properties: Parent-item selection", () => {
  it("prefers the name-matching self-relation", () => {
    const selected = selectParentItemProperty(
      [
        { name: "Related", type: "relation", relationDataSourceId: DS },
        { name: "Parent-item", type: "relation", relationDataSourceId: DS },
      ],
      DS
    );
    assert.equal(selected?.name, "Parent-item");
  });

  it("falls back to the only self-relation even when it is unnamed", () => {
    const selected = selectParentItemProperty(
      [
        { name: "Name", type: "title" },
        { name: "相关任务", type: "relation", relationDataSourceId: DS.replace(/-/g, "") },
      ],
      DS
    );
    assert.equal(selected?.name, "相关任务");
  });

  it("refuses to guess between several unnamed self-relations", () => {
    const selected = selectParentItemProperty(
      [
        { name: "Related A", type: "relation", relationDataSourceId: DS },
        { name: "Related B", type: "relation", relationDataSourceId: DS },
      ],
      DS
    );
    assert.equal(selected, undefined);
  });

  it("ignores relations that point at another data source", () => {
    const selected = selectParentItemProperty(
      [
        { name: "上级", type: "relation", relationDataSourceId: OTHER_DS },
        { name: "Related", type: "relation", relationDataSourceId: OTHER_DS },
      ],
      DS
    );
    assert.equal(selected, undefined);
  });

  it("returns undefined when there is no relation at all", () => {
    assert.equal(selectParentItemProperty([{ name: "Name", type: "title" }], DS), undefined);
  });
});

describe("datasources: resolve shapes", () => {
  it("accepts the documented, bare, results and single-object shapes", () => {
    assert.deepEqual(parseResolveDataSources({ data_sources: [{ id: DS, name: "Tasks" }] }), [
      { id: DS, name: "Tasks" },
    ]);
    assert.deepEqual(parseResolveDataSources([{ id: DS }]), [{ id: DS }]);
    assert.deepEqual(parseResolveDataSources({ results: [{ data_source_id: DS }] }), [{ id: DS }]);
    assert.deepEqual(parseResolveDataSources({ id: DS }), [{ id: DS }]);
    assert.deepEqual(parseResolveDataSources([DS, DS, "  "]), [{ id: DS }]);
  });

  it("returns [] for unusable payloads instead of guessing", () => {
    assert.deepEqual(parseResolveDataSources(null), []);
    assert.deepEqual(parseResolveDataSources("nope"), []);
    assert.deepEqual(parseResolveDataSources({ data_sources: [{}] }), []);
  });
});
