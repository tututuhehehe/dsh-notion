/**
 * Shared acceptance fixtures for `notion_page` tests.
 *
 * These mirror the real acceptance database from AGENTS.md. Unit tests stay fully
 * mocked (no network, no token); `test/e2e-live.ts` imports the same ids so the mock
 * fixtures and the live script cannot drift apart.
 */
import type { RunNtnResult } from "../../src/lib/runNtn.ts";

export const ACCEPTANCE = {
  /** Database id of https://app.notion.com/p/2f14f95bc14a49859b9d71d43663559a */
  databaseId: "2f14f95bc14a49859b9d71d43663559a",
  /** data_source id of the same database. */
  dataSourceId: "716f546f-1824-45f0-b73a-481bf8b5f5db",
  /** Parent page used for throwaway pages. */
  parentPageId: "4077266d-1cb4-814d-872b-ea1d5928ab4c",
  /** The self-relation column `selectParentItemProperty` picks on the acceptance DB. */
  parentItemColumn: "Parent item",
  columns: {
    Name: "title",
    Status: "status",
    标签: "multi_select",
    截止日期: "date",
    Done: "checkbox",
  },
} as const;

/** Shape returned by `ntn api v1/data_sources/<id>` (only the fields we use). */
export const DATA_SOURCE_SCHEMA = {
  object: "data_source",
  id: ACCEPTANCE.dataSourceId,
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    Status: {
      id: "status",
      name: "Status",
      type: "status",
      status: { options: [{ id: "opt-todo", name: "待办", color: "gray" }] },
    },
    标签: { id: "tags", name: "标签", type: "multi_select", multi_select: { options: [] } },
    截止日期: { id: "due", name: "截止日期", type: "date", date: {} },
    Done: { id: "done", name: "Done", type: "checkbox", checkbox: {} },
  },
} as const;

export function ntnOk(stdout: unknown): RunNtnResult {
  return {
    ok: true,
    stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
    stderr: "",
    code: 0,
  };
}

export function ntnFail(stderr: string): RunNtnResult {
  return { ok: false, stdout: "", stderr, code: 1 };
}

/** Database id of the acceptance DB (rows live in `ACCEPTANCE.dataSourceId`). */
export const ACCEPTANCE_DATABASE_ID = "2f14f95b-c14a-4985-9b9d-71d43663559a";

/** Acceptance schema plus a self-relation column, used for child-row / attach tests. */
export const SELF_RELATION_SCHEMA = {
  object: "data_source",
  id: ACCEPTANCE.dataSourceId,
  properties: {
    ...DATA_SOURCE_SCHEMA.properties,
    "Parent-item": {
      id: "parent",
      name: "Parent-item",
      type: "relation",
      relation: {
        data_source_id: ACCEPTANCE.dataSourceId.replace(/-/g, ""),
        type: "dual_property",
      },
    },
  },
} as const;

/**
 * The real acceptance shape: a dual self-relation (`Parent item` ↔ `Sub-item`, both pointing
 * at the same data source). `Sub-item` must never be the column writes use.
 */
export const DUAL_RELATION_SCHEMA = {
  object: "data_source",
  id: ACCEPTANCE.dataSourceId,
  properties: {
    ...DATA_SOURCE_SCHEMA.properties,
    "Parent item": {
      id: "parentItem",
      name: "Parent item",
      type: "relation",
      relation: {
        data_source_id: ACCEPTANCE.dataSourceId,
        type: "dual_property",
        dual_property: { synced_property_name: "Sub-item", synced_property_id: "subItem" },
      },
    },
    "Sub-item": {
      id: "subItem",
      name: "Sub-item",
      type: "relation",
      relation: {
        data_source_id: ACCEPTANCE.dataSourceId,
        type: "dual_property",
        dual_property: { synced_property_name: "Parent item", synced_property_id: "parentItem" },
      },
    },
  },
} as const;

/** Acceptance schema with a real column literally named body_content (reserved-key conflict). */
export const BODY_COLUMN_SCHEMA = {
  object: "data_source",
  id: ACCEPTANCE.dataSourceId,
  properties: {
    ...DATA_SOURCE_SCHEMA.properties,
    body_content: { id: "body", name: "body_content", type: "rich_text", rich_text: {} },
  },
} as const;

/** Acceptance schema with a real column literally named icon (reserved-key conflict). */
export const ICON_COLUMN_SCHEMA = {
  object: "data_source",
  id: ACCEPTANCE.dataSourceId,
  properties: {
    ...DATA_SOURCE_SCHEMA.properties,
    icon: { id: "icon", name: "icon", type: "rich_text", rich_text: {} },
  },
} as const;

export function resolveResponse(...ids: string[]): unknown {
  return {
    database_id: ACCEPTANCE_DATABASE_ID,
    data_sources: ids.map((id) => ({ id })),
  };
}
