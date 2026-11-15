import type { MemoryConfig } from "./config.ts";
import { foldDue, spansWithoutJournal, type Ledger } from "./ledger.ts";
import { journalText, stamp } from "./render.ts";

export const TOOL_DESCRIPTIONS = {
  compress:
    "Memory maintenance. Mark tool results to be replaced by a short text at the next compaction. Pass all of them in one call as `items`. For each, `id` is the id in the result's header and `text` says what came of the call and keeps the exact details still needed. Only results older than the protected recent part can be compressed.",
  remove:
    "Memory maintenance. Mark user messages or your own messages to leave the context at the next compaction. Pass all of them in one call as `items`. For each, `id` is the id of a user message, or of one of your messages (the `after` value in the header of the message that follows it), and `reason` is one short phrase. Removing one of your messages also removes its tool calls and their results. A tool result cannot be removed alone.",
  cancel:
    "Memory maintenance. Withdraw pending compressions or removals by the ids of their entries, before they are applied.",
  journal:
    "Memory maintenance. Write the text of one journal entry. `id` is the id of the journal entry to write, as given in the maintenance instructions or in an earlier answer of this tool. A journal entry of rank 1 covers one span of the conversation; one of a higher rank covers journal entries of the rank below. `text` is one paragraph of plain prose: a truthful account of what it covers.",
  recall:
    "Parts of this conversation are kept in a shorter form: a tool result whose header says compressed=\"true\" is a shortened version of the original, and a <journal> block records earlier work that is no longer shown in full. This tool returns what is behind an id. A journal entry of rank 2 or higher returns the journal entries it was written from. A journal entry of rank 1 returns the original entries of its span, in pages; pass `after` with the id the previous page ended on to continue. A compressed tool result, or a number in square brackets inside a journal entry, returns that original entry. A page can be long: in a codemode script, raise the script's output limit in its options line, for example // @options: {\"max_output_tokens\": 30000}.",
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
    "This is a memory maintenance run on a copy of the conversation. It is not a message from the user. Nothing you write here is shown to the user or added to the real conversation. Do not continue the task and do not call any tool except the memory tools described below. When you are finished, reply with the single word: done",
    "",
    "Why this runs: the conversation is long-lived. To keep it going without limit, older parts are shortened or dropped once they are no longer useful, and a journal records what happened. You hold the whole context, so you are the one who can judge.",
    "",
    "What you see in the context: user messages and tool results start with a header such as <entry id=\"4823\" at=\"2026-11-15 09:09\" after=\"4822\"/>. `id` is the id of that entry, `at` is when it was written (UTC), and `after` is the id of your own message just before it; your own messages carry no header. A tool result whose header says compressed=\"true\" was already shortened. A <journal> block is a journal entry that an earlier run like this one wrote.",
    "",
    ...toolReference(config),
    "",
    "Do these steps in order.",
    "",
    "1. Journal.",
  ];
  const foldReady = due !== undefined && due.missing.length === 0;
  if (spans.length > 0 || foldReady) {
    lines.push("Write these journal entries with jcm_journal, one call each, in this order:");
    for (const span of spans) {
      lines.push(`- journal entry ${span.id}, rank 1: covers entries ${span.first} to ${span.last}, ${stamp(span.from)} to ${stamp(span.to)}`);
    }
    if (foldReady) {
      lines.push(`- journal entry ${due.slot.id}, rank ${due.slot.rank}: covers journal entries ${due.slot.covers.join(", ")} of rank ${due.rank}`);
    }
  } else {
    lines.push("No journal entry needs to be written in this run.");
  }
  lines.push(
    `A journal entry is a truthful account of that stretch of the conversation: one paragraph of plain prose, as short as it can be and at most about ${config.journalEntryTokens} tokens. Cover what applies: what was asked, what was done, what was found or decided, what failed, how it ended, what was left unfinished. Keep exact names, paths, numbers and error texts. Say who said what, for example "the user asked", "I proposed". After the one or two statements that matter most, cite the id of the entry that supports them in square brackets, for example: the build failed with TS2322 [4871]. Record what happened; do not guess what will be useful later.`,
    `A journal entry of rank 2 or higher covers journal entries of the rank below, by the same rules and in less detail. When jcm_journal answers that one is now due, write it too. Before you write one you may call jcm_recall on the most important journal entries it covers, as far down as you need, to get the details right.`,
  );
  lines.push(
    "",
    "2. Compress.",
    `Look at the tool results with an id lower than ${cut}. For each one whose full content is no longer needed for the work ahead, write a short text that says what came of the call and keeps the exact details that still matter, and pass all of them to jcm_compress in one call. The text may be at most about ${config.compressedTextTokens} tokens and at most ${Math.round(config.compressedTextRatio * 100)}% of the original. Leave a result as it is while its full content is still useful, and skip results that are already short.`,
    "",
    "3. Remove.",
    `Look at the user messages and your own messages with an id lower than ${cut}. Pass every one that is no longer useful for the current working context, the open work and the goals to jcm_remove in one call, each with its id and a short reason. The id of one of your own messages is the \`after\` value in the header of the message that follows it. Removing one of your messages also removes its tool calls and their results. Keep whatever is still useful, however old it is: instructions and preferences that still apply, decisions in force, open questions. The journal keeps the record of what is removed.`,
    "",
    "4. Cancel.",
    "If something already pending should not happen after all, for example because the work came back to it, call jcm_cancel with its id. If a tool refuses an item, read why and do not repeat the same request.",
    "",
    `Entry ${cut} and every entry after it are the protected recent part. They cannot be compressed or removed, so do not ask for them.`,
    `Already pending, do not repeat them. Compressions: ${pendingCompressions.join(", ") || "none"}. Removals: ${pendingRemovals.join(", ") || "none"}.`,
  );
  if (unseen.length > 0) {
    lines.push("", "Journal entries that are written but not yet shown in the context:");
    for (const entry of unseen) lines.push(journalText(entry));
  }
  lines.push("</memory-maintenance>");
  return lines.join("\n");
}

/** The memory tools as the fork is told about them. The fork is the only one that learns they exist. */
function toolReference(config: MemoryConfig): string[] {
  const how = config.codemodeOnly
    ? [
        "The memory tools are not listed anywhere else. Call them from a codemode script as `await tools.<name>(arguments)`. Each one returns a text that says what it did or why it refused an item. Print what every call returns with console.log so you can read it, for example:",
        "console.log(await tools.jcm_journal({ id: 4830, text: \"...\" }));",
        "You can make several calls in one script.",
      ]
    : ["The memory tools are ordinary tools. Each one answers with a text that says what it did or why it refused an item."];
  return [
    "The memory tools:",
    ...how,
    "- jcm_journal({ id: number, text: string }) writes the text of one journal entry.",
    "- jcm_compress({ items: [{ id: number, text: string }, ...] }) marks tool results to be replaced by the given short text.",
    "- jcm_remove({ items: [{ id: number, reason: string }, ...] }) marks user messages or your own messages to leave the context.",
    "- jcm_cancel({ ids: [number, ...] }) withdraws a pending compression or removal.",
    "- jcm_recall({ id: number, after?: number }) returns what is behind an id: the journal entries a higher-rank journal entry was written from, the original entries of a rank 1 journal entry's span, or the original of one entry.",
    "Nothing these tools mark changes the context now. It is applied later, all at once.",
  ];
}
