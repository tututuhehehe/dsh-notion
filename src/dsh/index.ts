/**
 * DSH host plugin entry: four consolidated Notion tools over the official `ntn` CLI.
 *
 * Each tool is a plain DSH ToolDefinition (see ./tool.ts) registered into `ctx.tools`,
 * so its name, description and parameter schema reach the model directly and its
 * canonical value is validated before anything is rendered.
 *
 * No Config schema is declared: the shipped Web client does not render generic forms
 * from a Config schema, so the token comes from the NOTION_API_TOKEN environment
 * variable or the `notion-token` file inside the plugin directory instead.
 */
import { createNotionGetTool } from "../tools/get.ts";
import { createNotionPageTool } from "../tools/page.ts";
import { createNotionQueryTool } from "../tools/query.ts";
import { createNotionSearchTool } from "../tools/search.ts";
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

  ctx.tools.register(createNotionSearchTool({ run }));
  ctx.tools.register(createNotionGetTool(run));
  ctx.tools.register(createNotionPageTool({ runNtn: run }));
  ctx.tools.register(createNotionQueryTool({ runNtn: run }));
}
