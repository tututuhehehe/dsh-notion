/**
 * Property-schema helpers shared by `notion_page` (writes) and `notion_get` (schema display).
 *
 * Keeping the read-only list and the "Parent-item" heuristic in one place means the tool that
 * refuses to write a column and the tool that tells the model which column to use always agree.
 */

/** Property types Notion will not let an integration write. */
export const READ_ONLY_PROPERTY_TYPES: ReadonlySet<string> = new Set([
  "formula",
  "rollup",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "unique_id",
  "button",
  "verification",
]);

export function isWritablePropertyType(type: string): boolean {
  return !READ_ONLY_PROPERTY_TYPES.has(type);
}

/**
 * Name heuristic for the self-relation column Notion calls "Parent-item".
 * Notion localizes the default name, so cover the English and common Chinese labels.
 */
export const PARENT_ITEM_NAME_RE = /parent[\s_-]*item|parent|上级|父项|父任务|父/i;

export function isParentItemName(name: string): boolean {
  return PARENT_ITEM_NAME_RE.test(name);
}

/** Notion ids come back dashed or bare depending on the endpoint; compare canonical hex. */
export function canonicalNotionId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

export function sameNotionId(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return canonicalNotionId(a) === canonicalNotionId(b);
}

/** Minimal shape both `notion_page`'s PropertySchema and `notion_get`'s PropertyInfo satisfy. */
export type ParentItemPropertyLike = {
  name: string;
  type: string;
  relationDataSourceId?: string;
};

/**
 * Pick the column `notion_page` attach / child-row create writes, and the column
 * `notion_get` advertises. One selector for both tools, so the schema hint can never
 * point at a column the write path would refuse (or hide the one it would use).
 *
 * Order: named self-relation (Parent-item heuristic) → the only self-relation on the
 * data source → undefined (the caller must refuse and ask for a Parent-item column).
 */
export function selectParentItemProperty<T extends ParentItemPropertyLike>(
  properties: Iterable<T>,
  dataSourceId: string
): T | undefined {
  const relations = [...properties].filter((property) => property.type === "relation");
  if (relations.length === 0) return undefined;

  const selfRelations = relations.filter(
    (property) =>
      property.relationDataSourceId === undefined ||
      sameNotionId(property.relationDataSourceId, dataSourceId)
  );
  const named = selfRelations.find((property) => isParentItemName(property.name));
  if (named) return named;
  return selfRelations.length === 1 ? selfRelations[0] : undefined;
}
