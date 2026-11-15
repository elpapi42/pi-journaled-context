import { defineTool } from "@earendil-works/pi-durable";
import type { MemoryConfig } from "../config.ts";
import { cutFromHistory, findEntry, ownerOfResult, resultsOfEntry } from "../history.ts";
import { isMemoryKind, targetLedger } from "../ledger.ts";
import { TOOL_DESCRIPTIONS } from "../prompts.ts";
import { entryRole, toolCalls } from "../view.ts";
import { answer, idParameter, parameters, refuse, toId } from "./shared.ts";

export const REMOVE_TOOL = "memory_remove";

export function removeTool(config: MemoryConfig) {
  return defineTool({
    name: REMOVE_TOOL,
    description: TOOL_DESCRIPTIONS.remove,
    parameters: parameters({
      id: idParameter("Id of the user message or of your own message to remove."),
      reason: { type: "string", description: "One short phrase saying why it is no longer useful." },
    }),
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const id = toId((args as { id: unknown }).id);
      const reason = String((args as { reason: unknown }).reason ?? "").trim().slice(0, 300);
      if (Number.isNaN(id)) return refuse("`id` must be the number from an entry header.");
      if (reason === "") return refuse("`reason` is empty. Give one short phrase saying why the entry is no longer useful.");
      return api.commit(async (tx) => {
        const { ledger, owner, worker } = await targetLedger(tx, api.conversationId);
        const entry = await findEntry(tx, owner, id);
        if (entry === undefined) return refuse(`There is no entry ${id} in this conversation.`);
        const role = entryRole(entry);
        if (role === "toolResult") {
          const step = await ownerOfResult(tx, owner, entry);
          if (step === undefined) return refuse(`Entry ${id} is a tool result. A tool result cannot be removed alone; it can only be compressed with memory_compress.`);
          const siblings = (await resultsOfEntry(tx, owner, step)).map((result) => result.id);
          return refuse(
            `Entry ${id} is a tool result. A tool result cannot be removed alone. It belongs to your message ${step.id}, which made ${toolCalls(step).length} tool call(s) with results ${siblings.join(", ")}. ` +
              `To remove the whole step call memory_remove with ${step.id}; to shorten only this result call memory_compress with ${id}.`,
          );
        }
        if (role === "other") {
          return refuse(
            isMemoryKind(entry.kind)
              ? `Entry ${id} is a journal entry. Journal entries are never removed; they only fold into coarser ones.`
              : `Entry ${id} is not a user message or one of your messages, so it cannot be removed.`,
          );
        }
        const cut = worker?.cut ?? (await cutFromHistory(tx, owner, config.protectedTokens));
        if (id >= cut) {
          return refuse(`Entry ${id} is inside the protected recent part, which starts at entry ${cut}. Only older entries can be removed.`);
        }
        const existing = ledger.removals[String(id)];
        if (existing?.applied) return refuse(`Entry ${id} was already removed from the context.`);
        if (existing !== undefined) return refuse(`Entry ${id} is already pending removal.`);
        ledger.removals[String(id)] = { reason, applied: false };
        if (role === "user") return answer(`Pending: user message ${id} leaves the context at the next compaction.`);
        const calls = toolCalls(entry);
        if (calls.length === 0) return answer(`Pending: your message ${id} leaves the context at the next compaction.`);
        const results = (await resultsOfEntry(tx, owner, entry)).map((result) => result.id);
        // A pending compression of a result that leaves anyway is no longer needed.
        for (const result of results) if (ledger.compressions[String(result)]?.applied === false) delete ledger.compressions[String(result)];
        return answer(
          `Pending: your message ${id} leaves the context at the next compaction, together with its ${calls.length} tool call(s) (${calls.map((call) => call.name).join(", ")}) and their results ${results.join(", ") || "(none found)"}.`,
        );
      }, context);
    },
  });
}
