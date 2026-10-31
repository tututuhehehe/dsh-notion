/**
 * Convert the pi tools' TypeBox JSON Schemas into the schema subset the DSH
 * tool registry enforces (type/oneOf/properties/required/additionalProperties/
 * items/enum/const + annotations only).
 *
 * The pi tools keep their own argument validation, so keyword-level constraints
 * such as `minimum` / `minLength` are dropped here instead of being rejected by
 * the registry; the tool body still enforces them.
 */
export type JsonSchema = Record<string, unknown>;

const SCALARS = new Set(["string", "number", "integer", "boolean", "null"]);
const ANNOTATIONS = ["description", "title", "default"] as const;

function annotations(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const key of ANNOTATIONS) {
    if (Object.hasOwn(node, key) && node[key] !== undefined) out[key] = node[key];
  }
  return out;
}

/** Convert one TypeBox/JSON-Schema node into a DSH-supported schema node. */
export function convertSchema(node: JsonSchema | undefined): JsonSchema {
  if (!node || typeof node !== "object") return {};

  const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
  if (union && union.length > 0) {
    const branches = union.map((branch) => convertSchema(branch as JsonSchema));
    // Type.Union([Type.Literal("a"), Type.Literal("b")]) -> string enum
    if (branches.length > 1 && branches.every((branch) => branch.type === "string" && typeof branch.const === "string")) {
      return { type: "string", enum: branches.map((branch) => branch.const), ...annotations(node) };
    }
    if (branches.length === 1) return { ...branches[0], ...annotations(node) };
    return { oneOf: branches, ...annotations(node) };
  }

  const type = typeof node.type === "string" ? node.type : undefined;

  if (type === "object") {
    // TypeBox Record(String, Unknown) emits patternProperties; the tool itself
    // validates property names, so the registry only needs "any object".
    if (node.patternProperties) return { type: "object", additionalProperties: true, ...annotations(node) };
    const out: JsonSchema = { type: "object", properties: {}, ...annotations(node) };
    if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
      const properties: JsonSchema = {};
      for (const [key, value] of Object.entries(node.properties as Record<string, JsonSchema>)) {
        properties[key] = convertSchema(value);
      }
      out.properties = properties;
    }
    if (Array.isArray(node.required) && node.required.length > 0) out.required = [...node.required];
    if (typeof node.additionalProperties === "boolean") out.additionalProperties = node.additionalProperties;
    return out;
  }

  if (type === "array") {
    const out: JsonSchema = { type: "array", ...annotations(node) };
    if (node.items) out.items = convertSchema(node.items as JsonSchema);
    return out;
  }

  if (type && SCALARS.has(type)) {
    const out: JsonSchema = { type, ...annotations(node) };
    if (Array.isArray(node.enum)) out.enum = [...node.enum];
    if (node.const !== undefined) out.const = node.const;
    return out;
  }

  // Type.Unknown() and friends: unconstrained JSON.
  return annotations(node);
}

/** Compile one tool's parameter object into an object-rooted DSH schema. */
export function toDshParameters(schema: unknown): JsonSchema {
  const converted = convertSchema(schema as JsonSchema);
  if (converted.type === "object") return converted;
  return { type: "object", properties: {}, additionalProperties: true };
}
