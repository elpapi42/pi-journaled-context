import { defineTool } from "@earendil-works/pi-durable";
import { targetLedger, type Ledger } from "../ledger.ts";
import { TOOL_DESCRIPTIONS } from "../prompts.ts";
import { batchAnswer, done, idParameter, parameters, refused, toId, type ItemResult } from "./shared.ts";

export const CANCEL_TOOL = "jcm_cancel";

export function cancelTool() {
  return defineTool({
    name: CANCEL_TOOL,
    description: TOOL_DESCRIPTIONS.cancel,
    parameters: parameters({
      ids: { type: "array", description: "Ids of the entries whose pending compression or removal is withdrawn.", items: idParameter("An entry id.") },
    }),
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const raw = (args as { ids?: unknown }).ids;
      const ids = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]).map(toId);
      return api.commit(async (tx) => {
        const { ledger } = await targetLedger(tx, api.conversationId);
        return batchAnswer(ids.map((id) => cancelOne(ledger, id)));
      }, context);
    },
  });
}

function cancelOne(ledger: Ledger, id: number): ItemResult {
  if (Number.isNaN(id)) return refused("each id must be the number from an entry header.");
  const key = String(id);
  const cancelled: string[] = [];
  const tooLate: string[] = [];
  const compression = ledger.compressions[key];
  if (compression !== undefined) {
    if (compression.applied) tooLate.push("its compression was already applied; the original is available with jcm_recall");
    else {
      delete ledger.compressions[key];
      cancelled.push("compression");
    }
  }
  const removal = ledger.removals[key];
  if (removal !== undefined) {
    if (removal.applied) tooLate.push("it was already removed from the context; it can still be read with jcm_recall through the journal entry of its span");
    else {
      delete ledger.removals[key];
      cancelled.push("removal");
    }
  }
  if (cancelled.length > 0) return done(`Cancelled the pending ${cancelled.join(" and ")} of entry ${id}.`);
  if (tooLate.length > 0) return refused(`Too late to cancel for entry ${id}: ${tooLate.join("; ")}.`);
  return refused(`Nothing is pending for entry ${id}.`);
}
