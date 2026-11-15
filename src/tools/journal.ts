import { defineTool } from "@earendil-works/pi-durable";
import type { MemoryConfig } from "../config.ts";
import { foldDue, liveIds, spansWithoutJournal, targetLedger, type Ledger } from "../ledger.ts";
import { TOOL_DESCRIPTIONS } from "../prompts.ts";
import { textTokens } from "../tokens.ts";
import { answer, idParameter, parameters, refuse, toId } from "./shared.ts";

export const JOURNAL_TOOL = "jcm_journal";

/** What the caller is told when writing a journal entry made one of the next rank due. */
function dueNotice(ledger: Ledger, config: MemoryConfig): string {
  const due = foldDue(ledger, config);
  // A journal entry of a higher rank waits until every journal entry it covers is written.
  if (due === undefined || due.missing.length > 0) return "";
  return (
    ` Journal entry ${due.slot.id} of rank ${due.slot.rank} is now due, because rank ${due.rank} holds more than ${config.rankSize}. ` +
    `It covers these ${due.entries.length} journal entries of rank ${due.rank}: ${due.slot.covers.join(", ")}. ` +
    `Write it with ${JOURNAL_TOOL} and id ${due.slot.id}. You may call jcm_recall on the most important of them first.`
  );
}

/** The journal entries that can be written now, for a refusal that has to say what is possible. */
function waiting(ledger: Ledger, config: MemoryConfig): string {
  const ids = spansWithoutJournal(ledger).map((span) => span.id);
  const due = foldDue(ledger, config);
  if (due !== undefined && due.missing.length === 0) ids.push(due.slot.id);
  return ids.join(", ") || "none";
}

/**
 * One tool writes the text of any journal entry. Every journal entry has a reserved entry before its text exists: the
 * marker of its span at rank 1, a slot above that. So the caller only names the journal entry to write.
 */
export function journalTool(config: MemoryConfig) {
  return defineTool({
    name: JOURNAL_TOOL,
    description: TOOL_DESCRIPTIONS.journal,
    parameters: parameters({
      id: idParameter("Id of the journal entry to write."),
      text: { type: "string", description: "The journal entry: one paragraph of plain prose." },
    }),
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const id = toId((args as { id: unknown }).id);
      const text = String((args as { text: unknown }).text ?? "").trim();
      if (Number.isNaN(id)) return refuse("`id` must be the id of a journal entry to write, as given in the maintenance instructions.");
      if (text === "") return refuse("`text` is empty. Write the journal entry.");
      const size = textTokens(text);
      if (size > config.journalEntryTokens) {
        return refuse(`The text is about ${size} tokens. A journal entry may be at most ${config.journalEntryTokens} tokens. Shorten it and keep the exact names, numbers and cited ids.`);
      }
      return api.commit(async (tx) => {
        const { ledger } = await targetLedger(tx, api.conversationId);
        if (ledger.journal[String(id)] !== undefined) return refuse(`Journal entry ${id} is already written. A journal entry is written once.`);

        // Rank 1: the journal entry of one closed span.
        const span = ledger.spans.find((candidate) => candidate.id === id);
        if (span !== undefined) {
          ledger.journal[String(id)] = { id, anchor: id, rank: 1, text, from: span.from, to: span.to, covers: [], applied: false };
          return answer(`Recorded journal entry ${id} of rank 1. It becomes visible at the next compaction.${dueNotice(ledger, config)}`);
        }

        // A higher rank: its place was reserved when the journal entries it covers were collected.
        const slot = ledger.slots.find((candidate) => candidate.id === id);
        if (slot === undefined) return refuse(`There is no journal entry ${id} waiting for its text. Waiting now: ${waiting(ledger, config)}.`);
        const due = foldDue(ledger, config);
        if (due === undefined || due.slot.id !== id) {
          const held = liveIds(ledger, slot.rank - 1).length;
          return refuse(
            due === undefined
              ? `Journal entry ${id} of rank ${slot.rank} is not due yet. It is written when rank ${slot.rank - 1} holds more than ${config.rankSize} journal entries; it holds ${held} now.`
              : `Journal entry ${id} of rank ${slot.rank} is not due yet. Journal entry ${due.slot.id} of rank ${due.slot.rank} comes first.`,
          );
        }
        if (due.missing.length > 0) {
          return refuse(`Journal entry ${id} of rank ${slot.rank} covers journal entries that are not written yet: ${due.missing.join(", ")}. Write those first.`);
        }
        const covered = due.entries;
        ledger.journal[String(id)] = {
          id,
          anchor: id,
          rank: slot.rank,
          text,
          from: covered[0]!.from,
          to: covered[covered.length - 1]!.to,
          covers: [...slot.covers],
          applied: false,
        };
        for (const entry of covered) entry.foldedInto = id;
        return answer(
          `Recorded journal entry ${id} of rank ${slot.rank}, covering ${slot.covers.join(", ")}. It replaces them at the next compaction.${dueNotice(ledger, config)}`,
        );
      }, context);
    },
  });
}
