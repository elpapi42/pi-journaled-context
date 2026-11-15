import { defineTool } from "@earendil-works/pi-durable";
import { targetLedger } from "../ledger.ts";
import { TOOL_DESCRIPTIONS } from "../prompts.ts";
import { answer, idParameter, parameters, refuse, toId } from "./shared.ts";

export const CANCEL_TOOL = "memory_cancel";

export function cancelTool() {
  return defineTool({
    name: CANCEL_TOOL,
    description: TOOL_DESCRIPTIONS.cancel,
    parameters: parameters({ id: idParameter("Id of the entry whose pending compression or removal is withdrawn.") }),
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const id = toId((args as { id: unknown }).id);
      if (Number.isNaN(id)) return refuse("`id` must be the number from an entry header.");
      return api.commit(async (tx) => {
        const { ledger } = await targetLedger(tx, api.conversationId);
        const key = String(id);
        const cancelled: string[] = [];
        const tooLate: string[] = [];
        const compression = ledger.compressions[key];
        if (compression !== undefined) {
          if (compression.applied) tooLate.push("its compression was already applied; the original is available with memory_recall");
          else {
            delete ledger.compressions[key];
            cancelled.push("compression");
          }
        }
        const removal = ledger.removals[key];
        if (removal !== undefined) {
          if (removal.applied) tooLate.push("it was already removed from the context; it can still be read with memory_recall through the journal entry of its span");
          else {
            delete ledger.removals[key];
            cancelled.push("removal");
          }
        }
        if (cancelled.length > 0) return answer(`Cancelled the pending ${cancelled.join(" and ")} of entry ${id}.`);
        if (tooLate.length > 0) return refuse(`Too late to cancel for entry ${id}: ${tooLate.join("; ")}.`);
        return refuse(`Nothing is pending for entry ${id}.`);
      }, context);
    },
  });
}
