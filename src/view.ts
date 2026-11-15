import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContextView, EntryRecord } from "@earendil-works/pi-durable";
import { messagesTokens } from "./tokens.ts";

/** What an entry is for the memory system, judged by the messages it originally contributed. */
export type EntryRole = "user" | "assistant" | "toolResult" | "other";

export function entryRole(entry: EntryRecord): EntryRole {
  const first = entry.model?.[0];
  if (first === undefined) return "other";
  if (first.role === "user" || first.role === "assistant" || first.role === "toolResult") return first.role;
  return "other";
}

export function assistantMessage(entry: EntryRecord): AssistantMessage | undefined {
  const first = entry.model?.[0];
  return first?.role === "assistant" ? first : undefined;
}

export function toolResultMessage(entry: EntryRecord): ToolResultMessage | undefined {
  const first = entry.model?.[0];
  return first?.role === "toolResult" ? first : undefined;
}

export function toolCalls(entry: EntryRecord): ToolCall[] {
  return assistantMessage(entry)?.content.filter((part): part is ToolCall => part.type === "toolCall") ?? [];
}

/** The index of an entry in a view, by id. */
export function indexOfEntry(view: ContextView, id: number): number {
  return view.entries.findIndex((entry) => entry.id === id);
}

/** Whether the entry still shows something to the model in this view. */
export function isVisible(view: ContextView, id: number): boolean {
  const index = indexOfEntry(view, id);
  return index >= 0 && (view.contributions[index]?.length ?? 0) > 0;
}

/** The assistant entry whose tool call a result answers, searching back from the result. */
export function ownerOfResult(view: ContextView, result: EntryRecord): EntryRecord | undefined {
  const callId = toolResultMessage(result)?.toolCallId;
  if (callId === undefined) return undefined;
  for (let index = indexOfEntry(view, result.id) - 1; index >= 0; index--) {
    const entry = view.entries[index];
    if (entry !== undefined && toolCalls(entry).some((call) => call.id === callId)) return entry;
  }
  return undefined;
}

/** The result entries of an assistant entry's tool calls. */
export function resultsOf(view: ContextView, assistant: EntryRecord): EntryRecord[] {
  const callIds = new Set(toolCalls(assistant).map((call) => call.id));
  if (callIds.size === 0) return [];
  return view.entries.filter((entry) => {
    const callId = toolResultMessage(entry)?.toolCallId;
    return entry.id > assistant.id && callId !== undefined && callIds.has(callId);
  });
}

/**
 * The cut point: the id below which entries may be compressed or removed. Walks back from the newest entry until
 * `protectedTokens` are kept. When the whole context is smaller than that, nothing is old enough and the cut is the
 * first entry.
 */
export function cutPoint(view: ContextView, protectedTokens: number): number {
  let kept = 0;
  for (let index = view.entries.length - 1; index >= 0; index--) {
    kept += messagesTokens(view.contributions[index] ?? []);
    if (kept >= protectedTokens) return view.entries[index]!.id;
  }
  return view.entries[0]?.id ?? 0;
}

/** Estimated size of the context a request would send. */
export function contextTokens(view: ContextView): number {
  return messagesTokens(view.messages);
}

/** Plain text of a message's content, for answers and for size checks. */
export function plainText(message: Message): string {
  if (message.role === "system") return typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join("");
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : part.type === "thinking" ? "" : part.type === "toolCall" ? "" : "[image]"))
    .join("");
}
