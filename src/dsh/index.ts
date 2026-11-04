/**
 * DSH host plugin entry: six consolidated Notion tools over the official `ntn` CLI.
 *
 *   notion_search      find pages/databases by title
 *   notion_get         read one page, database or data source
 *   notion_query       query the rows of a database/data source
 *   notion_page_create create a page or database row
 *   notion_page_edit   find-and-replace body text, change title/properties/icon, move
 *   notion_page_trash  delete a page or row (a subtree delete needs a review first)
 *
 * Create/edit/trash are separate tools rather than one `notion_page` with an
 * `action` parameter: each surfaces only the arguments its operation accepts, so a
 * create cannot accidentally carry an `old_str` and an edit cannot carry a
 * `recursive` by mistake. That also keeps three short descriptions instead of one long one.
 *
 * The trash tool reads the OPTIONAL `doublecheck` service through `ctx.get` rather than
 * declaring it in `inject`: the plugin stays usable without it (a page with no child pages
 * is deleted in one call), and only a delete that would take child pages with it fails
 * closed when the service is missing.
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
import {
  createNotionPageCreateTool,
  createNotionPageEditTool,
  createNotionPageTrashTool,
} from "../tools/page.ts";
import { createNotionQueryTool } from "../tools/query.ts";
import { createNotionSearchTool } from "../tools/search.ts";
import { readConfig } from "./config.ts";
import { makeRunner } from "./runner.ts";

/** DSH plugin name used by loader diagnostics. */
export const name = "notion-tools";

/** Hard dependency: the registry that receives the six tool definitions. */
export const inject = ["tools"];

type NotionContext = {
  tools: { register(definition: unknown): unknown };
  /**
   * Optional-service lookup. `doublecheck` is deliberately NOT in `inject`: it is a review
   * aid for one destructive path, not a requirement of the whole plugin.
   */
  get(name: string): unknown;
};

export function apply(ctx: NotionContext, config: unknown): void {
  const run = makeRunner(() => readConfig(config));

  ctx.tools.register(createNotionSearchTool({ run }));
  ctx.tools.register(createNotionGetTool(run));
  ctx.tools.register(createNotionPageCreateTool({ runNtn: run }));
  ctx.tools.register(createNotionPageEditTool({ runNtn: run }));
  ctx.tools.register(
    createNotionPageTrashTool({ runNtn: run, getDoublecheck: () => ctx.get("doublecheck") })
  );
  ctx.tools.register(createNotionQueryTool({ runNtn: run }));
}
