/**
 * Shared parsing for `ntn datasources resolve <database-id> --json`.
 *
 * Both `notion_query` and `notion_page` need a database id turned into data source ids: a Notion
 * database can hold several data sources, and the 2025-09+ API only exposes property schemas on the
 * data source. The wrapper shape is not guaranteed across ntn versions, so accept the documented
 * `data_sources` array, a bare array, or a single object with an id.
 */

export type ResolvedDataSource = {
  id: string;
  name?: string;
};

export function parseResolveDataSources(raw: unknown): ResolvedDataSource[] {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (isRecord(raw)) {
    if (Array.isArray(raw.data_sources)) items = raw.data_sources;
    else if (Array.isArray(raw.results)) items = raw.results;
    else if (typeof raw.id === "string" || typeof raw.data_source_id === "string") items = [raw];
  }

  const out: ResolvedDataSource[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push({ id });
      }
      continue;
    }
    if (!isRecord(item)) continue;
    const id =
      typeof item.id === "string"
        ? item.id
        : typeof item.data_source_id === "string"
          ? item.data_source_id
          : typeof item.dataSourceId === "string"
            ? item.dataSourceId
            : undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name =
      typeof item.name === "string"
        ? item.name
        : typeof item.title === "string"
          ? item.title
          : undefined;
    out.push(name ? { id, name } : { id });
  }
  return out;
}
