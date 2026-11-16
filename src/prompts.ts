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

const INTRODUCTION =
  "This is a memory maintenance run on a copy of the conversation. It is not a message from the user. Nothing you write here is shown to the user or added to the real conversation. Do not continue what you were doing in the conversation, and do not call any tool except the memory tools described below. When you are finished, reply with the single word: done";

/** What the fork is for. It comes first: every later step is judged against it. */
const GOAL = [
  "Your goal",
  "Make the context as small as it can be while it still holds everything this conversation needs in its present state. Keep as much as is required, and remove as much as possible.",
  "",
  "The present state is not the last few messages. It is everything in the whole conversation that is still alive at this point:",
  "",
  "- The goals. What the user is trying to achieve, at every level: the larger aim and the task at hand. A goal stated once at the start and never repeated is still a goal, until it is met or the user gives it up.",
  "- The open workstreams. Every piece of work that was started and has not ended. Work ends when it is finished and accepted, when another approach replaces it, or when the user drops it. Nothing else ends it. Work that was interrupted, that waits for a person or an event, or that nobody has mentioned for a long time is paused, and paused work is open. Look for it through the whole conversation: a question nobody answered, a follow-up that was promised, a known problem left for later, a plan with steps remaining.",
  "- The standing context. What holds across the work: instructions and preferences the user gave, decisions that are in force with the reasons that still bind them, and facts that were found out and are still true, such as how something works, where something is, or what state something was left in.",
  "",
  "For each open workstream, the context must hold what is needed to go on with it without doing work again: what it is for, what was decided, where it stands, and what comes next or what it waits for.",
  "",
  "Judge each older entry by what it carries, not by its age. An entry carries state or path. State is what is true and in force now. Path is how the conversation got there: exploring, reading, attempts that failed, versions that were replaced, discussions that were settled. State stays, in its latest form: an entry whose content a later entry repeats or replaces leaves. Path leaves once the journal records it, also the path of open work.",
  "",
  'The line is not sharp, so use this test: an entry stays only if you can name what needs it, whether a goal, an open workstream or a standing instruction. "It may be useful later", with nothing named, is not a reason. An entry from an hour ago that a paused workstream needs stays. An entry from five minutes ago that belongs to finished work leaves. Nothing is lost by a removal: the journal keeps the record, and jcm_recall brings back any original.',
];

const CONTEXT_GUIDE = [
  "What you see in the context",
  'User messages and tool results start with a header such as <entry id="4823" at="2026-11-15 09:09" after="4822"/>. `id` is the id of that entry, `at` is when it was written (UTC), and `after` is the id of your own message just before it; your own messages carry no header. A tool result whose header says compressed="true" was already shortened. A <journal> block is a journal entry that an earlier run like this one wrote.',
];

/**
 * What earlier fork runs decided and no compaction has applied yet. The fork cannot see any of it in the context:
 * a pending edit changes nothing until it is applied, and the context cannot carry a mark, because the fork must be
 * sent the same context as its parent to read the parent's provider cache.
 */
