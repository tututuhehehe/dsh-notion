/**
 * Data-source property-schema extraction shared by `notion_page` (writes) and
 * `notion_query` (`under` → Parent-item filter).
 *
 * The 2025-09+ API exposes properties only on the data source, and the wrapper around
 * them differs between ntn versions (`properties` at the top level, or nested under
 * `data_source` / `database`). Keeping one extractor means the tool that picks the
 * Parent-item column (via `selectParentItemProperty`) and the tool that validates a write
 * see exactly the same schema shape.
 */

export interface SchemaProperty {
  name: string;
  type: string;
  /** For `relation` columns: the data source the relation points at, when reported. */
  relationDataSourceId?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull the property map out of a `GET v1/data_sources/{id}` payload (or a wrapper that
 * nests it under `data_source` / `database`). Returns undefined when no properties are
 * present, so callers can fail with a useful message instead of writing blind.
 */
export function extractSchemaProperties(raw: unknown): Map<string, SchemaProperty> | undefined {
  if (!isRecord(raw)) return undefined;
  let properties = raw.properties;
  if (!isRecord(properties)) {
    for (const wrapper of ["data_source", "database"] as const) {
      const nested = raw[wrapper];
      if (isRecord(nested) && isRecord(nested.properties)) {
        properties = nested.properties;
        break;
      }
    }
  }
  if (!isRecord(properties)) return undefined;

  const map = new Map<string, SchemaProperty>();
  for (const [name, entry] of Object.entries(properties)) {
    if (!isRecord(entry)) continue;
    const type = typeof entry.type === "string" ? entry.type : "unknown";
    const relation = isRecord(entry.relation) ? entry.relation : undefined;
    const relationDataSourceId =
      relation && typeof relation.data_source_id === "string" ? relation.data_source_id : undefined;
    map.set(name, {
      name,
      type,
      ...(relationDataSourceId ? { relationDataSourceId } : {}),
    });
  }
  return map.size ? map : undefined;
}

/** The data source id reported by a schema payload, falling back to the id we asked for. */
export function reportedDataSourceId(raw: unknown, fallback: string): string {
  if (isRecord(raw) && typeof raw.id === "string" && raw.id) return raw.id;
  return fallback;
}
