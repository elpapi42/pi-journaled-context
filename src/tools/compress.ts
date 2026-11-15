import { defineTool, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import type { MemoryConfig } from "../config.ts";
import { cutFromHistory, findEntry, ownerOfResult } from "../history.ts";
import { targetLedger, type Ledger } from "../ledger.ts";
import { TOOL_DESCRIPTIONS } from "../prompts.ts";
import { entryTokens, textTokens } from "../tokens.ts";
import { entryRole } from "../view.ts";
import { batchAnswer, done, idParameter, parameters, refused, toId, toItems, type ItemResult } from "./shared.ts";

export const COMPRESS_TOOL = "memory_compress";

export function compressTool(config: MemoryConfig) {
  return defineTool({
    name: COMPRESS_TOOL,
    description: TOOL_DESCRIPTIONS.compress,
    parameters: parameters({
      items: {
        type: "array",
        description: "The results to compress. Several can be passed in one call.",
        items: parameters({
          id: idParameter("Id of the tool result to compress."),
          text: { type: "string", description: "The short text that replaces the result." },
        }),
      },
    }),
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const items = toItems((args as { items?: unknown }).items);
      return api.commit(async (tx) => {
        const { ledger, owner, worker } = await targetLedger(tx, api.conversationId);
        const cut = worker?.cut ?? (await cutFromHistory(tx, owner, config.protectedTokens));
        const results: ItemResult[] = [];
        for (const item of items) results.push(await compressOne(tx, owner, ledger, cut, toId(item.id), String(item.text ?? "").trim(), config));
        return batchAnswer(results);
      }, context);
    },
  });
}

async function compressOne(tx: Tx, owner: ConversationId, ledger: Ledger, cut: number, id: number, text: string, config: MemoryConfig): Promise<ItemResult> {
  if (Number.isNaN(id)) return refused("`id` must be the number from an entry header.");
  if (text === "") return refused(`Result ${id}: \`text\` is empty. Write the short text that replaces the result.`);
  const entry = await findEntry(tx, owner, id);
  if (entry === undefined) return refused(`There is no entry ${id} in this conversation.`);
  const role = entryRole(entry);
  if (role !== "toolResult") {
    return refused(
      role === "user" || role === "assistant"
        ? `Entry ${id} is a ${role} message. Only tool results can be compressed; a message is kept as it is or removed with memory_remove.`
        : `Entry ${id} is not a tool result, so it cannot be compressed.`,
    );
  }
  if (id >= cut) return refused(`Entry ${id} is inside the protected recent part, which starts at entry ${cut}. Only older entries can be compressed.`);
  const existing = ledger.compressions[String(id)];
  if (existing?.applied) return refused(`Result ${id} is already compressed. Its original is available with memory_recall.`);
  if (existing !== undefined) return refused(`A compression of result ${id} is already pending. Call memory_cancel with ${id} first to replace it.`);
  const step = await ownerOfResult(tx, owner, entry);
  if (step !== undefined && ledger.removals[String(step.id)] !== undefined) {
    return refused(`Result ${id} belongs to your message ${step.id}, which is already marked for removal, so it leaves with that message.`);
  }
  const original = entryTokens(entry);
  const size = textTokens(text);
  const limit = Math.min(config.compressedTextTokens, Math.floor(original * config.compressedTextRatio));
  if (size > limit) {
    return refused(
      original * config.compressedTextRatio < config.compressedTextTokens
        ? `Result ${id} is about ${original} tokens and the text about ${size}. A compressed text must be at most ${Math.round(config.compressedTextRatio * 100)}% of the original (${limit} tokens here). This result is already short; leave it as it is unless you can say it in far fewer words.`
        : `Result ${id}: the text is about ${size} tokens. A compressed text may be at most ${config.compressedTextTokens} tokens. Shorten it.`,
    );
  }
  ledger.compressions[String(id)] = { text, applied: false };
  return done(`Pending: result ${id} goes from about ${original} to about ${size} tokens at the next compaction.`);
}