function pendingEdits(ledger: Ledger): string[] {
  // A removal of one of the assistant's messages is listed with the tool results that leave with it.
  const removals = Object.entries(ledger.removals)
    .filter(([, item]) => !item.applied)
    .map(([id, item]) => (item.results === undefined || item.results.length === 0 ? id : `${id} (results ${item.results.join(", ")})`));
  const compressions = Object.entries(ledger.compressions).filter(([, item]) => !item.applied).map(([id]) => id);
  const journal = Object.values(ledger.journal)
    .filter((entry) => !entry.applied && entry.foldedInto === undefined)
    .sort((a, b) => a.from - b.from);

  const lines = [
    "Pending edits",
    "A run like this one does not change the context. It records edits, and they are all applied together later, at the next compaction. Until then the context looks as it did before them: an entry marked for removal is still there in full, a tool result marked for compression still shows its original, and a journal entry that was written is not shown yet.",
    "",
  ];
  if (removals.length + compressions.length + journal.length === 0) return [...lines, "No edit is pending now."];
  lines.push("The edits below were recorded by earlier runs and are waiting to be applied. Read the context as if they were already applied, and do not decide about these entries again.", "");

  if (removals.length === 0) lines.push("Pending removals: none");
  else {
    lines.push(
      `Pending removals: ${removals.length}`,
      "These entries leave the context. An id followed by brackets is one of your messages, and the ids in the brackets are the results of its tool calls, which leave with it.",
      removals.join(", "),
    );
  }
  lines.push("");
  if (compressions.length === 0) lines.push("Pending compressions: none");
  else lines.push(`Pending compressions: ${compressions.length}`, "These tool results are replaced by a short text. Each is listed by the id of the result.", compressions.join(", "));
  lines.push("");
  if (journal.length === 0) lines.push("Pending journal entries: none");
  else {
    lines.push(
      `Pending journal entries: ${journal.length}`,
      "These are written and appear in the context at the place of the entries they cover. What they cover is on record, so those entries can leave.",
      ...journal.map(journalText),
    );
  }
  lines.push("", "If one of these edits should not happen after all, because the work came back to that entry, withdraw it with jcm_cancel.");
  return lines;
}

function journalStep(ledger: Ledger, config: MemoryConfig): string[] {
  const spans = spansWithoutJournal(ledger);
  const due = foldDue(ledger, config);
  const foldReady = due !== undefined && due.missing.length === 0;
  const lines = ["1. Journal."];
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
  return lines;
}

/**
 * The message a worker fork receives. It is written for a model that holds the whole conversation in its context.
 * Removing comes before compressing: a compression of a result whose message is removed afterwards is thrown away.
 */
export function forkInstruction(ledger: Ledger, config: MemoryConfig, cut: number): string {
  return [
    "<memory-maintenance>",
    INTRODUCTION,
    "",
    ...GOAL,
    "",
    ...CONTEXT_GUIDE,
    "",
    ...pendingEdits(ledger),
    "",
    ...toolReference(config),
    "",
    "Do these steps in order.",
    "",
    ...journalStep(ledger, config),
    "",
    "2. Take stock.",
    "In your reply, before any other call, state in a few lines: the goals; each open workstream, with whether it is active, paused or waiting and for what; and the standing context. The next two steps are judged against this.",
    "",
    "3. Remove.",
    `Look at the user messages and your own messages with an id lower than ${cut}. Pass every one that the goals, the open workstreams and the standing context do not need to jcm_remove in one call, each with its id and a short reason. The id of one of your own messages is the \`after\` value in the header of the message that follows it. Removing one of your messages also removes its tool calls and their results, so a finished step leaves as one item.`,
    "",
    "4. Compress.",
    `Now look at the tool results with an id lower than ${cut} whose message you did not remove. Where a result is still needed but not in full, write a short text that says what came of the call and keeps the exact details that still matter, and pass all of them to jcm_compress in one call. The text may be at most about ${config.compressedTextTokens} tokens and at most ${Math.round(config.compressedTextRatio * 100)}% of the original. A result of fewer than about ${config.shortResultTokens} tokens, roughly ${config.shortResultTokens * 4} characters, is already short: leave it as it is.`,
    "",
    "If a tool refuses an item, read why and do not repeat the same request.",
    `Entry ${cut} and every entry after it are the protected recent part. They cannot be compressed or removed, so do not ask for them.`,
    "</memory-maintenance>",
  ].join("\n");
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
    "The memory tools",
    ...how,
    "- jcm_journal({ id: number, text: string }) writes the text of one journal entry.",
    "- jcm_compress({ items: [{ id: number, text: string }, ...] }) marks tool results to be replaced by the given short text.",
    "- jcm_remove({ items: [{ id: number, reason: string }, ...] }) marks user messages or your own messages to leave the context.",
    "- jcm_cancel({ ids: [number, ...] }) withdraws a pending compression or removal.",
    "- jcm_recall({ id: number, after?: number }) returns what is behind an id: the journal entries a higher-rank journal entry was written from, the original entries of a rank 1 journal entry's span, or the original of one entry.",
    "Nothing these tools mark changes the context now. It is applied later, all at once.",
  ];
}
