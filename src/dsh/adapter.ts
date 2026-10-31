/**
 * Bridge the pi tool definitions onto DSH's `ctx.tools.register` contract.
 *
 * The four tools were written against pi's `registerTool({ parameters, execute,
 * outputSchema })` API. This adapter keeps those files untouched:
 *  - parameters are converted to the DSH-enforced JSON Schema subset;
 *  - execute's pi result ({ content, details, structuredContent }) is retained
 *    as the canonical output value, so DSH renders exactly the text the pi
 *    tool produced;
 *  - a pi `isError` result becomes a thrown Error, which DSH materializes as
 *    the same model-facing error text.
 */
import { toDshParameters } from "./schema.ts";

export type PiToolDef = {
  name: string;
  label?: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  outputSchema?: unknown;
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ) => Promise<{ content?: unknown[]; details?: unknown; structuredContent?: unknown; isError?: boolean } | undefined>;
};

export type PiRegistry = {
  registerTool(definition: PiToolDef): void;
};

type TextBlock = { type: "text"; text: string };

function textBlock(text: string): TextBlock {
  return { type: "text", text };
}

/** Model-facing text blocks from a pi tool result, with a JSON fallback. */
export function blocksFrom(value: unknown): TextBlock[] {
  const content = (value as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content) && content.length > 0) {
    const blocks = content.flatMap((block: unknown): TextBlock[] => {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") return [textBlock(text)];
      }
      return [textBlock(JSON.stringify(block))];
    });
    if (blocks.length > 0) return blocks;
  }
  if (typeof value === "string") return [textBlock(value)];
  return [textBlock(JSON.stringify(value ?? null, null, 2))];
}

/** Lossless JSON projection; DSH freezes output values and rejects undefined. */
function jsonValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

/**
 * Build the pi-shaped registry whose registerTool maps one definition onto the
 * DSH tool registry. `register` is normally `(tool) => ctx.tools.register(tool)`.
 */
export function createPiRegistry(register: (tool: unknown) => unknown): PiRegistry {
  return {
    registerTool(definition: PiToolDef) {
      const tool = {
        name: definition.name,
        description: definition.description,
        parameters: toDshParameters(definition.parameters),
        output: {
          // The canonical value is the pi result envelope; content carries the
          // model-facing text, so the output schema stays unconstrained.
          schema: {},
          render: (_args: unknown, value: unknown): TextBlock[] => blocksFrom(value),
        },
        async execute(args: unknown, exec: { callId?: string; signal?: AbortSignal }) {
          const result = await definition.execute(
            exec?.callId ?? "dsh-notion-call",
            args,
            exec?.signal,
            undefined,
          );
          if (result && result.isError === true) {
            throw new Error(blocksFrom(result)[0]?.text ?? `${definition.name} failed`);
          }
          return jsonValue({
            content: blocksFrom(result),
            details: result?.details,
            structuredContent: result?.structuredContent,
          });
        },
      };
      register(tool);
    },
  };
}
