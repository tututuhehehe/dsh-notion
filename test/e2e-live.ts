/**
 * Live end-to-end check for pi-notion 1.1 (NOT part of `npm test`).
 *
 * Covers the v1.1 behaviors that cannot be proven with mocks:
 *   - child row create under a parent row (bare parent row id → Parent-item relation)
 *   - notion_query `under` returns that child row
 *   - row→row attach moves the child (overwrite needs yes:true; same parent is a no-op)
 *   - cycle refusal (C under B when B is already under C) and self-attach refusal
 *   - trash cleanup of every temp row, including after a failed step
 *
 * Run on the box with a real token:
 *   NOTION_API_TOKEN=… node --experimental-strip-types test/e2e-live.ts
 *
 * Uses the acceptance database from AGENTS.md. Temps are named `e2e <stamp> …` so a
 * leftover is easy to spot if the process is killed mid-run.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { sameNotionId } from "../src/lib/properties.ts";
import { registerNotionGet } from "../src/tools/get.ts";
import { registerNotionPage } from "../src/tools/page.ts";
import { registerNotionQuery } from "../src/tools/query.ts";
import { ACCEPTANCE } from "./fixtures/notion.ts";

type ToolResult = {
  content: { type: string; text: string }[];
  details?: Record<string, unknown>;
  isError?: boolean;
};

type Tool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

const tools = new Map<string, Tool>();
const pi = {
  registerTool(config: Tool) {
    tools.set(config.name, config);
  },
} as unknown as ExtensionAPI;

registerNotionGet(pi);
registerNotionPage(pi);
registerNotionQuery(pi);

function tool(name: string): Tool {
  const registered = tools.get(name);
  if (!registered) throw new Error(`tool ${name} was not registered`);
  return registered;
}

async function call(name: string, params: Record<string, unknown>): Promise<ToolResult> {
  return tool(name).execute(`e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`, params);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const created: { id: string; label: string }[] = [];
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function text(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

function detailId(result: ToolResult): string | undefined {
  const id = result.details?.id;
  return typeof id === "string" ? id : undefined;
}

async function createRow(
  label: string,
  parent?: string
): Promise<{ id: string; details: Record<string, unknown> }> {
  const title = `e2e ${stamp} ${label}`;
  const result = await call("notion_page", {
    action: "create",
    parent: parent ?? `data-source:${ACCEPTANCE.dataSourceId}`,
    props: { body_content: `# ${title}\n\npi-notion 1.1 live e2e temp row.` },
  });
  if (result.isError) {
    throw new Error(`create ${label} failed: ${text(result)}`);
  }
  const id = detailId(result);
  if (!id) throw new Error(`create ${label} returned no id: ${text(result)}`);
  created.push({ id, label });
  return { id, details: result.details ?? {} };
}

function rowIds(result: ToolResult): string[] {
  const results = result.details?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((row) => (typeof row === "object" && row !== null ? (row as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

async function queryUnder(parentId: string): Promise<ToolResult> {
  return call("notion_query", {
    database_or_data_source: ACCEPTANCE.dataSourceId,
    under: parentId,
    limit: 100,
  });
}

async function waitForChild(
  parentId: string,
  childId: string,
  present = true
): Promise<boolean> {
  // Notion is usually read-after-write consistent, but allow one short retry.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await queryUnder(parentId);
    const found = rowIds(result).some((id) => sameNotionId(id, childId));
    if (found === present) return true;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

async function trash(id: string): Promise<boolean> {
  const result = await call("notion_page", { action: "trash", id, yes: true });
  if (!result.isError) {
    const index = created.findIndex((entry) => sameNotionId(entry.id, id));
    if (index >= 0) created.splice(index, 1);
  }
  return !result.isError;
}

async function main(): Promise<void> {
  if (!process.env.NOTION_API_TOKEN) {
    console.log("note: NOTION_API_TOKEN is not set; relying on `ntn login`.");
  }

  // 1. The acceptance data source must expose a Parent-item self-relation.
  const schema = await call("notion_get", { id_or_url: ACCEPTANCE.databaseId });
  const candidates = schema.details?.parent_item_candidates;
  const candidate = Array.isArray(candidates)
    ? candidates.find(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          sameNotionId(
            (entry as { data_source_id?: string }).data_source_id,
            ACCEPTANCE.dataSourceId
          ) &&
          (entry as { property?: string }).property === ACCEPTANCE.parentItemColumn
      )
    : undefined;
  check(
    `acceptance data source has the "${ACCEPTANCE.parentItemColumn}" self-relation`,
    !!candidate,
    text(schema).slice(0, 400)
  );
  if (!candidate) {
    throw new Error(
      "Acceptance DB has no Parent-item self-relation. Add a relation property pointing at its own " +
        "data source (name it 'Parent item'), then re-run."
    );
  }

  let parentA: string | undefined;
  let parentC: string | undefined;
  let childB: string | undefined;

  try {
    parentA = (await createRow("parent A")).id;
    parentC = (await createRow("parent C")).id;
    check("created two parent rows", !!parentA && !!parentC);

    // 2. Child row create under a bare parent row id.
    const child = await createRow("child B", parentA);
    childB = child.id;
    check(
      "child row create reports the Parent-item link it wrote",
      typeof child.details.parent_item_row_id === "string" &&
        sameNotionId(child.details.parent_item_row_id, parentA) &&
        typeof child.details.parent_item_property === "string"
    );

    const bUnderA = await queryUnder(parentA);
    check(
      "notion_query under=A returns child B",
      rowIds(bUnderA).some((id) => sameNotionId(id, childB)),
      text(bUnderA).slice(0, 300)
    );
    const bUnderC = await queryUnder(parentC);
    check(
      "notion_query under=C does not return B yet",
      !rowIds(bUnderC).some((id) => sameNotionId(id, childB))
    );

    // 3. attach row→row: overwrite without yes is refused, with yes it moves.
    const overwriteRefused = await call("notion_page", {
      action: "attach",
      id: childB,
      parent: parentC,
    });
    check(
      "attach without yes refuses to overwrite the existing parent",
      overwriteRefused.isError === true && /yes: true/.test(text(overwriteRefused)),
      text(overwriteRefused).slice(0, 300)
    );

    const moved = await call("notion_page", {
      action: "attach",
      id: childB,
      parent: parentC,
      yes: true,
    });
    check("attach with yes moves B under C", moved.isError !== true, text(moved).slice(0, 300));
    check(
      "attach reports the replaced parent",
      ((moved.details?.replaced_parent_ids as unknown[] | undefined) ?? []).some(
        (id) => typeof id === "string" && sameNotionId(id, parentA)
      )
    );

    check("notion_query under=C returns B after the move", await waitForChild(parentC, childB));
    check(
      "notion_query under=A no longer returns B",
      await waitForChild(parentA, childB, false)
    );

    // 4. Re-attaching the same parent is an idempotent no-op.
    const again = await call("notion_page", {
      action: "attach",
      id: childB,
      parent: parentC,
    });
    check(
      "re-attach to the same parent is a no-op",
      again.isError !== true && again.details?.already_linked === true,
      text(again).slice(0, 300)
    );

    // 5. Self attach and cycles are refused.
    const selfAttach = await call("notion_page", { action: "attach", id: childB, parent: childB });
    check(
      "self attach is refused",
      selfAttach.isError === true && /不能挂到自己下面/.test(text(selfAttach)),
      text(selfAttach).slice(0, 300)
    );

    // B is under C, so putting C under B would close the loop C→B→C.
    const cycle = await call("notion_page", {
      action: "attach",
      id: parentC,
      parent: childB,
      yes: true,
    });
    check(
      "row cycle (C under B while B is under C) is refused",
      cycle.isError === true && /环/.test(text(cycle)),
      text(cycle).slice(0, 300)
    );
  } finally {
    // 6. Cleanup: trash every temp row, deepest first so no child is left pointing at a trashed parent.
    const toTrash = [...created].reverse();
    for (const entry of toTrash) {
      const ok = await trash(entry.id);
      check(`cleanup trash ${entry.label} (${entry.id})`, ok);
    }
    if (created.length > 0) {
      console.log(
        `WARNING leftovers still present: ${created.map((entry) => `${entry.label}=${entry.id}`).join(", ")}`
      );
    }
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) console.log(`failed checks: ${failures.join("; ")}`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error(`e2e aborted: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  });
