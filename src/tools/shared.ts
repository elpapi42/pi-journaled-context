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
