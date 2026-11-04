/**
 * 可选的 doublecheck 复核通道（`@local/dsh-doublecheck`）。
 *
 * 为什么是「可选」而不是 `inject` 依赖：dsh-notion 可以单独安装，而且没有子页面的删除
 * 根本不需要复核。只有「有子页面的删除」必须复核 —— 那时候服务不存在就 fail closed：
 * 报错，什么都不删。把 doublecheck 加进 `inject` 会让整个插件在没装它时停止工作。
 *
 * 契约（来自 `@local/dsh-doublecheck` 的 `index.d.ts`，实测于 0.1.0）：
 *   - `checkpoint(exec, risk)` 是**同步**的，每次执行只调一次，紧贴副作用之前；
 *   - 返回 `{ kind: "proceed" }` 或 `{ kind: "pending", id, reason, details? }`；
 *   - pending 必须**原样**成为工具的返回值（`output.schema` 要声明它、`render` 要说明没执行），
 *     不能当成错误抛出去；
 *   - `risk` 为 null 也要走一次：确认过的调用会用原参数重放，只有再过一次检查点，
 *     doublecheck 才能发现「范围已经和复核时不一样了」并把旧确认判为失效。
 */
import { CHECK_ERRORS } from "../text/errors.ts";
import { NOTION_ERROR_CODES, NotionToolError } from "./tool.ts";
import type { JsonObject } from "./tool.ts";

/**
 * 一次待复核的风险。
 *
 * `reason` 会被逐字节比对（确认时用原参数重放），所以它必须是确定性的：不能带时间戳、
 * 随机数或 pending id（id 是快照之后才生成的）。集合类内容先排序。
 */
export type RiskSnapshot = {
  /** 稳定的机器可读风险码，例如 `notion.trash.subtree.v1`。 */
  code: string;
  /** 给人读的风险陈述：删什么、范围多大、后果是什么。 */
  reason: string;
  /** 稳定的 JSON 证据（对象 id、范围、版本），不放秘密。 */
  details?: JsonObject;
};

/** `checkpoint` 返回的待复核值，原样作为工具结果返回给模型。 */
export type PendingValue = {
  kind: "pending";
  id: string;
  reason: string;
  details?: unknown;
};

/** doublecheck 的服务面：只有这一个方法。 */
export type DoublecheckService = {
  checkpoint(exec: unknown, risk: RiskSnapshot | null): unknown;
};

/** 读取可选服务；插件没装或没启用时是 undefined。形状校验在 {@link checkpoint} 里做。 */
export function readDoublecheck(get: () => unknown): DoublecheckService | undefined {
  const service = get();
  if (service === undefined || service === null) return undefined;
  return service as DoublecheckService;
}

/**
 * 过一次检查点。
 *
 * `risk === null` 表示这次执行没有任何需要复核的副作用（比如删除一个没有子页面的页面）；
 * 仍然会转告 doublecheck，原因见文件头。
 *
 * @param p.unavailable 没有复核服务却有风险时抛出的错误。由调用方提供，因为只有它知道
 *   具体范围（页面 id、子页面数量），而错误消息必须把这些说出来。
 */
export function checkpoint(p: {
  service: DoublecheckService | undefined;
  exec: unknown;
  risk: RiskSnapshot | null;
  unavailable: () => NotionToolError;
}): PendingValue | undefined {
  // No channel, or one that does not actually offer `checkpoint` (a version mismatch):
  // a call with risk does not happen, a call without risk does. Nothing is being ignored
  // in the second case — there is no side effect that needs a review.
  const usable = p.service !== undefined && typeof p.service.checkpoint === "function";
  if (!usable) {
    if (p.risk !== null) throw p.unavailable();
    return undefined;
  }
  if (p.risk !== null) assertRisk(p.risk);
  let decision: unknown;
  try {
    decision = p.service!.checkpoint(p.exec, p.risk);
  } catch (error) {
    // doublecheck 内部的拒绝（DC_* 错误）已经是模型可读的中文消息，保留原文。
    if (error instanceof NotionToolError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new NotionToolError(message, { code: NOTION_ERROR_CODES.reviewUnavailable });
  }
  return interpret(decision);
}

/** `proceed` → undefined；`pending` → 原值；其他 → 复核通道坏了，fail closed。 */
function interpret(decision: unknown): PendingValue | undefined {
  if (!isRecord(decision) || typeof decision.kind !== "string") throw reviewBroken();
  if (decision.kind === "proceed") return undefined;
  if (decision.kind !== "pending") throw reviewBroken();
  const { id, reason } = decision;
  if (typeof id !== "string" || id.trim() === "" || typeof reason !== "string" || reason.trim() === "") {
    throw reviewBroken();
  }
  return decision as PendingValue;
}

/** 风险快照必须是 `code` + 非空 `reason`；空 code 会让确认时无法判断「还是同一件事」。 */
function assertRisk(risk: RiskSnapshot): void {
  if (typeof risk.code !== "string" || risk.code.trim() === "" || typeof risk.reason !== "string" || risk.reason.trim() === "") {
    throw reviewBroken();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reviewBroken(): NotionToolError {
  return new NotionToolError(CHECK_ERRORS.malformed, {
    code: NOTION_ERROR_CODES.reviewUnavailable,
  });
}
