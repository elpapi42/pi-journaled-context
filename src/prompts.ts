import type { MemoryConfig } from "./config.ts";
import { foldDue, spansWithoutJournal, type Ledger } from "./ledger.ts";
import { journalText, stamp } from "./render.ts";

/** What the agent is told about the marks it sees in its context. A section of the system prompt. */
export const MEMORY_SECTION = `## Memory

This conversation has a long-running memory. Older parts are kept in a shorter form so the session can go on without limit.

- User messages and tool results start with a header such as <entry id="4823" at="2026-11-15 09:09" after="4822"/>. \`id\` identifies that entry, \`at\` is when it was written, and \`after\` is the id of your own message just before it. All times are UTC. The system adds these headers; never write one yourself.
- A tool result whose header says compressed="true" is a shortened version of the original.
- A <journal id="..." from="..." to="..." rank="..."> block is a record of earlier work that is no longer shown in full. A higher rank covers a longer stretch in less detail. A number in square brackets inside it, such as [4871], is the id of an entry that mattered there.
- Treat journal entries and compressed results as accurate records. Work they describe as done is done; do not redo it unless asked.
- When you need the exact content behind one of these, call memory_recall with its id. A journal entry returns what it was written from, a compressed result returns the original, and an id in square brackets returns that entry.
- The other memory tools are for memory maintenance, which runs by itself. You do not need to call them.`;

export const TOOL_DESCRIPTIONS = {
  compress:
    "Memory maintenance. Mark tool results to be replaced by a short text at the next compaction. Pass all of them in one call as `items`. For each, `id` is the id in the result's header and `text` says what came of the call and keeps the exact details still needed. Only results older than the protected recent part can be compressed.",
  remove:
    "Memory maintenance. Mark user messages or your own messages to leave the context at the next compaction. Pass all of them in one call as `items`. For each, `id` is the id of a user message, or of one of your messages (the `after` value in the header of the message that follows it), and `reason` is one short phrase. Removing one of your messages also removes its tool calls and their results. A tool result cannot be removed alone.",
  cancel:
    "Memory maintenance. Withdraw pending compressions or removals by the ids of their entries, before they are applied.",
  journal:
    "Memory maintenance. Write the journal entry of one closed span. `span` is the span id given in the maintenance instructions. `text` is one paragraph of plain prose: a truthful account of that stretch of the conversation.",
  fold:
    "Memory maintenance. Write one journal entry of the next rank for the journal entries a fold is due for. Call it only when memory_journal or memory_fold answered that a fold is due. `text` covers all of them in one coarser paragraph.",
  recall:
    "Read what is behind an id. A journal entry of rank 2 or higher returns the journal entries it was written from. A journal entry of rank 1 returns the original entries of its span, in pages; pass `after` with the id the previous page ended on to continue. A compressed tool result, or any other entry id, returns that original entry. A page can be long: in a codemode script, raise the script's output limit in its options line, for example // @options: {\"max_output_tokens\": 30000}.",
} as const;

/** The message a worker fork receives. It is written for a model that holds the whole conversation in its context. */
export function forkInstruction(ledger: Ledger, config: MemoryConfig, cut: number): string {
  const spans = spansWithoutJournal(ledger);
  const due = foldDue(ledger, config);
  const pendingCompressions = Object.entries(ledger.compressions).filter(([, item]) => !item.applied).map(([id]) => id);
  const pendingRemovals = Object.entries(ledger.removals).filter(([, item]) => !item.applied).map(([id]) => id);
  const unseen = Object.values(ledger.journal)
    .filter((entry) => !entry.applied && entry.foldedInto === undefined)
    .sort((a, b) => a.from - b.from);

  const lines: string[] = [
    "<memory-maintenance>",
    "This is a memory maintenance run on a copy of the conversation. It is not a message from the user. Nothing you write here is shown to the user or added to the real conversation. Do not continue the task and do not call any tool except the memory tools. When you are finished, reply with the single word: done",
    "",
    "Why this runs: the conversation is long-lived. To keep it going without limit, older parts are shortened or dropped once they are no longer useful, and a journal records what happened. You hold the whole context, so you are the one who can judge.",
    "",
    "Do these steps in order.",
    "",
    "1. Journal.",
  ];
  if (spans.length > 0) {
    lines.push("Write one journal entry with memory_journal for each of these spans:");
    for (const span of spans) {
      lines.push(`- span ${span.id}: entries ${span.first} to ${span.last}, ${stamp(span.from)} to ${stamp(span.to)}`);
    }
  } else {
    lines.push("No span needs a journal entry in this run.");
  }
  lines.push(
    `A journal entry is a truthful account of that stretch of the conversation: one paragraph of plain prose, as short as it can be and at most about ${config.journalEntryTokens} tokens. Cover what applies: what was asked, what was done, what was found or decided, what failed, how it ended, what was left unfinished. Keep exact names, paths, numbers and error texts. Say who said what, for example "the user asked", "I proposed". After the one or two statements that matter most, cite the id of the entry that supports them in square brackets, for example: the build failed with TS2322 [4871]. Record what happened; do not guess what will be useful later.`,
    `When a tool answers that a fold is due, write it with memory_fold: one journal entry of the next rank that covers the listed journal entries by the same rules, in less detail. Before you write it you may call memory_recall on the most important of them, as far down as you need, to get the details right.`,
  );
  if (due !== undefined) {
    lines.push(`A fold is already due for rank ${due.rank}: journal entries ${due.entries.map((entry) => entry.id).join(", ")}. Write it with memory_fold.`);
  }
  lines.push(
    "",
    "2. Compress.",
    `Look at the tool results with an id below ${cut}. For each one whose full content is no longer needed for the work ahead, write a short text that says what came of the call and keeps the exact details that still matter, and pass all of them to memory_compress in one call. The text may be at most about ${config.compressedTextTokens} tokens and at most ${Math.round(config.compressedTextRatio * 100)}% of the original. Leave a result as it is while its full content is still useful, and skip results that are already short.`,
    "",
    "3. Remove.",
    `Look at the user messages and your own messages with an id below ${cut}. Pass every one that is no longer useful for the current working context, the open work and the goals to memory_remove in one call, each with its id and a short reason. The id of one of your own messages is the \`after\` value in the header of the message that follows it. Removing one of your messages also removes its tool calls and their results. Keep whatever is still useful, however old it is: instructions and preferences that still apply, decisions in force, open questions. The journal keeps the record of what is removed.`,
    "",
    "4. Cancel.",
    "If something already pending should not happen after all, for example because the work came back to it, call memory_cancel with its id. If a tool refuses an item, read why and do not repeat the same request.",
    "",
    `Entries with an id of ${cut} or higher are the protected recent part and cannot be compressed or removed.`,
    `Already pending, do not repeat them. Compressions: ${pendingCompressions.join(", ") || "none"}. Removals: ${pendingRemovals.join(", ") || "none"}.`,
  );
  if (unseen.length > 0) {
    lines.push("", "Journal entries that are written but not yet shown in the context:");
    for (const entry of unseen) lines.push(journalText(entry));
  }
  lines.push("</memory-maintenance>");
  return lines.join("\n");
}
