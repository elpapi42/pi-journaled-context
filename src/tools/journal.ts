import { defineTool } from "@earendil-works/pi-durable";
import type { MemoryConfig } from "../config.ts";
import { FOLD_KIND, foldDue, targetLedger, type Ledger } from "../ledger.ts";
import { TOOL_DESCRIPTIONS } from "../prompts.ts";
import { textTokens } from "../tokens.ts";
import { answer, idParameter, parameters, refuse, toId } from "./shared.ts";

export const JOURNAL_TOOL = "memory_journal";
export const FOLD_TOOL = "memory_fold";

/** What the caller is told when a rank went over its limit. */
function foldNotice(ledger: Ledger, config: MemoryConfig): string {
  const due = foldDue(ledger, config);
  if (due === undefined) return "";
  return (
    ` A fold is now due: rank ${due.rank} holds more than ${config.rankSize} journal entries. ` +
    `Call ${FOLD_TOOL} with one journal entry of rank ${due.rank + 1} that covers these ${due.entries.length}: ${due.entries.map((entry) => entry.id).join(", ")}. ` +
    `You may call memory_recall on the most important of them first.`
  );
}

function tooLong(text: string, config: MemoryConfig): string | undefined {
  const size = textTokens(text);
  if (size <= config.journalEntryTokens) return undefined;
  return `The text is about ${size} tokens. A journal entry may be at most ${config.journalEntryTokens} tokens. Shorten it and keep the exact names, numbers and cited ids.`;
}

export function journalTool(config: MemoryConfig) {
  return defineTool({
    name: JOURNAL_TOOL,
    description: TOOL_DESCRIPTIONS.journal,
    parameters: parameters({
      span: idParameter("Id of the span the journal entry is for."),
      text: { type: "string", description: "The journal entry: one paragraph of plain prose." },
    }),
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const span = toId((args as { span: unknown }).span);
      const text = String((args as { text: unknown }).text ?? "").trim();
      if (Number.isNaN(span)) return refuse("`span` must be a span id from the maintenance instructions.");
      if (text === "") return refuse("`text` is empty. Write the journal entry.");
      const long = tooLong(text, config);
      if (long !== undefined) return refuse(long);
      return api.commit(async (tx) => {
        const { ledger } = await targetLedger(tx, api.conversationId);
        const record = ledger.spans.find((candidate) => candidate.id === span);
        if (record === undefined) {
          const open = ledger.spans.filter((candidate) => ledger.journal[String(candidate.id)] === undefined).map((candidate) => candidate.id);
          return refuse(`There is no closed span ${span}. Spans that need a journal entry: ${open.join(", ") || "none"}.`);
        }
        if (ledger.journal[String(span)] !== undefined) return refuse(`Span ${span} already has its journal entry. A journal entry is written once.`);
        ledger.journal[String(span)] = { id: span, anchor: span, rank: 1, text, from: record.from, to: record.to, covers: [], applied: false };
        return answer(`Recorded the journal entry of span ${span}. It becomes visible at the next compaction.${foldNotice(ledger, config)}`);
      }, context);
    },
  });
}

export function foldTool(config: MemoryConfig) {
  return defineTool({
    name: FOLD_TOOL,
    description: TOOL_DESCRIPTIONS.fold,
    parameters: parameters({ text: { type: "string", description: "The journal entry of the next rank: one paragraph of plain prose." } }),
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const text = String((args as { text: unknown }).text ?? "").trim();
      if (text === "") return refuse("`text` is empty. Write the journal entry of the next rank.");
      const long = tooLong(text, config);
      if (long !== undefined) return refuse(long);
      return api.commit(async (tx) => {
        const { ledger, owner } = await targetLedger(tx, api.conversationId);
        const due = foldDue(ledger, config);
        if (due === undefined) return refuse("No fold is due. A fold is written only when a rank holds more journal entries than its limit.");
        const covered = due.entries;
        const last = covered[covered.length - 1]!;
        // The fold entry records the fold in the transcript and gives the new journal entry an id of its own.
        const record = await tx.appendEntry(owner, { kind: FOLD_KIND, data: { rank: due.rank + 1, covers: covered.map((entry) => entry.id) } });
        ledger.journal[String(record.id)] = {
          id: record.id,
          // It is rendered where the newest journal entry it covers was.
          anchor: last.anchor,
          rank: due.rank + 1,
          text,
          from: covered[0]!.from,
          to: last.to,
          covers: covered.map((entry) => entry.id),
          applied: false,
        };
        for (const entry of covered) entry.foldedInto = record.id;
        return answer(
          `Recorded journal entry ${record.id} of rank ${due.rank + 1}, covering ${covered.map((entry) => entry.id).join(", ")}. It replaces them at the next compaction.${foldNotice(ledger, config)}`,
        );
      }, context);
    },
  });
}
