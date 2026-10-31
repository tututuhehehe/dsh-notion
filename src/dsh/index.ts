/**
 * DSH host plugin entry: four consolidated Notion tools over the official ntn
 * CLI. This is the port of pi-notion v1.1.0 — the tool implementations in
 * ../tools and ../lib are unchanged; ./adapter bridges pi's registerTool API to
 * DSH's ctx.tools.register.
 *
 * No Config schema is declared: DSH's shipped Web client does not render
 * generic forms from a Config schema, so the token is configured through the
 * NOTION_API_TOKEN environment variable or the ./notion-token file instead.
 */
import { registerNotionGet } from "../tools/get.ts";
import { registerNotionPage } from "../tools/page.ts";
import { registerNotionQuery } from "../tools/query.ts";
import { registerNotionSearch } from "../tools/search.ts";
import { createPiRegistry } from "./adapter.ts";
import { readConfig } from "./config.ts";
import { makeRunner } from "./runner.ts";

/** DSH plugin name used by loader diagnostics. */
export const name = "notion-tools";

/** Hard dependency: the registry that receives the four tool definitions. */
export const inject = ["tools"];

type NotionContext = {
  tools: { register(definition: unknown): unknown };
};

export function apply(ctx: NotionContext, config: unknown): void {
  const run = makeRunner(() => readConfig(config));
  const pi = createPiRegistry((tool) => ctx.tools.register(tool));

  registerNotionSearch(pi, { run });
  registerNotionGet(pi, run);
  registerNotionPage(pi, { runNtn: run });
  registerNotionQuery(pi, { runNtn: run });
}
