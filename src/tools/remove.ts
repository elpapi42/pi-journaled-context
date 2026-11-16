import { defineTool, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import type { MemoryConfig } from "../config.ts";
import { cutFromHistory, findEntry, ownerOfResult, resultsOfEntry } from "../history.ts";
import { isMemoryKind, targetLedger, type Ledger } from "../ledger.ts";
import { TOOL_DESCRIPTIONS } from "../prompts.ts";
import { entryRole, toolCalls } from "../view.ts";
import { batchAnswer, done, idParameter, parameters, refused, toId, toItems, type ItemResult } from "./shared.ts";

export const REMOVE_TOOL = "jcm_remove";

export function removeTool(config: MemoryConfig) {
  return defineTool({
    name: REMOVE_TOOL,
    description: TOOL_DESCRIPTIONS.remove,
    parameters: parameters({
      items: {
        type: "array",
        description: "The messages to remove. Several can be passed in one call.",
        items: parameters({
          id: idParameter("Id of the user message or of your own message to remove."),
          reason: { type: "string", description: "One short phrase saying why it is no longer useful." },
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
        for (const item of items) results.push(await removeOne(tx, owner, ledger, cut, toId(item.id), String(item.reason ?? "").trim().slice(0, 300)));
        return batchAnswer(results);
      }, context);
    },
  });
}

async function removeOne(tx: Tx, owner: ConversationId, ledger: Ledger, cut: number, id: number, reason: string): Promise<ItemResult> {
  if (Number.isNaN(id)) return refused("`id` must be the number from an entry header.");
  if (reason === "") return refused(`Entry ${id}: \`reason\` is empty. Give one short phrase saying why it is no longer useful.`);
  const entry = await findEntry(tx, owner, id);
  if (entry === undefined) return refused(`There is no entry ${id} in this conversation.`);
  const role = entryRole(entry);
  if (role === "toolResult") {
    const step = await ownerOfResult(tx, owner, entry);
    if (step === undefined) return refused(`Entry ${id} is a tool result. A tool result cannot be removed alone; it can only be compressed with jcm_compress.`);
    const siblings = (await resultsOfEntry(tx, owner, step)).map((result) => result.id);
    return refused(
      `Entry ${id} is a tool result. A tool result cannot be removed alone. It belongs to your message ${step.id}, which made ${toolCalls(step).length} tool call(s) with results ${siblings.join(", ")}. ` +
        `To remove the whole step call jcm_remove with ${step.id}; to shorten only this result call jcm_compress with ${id}.`,
    );
  }
  if (role === "other") {
    return refused(
      isMemoryKind(entry.kind)
        ? `Entry ${id} is a journal entry. Journal entries are never removed; they only fold into coarser ones.`
        : `Entry ${id} is not a user message or one of your messages, so it cannot be removed.`,
    );
  }
  if (id >= cut) return refused(`Entry ${id} is inside the protected recent part, which starts at entry ${cut}. Only older entries can be removed.`);
  const existing = ledger.removals[String(id)];
  if (existing?.applied) return refused(`Entry ${id} was already removed from the context.`);
  if (existing !== undefined) return refused(`Entry ${id} is already pending removal.`);
  const calls = role === "user" ? [] : toolCalls(entry);
  const results = calls.length === 0 ? [] : (await resultsOfEntry(tx, owner, entry)).map((result) => result.id);
  ledger.removals[String(id)] = { reason, applied: false, results };
  if (role === "user") return done(`Pending: user message ${id} leaves the context at the next compaction.`);
  if (calls.length === 0) return done(`Pending: your message ${id} leaves the context at the next compaction.`);
  // A pending compression of a result that leaves anyway is no longer needed.
  for (const result of results) if (ledger.compressions[String(result)]?.applied === false) delete ledger.compressions[String(result)];
  return done(
    `Pending: your message ${id} leaves the context at the next compaction, together with its ${calls.length} tool call(s) (${calls.map((call) => call.name).join(", ")}) and their results ${results.join(", ") || "(none found)"}.`,
  );
}
