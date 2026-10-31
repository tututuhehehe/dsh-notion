/**
 * Test harness that mounts a `NotionTool` the way the DSH tool registry does.
 *
 * Unit tests inject fake `ntn` runners (no PATH lookup, no network, no token) and then
 * talk to the tool through this harness, so every assertion against the model-facing
 * envelope still exercises the real definition instead of a test-only wrapper.
 *
 * The materialization mirrors DSH's own tool registry:
 *   - success: `{ isError: false, value, details: value, content: render(args, value) }`
 *   - thrown body: `{ isError: true, details: error.details ?? {}, error, content: [text("Error: <message>")] }`
 * That is what `toolErrorResult` renders, so the error text keeps DSH's `Error: ` prefix.
 */
import type { NotionTool, TextBlock } from "../../src/dsh/tool.ts";

export type MountedResult<Value = unknown> = {
  /** DSH sets this explicitly to true/false, never leaves it undefined. */
  isError: boolean;
  /** Canonical JSON value on success. */
  value?: Value;
  /**
   * Canonical value on success; the thrown error's `details` on failure.
   * Typed as a record (not `Value`) because failures carry structured details the
   * success type does not describe (hint_properties, partial, rollback, ...).
   */
  details: Record<string, any>;
  /** The thrown error on failure (undefined on success). */
  error?: unknown;
  /** Model-facing text blocks derived from the value (or the error). */
  content: TextBlock[];
};

export type MountedTool<Value = unknown> = {
  name: string;
  description: string;
  /** Raw enforcement JSON Schema (type / properties / required / additionalProperties / ...). */
  parameters: ParameterSchema;
  output: NotionTool<Value>["output"];
  execute: (
    callId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<MountedResult<Value>>;
};

/** The shape the tests read out of a raw parameter schema. */
export type ParameterSchema = {
  type?: string;
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
};

/** Mount a plain DSH tool definition the way the registry does (no schema validation). */
export function mount<Value>(tool: NotionTool<Value>): MountedTool<Value> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as ParameterSchema,
    output: tool.output,
    async execute(_callId, params, signal) {
      try {
        const value = await tool.execute(params, signal ? { signal } : {});
        return {
          isError: false,
          value,
          // The canonical value is a JSON object for every notion_* tool; DSH exposes it as
          // the call's structured details too.
          details: value as Record<string, any>,
          content: tool.output.render(params, value),
        };
      } catch (error) {
        const details = (error as { details?: Record<string, unknown> }).details ?? {};
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          details,
          error,
          content: [{ type: "text", text: `Error: ${message}` }],
        };
      }
    },
  };
}

/** Join a result's text blocks, exactly like the model receives them. */
export function text(result: { content: TextBlock[] }): string {
  return result.content.map((block) => block.text).join("\n");
}

/** Narrow a successful result's canonical value (asserts the call succeeded). */
export function valueOf<Value>(result: MountedResult<Value>): Value {
  if (result.isError) {
    throw new Error(`expected a successful tool call, got: ${text(result)}`);
  }
  return result.value as Value;
}
