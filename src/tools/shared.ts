import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/** A normal answer of a memory tool. */
export const answer = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }] });

/** A refusal. It always says why, so the caller can correct itself. */
export const refuse = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

/** A JSON Schema object with every property required. */
export function parameters(properties: Record<string, object>, optional: readonly string[] = []) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    additionalProperties: false,
  } as const;
}

export const idParameter = (description: string) => ({ type: "integer", description });

/** An id argument as a number; models sometimes send it as a string. */
export function toId(value: unknown): number {
  const id = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isInteger(id) ? id : Number.NaN;
}

/** The outcome of one item of a batched call. */
export type ItemResult = { ok: boolean; text: string };
export const done = (text: string): ItemResult => ({ ok: true, text });
export const refused = (text: string): ItemResult => ({ ok: false, text });

/** One answer for a batch: a line per item. It is an error only when every item was refused. */
export function batchAnswer(results: readonly ItemResult[]): ToolExecutionResult {
  if (results.length === 0) return refuse("`items` is empty. Pass at least one item.");
  const text = results.map((result) => (result.ok ? result.text : `Refused: ${result.text}`)).join("\n");
  return results.some((result) => result.ok) ? answer(text) : refuse(text);
}

/** The `items` argument as a list of objects; a single object is accepted as a list of one. */
export function toItems(value: unknown): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}
