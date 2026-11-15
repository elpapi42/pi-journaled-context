import type { Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { EntryRecord } from "@earendil-works/pi-durable";

/** Estimated tokens of a text. */
export const textTokens = (text: string): number => estimateTextTokens(text);

/** Estimated tokens of the messages one entry shows to the model. */
export const messagesTokens = (messages: readonly Message[]): number =>
  messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

/** Estimated tokens an entry originally contributed, before any edit. */
export const entryTokens = (entry: EntryRecord): number => messagesTokens(entry.model ?? []);
