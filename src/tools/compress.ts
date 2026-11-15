import { defineTool } from "@earendil-works/pi-durable";
import type { MemoryConfig } from "../config.ts";
import { cutFromHistory, findEntry, ownerOfResult } from "../history.ts";
import { targetLedger } from "../ledger.ts";
import { TOOL_DESCRIPTIONS } from "../prompts.ts";
import { entryTokens, textTokens } from "../tokens.ts";
import { entryRole } from "../view.ts";
import { answer, idParameter, parameters, refuse, toId } from "./shared.ts";

export const COMPRESS_TOOL = "memory_compress";

export function compressTool(config: MemoryConfig) {
  return defineTool({
    name: COMPRESS_TOOL,
    description: TOOL_DESCRIPTIONS.compress,
    parameters: parameters({
      id: idParameter("Id of the tool result to compress."),
      text: { type: "string", description: "The short text that replaces the result." },
    }),
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const id = toId((args as { id: unknown }).id);
      const text = String((args as { text: unknown }).text ?? "").trim();
      if (Number.isNaN(id)) return refuse("`id` must be the number from an entry header.");
      if (text === "") return refuse("`text` is empty. Write the short text that replaces the result.");
      return api.commit(async (tx) => {
        const { ledger, owner, worker } = await targetLedger(tx, api.conversationId);
        const entry = await findEntry(tx, owner, id);
        if (entry === undefined) return refuse(`There is no entry ${id} in this conversation.`);
        const role = entryRole(entry);
        if (role !== "toolResult") {
          return refuse(
            role === "user" || role === "assistant"
              ? `Entry ${id} is a ${role} message. Only tool results can be compressed; a message is kept as it is or removed with memory_remove.`
              : `Entry ${id} is not a tool result, so it cannot be compressed.`,
          );
        }
        const cut = worker?.cut ?? (await cutFromHistory(tx, owner, config.protectedTokens));
        if (id >= cut) {
          return refuse(`Entry ${id} is inside the protected recent part, which starts at entry ${cut}. Only older entries can be compressed.`);
        }
        const existing = ledger.compressions[String(id)];
        if (existing?.applied) return refuse(`Result ${id} is already compressed. Its original is available with memory_recall.`);
        if (existing !== undefined) return refuse(`A compression of result ${id} is already pending. Call memory_cancel with ${id} first to replace it.`);
        const step = await ownerOfResult(tx, owner, entry);
        if (step !== undefined && ledger.removals[String(step.id)] !== undefined) {
          return refuse(`Result ${id} belongs to entry ${step.id}, which is already marked for removal, so it leaves with that entry.`);
        }
        const original = entryTokens(entry);
        const size = textTokens(text);
        const limit = Math.min(config.compressedTextTokens, Math.floor(original * config.compressedTextRatio));
        if (size > limit) {
          return refuse(
            original * config.compressedTextRatio < config.compressedTextTokens
              ? `The result is about ${original} tokens and the text about ${size}. A compressed text must be at most ${Math.round(config.compressedTextRatio * 100)}% of the original (${limit} tokens here). This result is already short; leave it as it is unless you can say it in far fewer words.`
              : `The text is about ${size} tokens. A compressed text may be at most ${config.compressedTextTokens} tokens. Shorten it.`,
          );
        }
        ledger.compressions[String(id)] = { text, applied: false };
        return answer(`Pending: result ${id} goes from about ${original} to about ${size} tokens at the next compaction.`);
      }, context);
    },
  });
}
