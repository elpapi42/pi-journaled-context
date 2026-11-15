import type { ConversationId, EntryRecord, Tx } from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";
import type { MemoryConfig } from "../config.ts";
import { entriesBetween, findEntry, ownerOfResult } from "../history.ts";
import { isMemoryKind, targetLedger, type JournalEntry, type Ledger } from "../ledger.ts";
import { TOOL_DESCRIPTIONS } from "../prompts.ts";
import { entryHeader, journalText } from "../render.ts";
import { textTokens } from "../tokens.ts";
import { assistantMessage, entryRole, toolResultMessage } from "../view.ts";
import { answer, idParameter, parameters, refuse, toId } from "./shared.ts";

export const RECALL_TOOL = "memory_recall";

/** One original entry as readable text, with the same header the context would give it. */
async function renderEntry(tx: Tx, owner: ConversationId, entry: EntryRecord): Promise<string | undefined> {
  const first = entry.model?.[0];
  if (first === undefined || isMemoryKind(entry.kind)) return undefined;
  if (first.role === "user") {
    const body = typeof first.content === "string" ? first.content : first.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
    return `${entryHeader({ id: entry.id, at: first.timestamp })}\n[user]\n${body}`;
  }
  const assistant = assistantMessage(entry);
  if (assistant !== undefined) {
    const lines = [`[your message ${entry.id}]`];
    for (const part of assistant.content) {
      if (part.type === "text" && part.text.trim() !== "") lines.push(part.text);
      if (part.type === "toolCall") lines.push(`[tool call] ${part.name}(${JSON.stringify(part.arguments)})`);
    }
    return lines.length > 1 ? lines.join("\n") : undefined;
  }
  const result = toolResultMessage(entry);
  if (result !== undefined) {
    const step = await ownerOfResult(tx, owner, entry);
    const body = result.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
    return `${entryHeader({ id: entry.id, at: result.timestamp, ...(step === undefined ? {} : { after: step.id }) })}\n[tool result: ${result.toolName}]\n${body}`;
  }
  return undefined;
}

function describeCovered(ledger: Ledger, entry: JournalEntry): string {
  const covered = entry.covers.map((id) => ledger.journal[String(id)]).filter((item): item is JournalEntry => item !== undefined);
  return (
    `Journal entry ${entry.id} (rank ${entry.rank}) was written from these ${covered.length} journal entries of rank ${entry.rank - 1}. Call memory_recall with one of their ids to go further down.\n\n` +
    covered.map(journalText).join("\n\n")
  );
}

/** The raw entries of a span, in order, up to one page. `after` continues behind that entry. */
async function describeSpan(tx: Tx, owner: ConversationId, ledger: Ledger, entry: JournalEntry, after: number | undefined, config: MemoryConfig): Promise<string> {
  const span = ledger.spans.find((candidate) => candidate.id === entry.id);
  if (span === undefined) return `The span of journal entry ${entry.id} is not on record.`;
  const first = after === undefined ? span.first : Math.max(span.first, after + 1);
  const entries = await entriesBetween(tx, owner, first, span.last);
  const parts: string[] = [];
  let used = 0;
  let lastId: number | undefined;
  let more = false;
  for (const candidate of entries) {
    const text = await renderEntry(tx, owner, candidate);
    if (text === undefined) continue;
    const size = textTokens(text);
    // A page always holds at least one entry, so one very large entry cannot stall the reading.
    if (parts.length > 0 && used + size > config.recallPageTokens) {
      more = true;
      break;
    }
    parts.push(text);
    used += size;
    lastId = candidate.id;
  }
  if (parts.length === 0) return `Span ${entry.id} has no more entries${after === undefined ? "" : ` after ${after}`}.`;
  const head = `Original entries of span ${entry.id} (entries ${span.first} to ${span.last})${after === undefined ? "" : `, continuing after ${after}`}:`;
  const tail = more ? `\n\nThe span continues. Call memory_recall with id ${entry.id} and after ${lastId} for the next page.` : `\n\nEnd of span ${entry.id}.`;
  return `${head}\n\n${parts.join("\n\n")}${tail}`;
}

export function recallTool(config: MemoryConfig) {
  return defineTool({
    name: RECALL_TOOL,
    description: TOOL_DESCRIPTIONS.recall,
    parameters: parameters(
      {
        id: idParameter("Id of a journal entry, of a compressed tool result, or of any other entry."),
        after: idParameter("Only for a rank 1 journal entry: continue after this entry id."),
      },
      ["after"],
    ),
    replay: "safe",
    execute: async (args, api, context) => {
      const id = toId((args as { id: unknown }).id);
      const afterArg = (args as { after?: unknown }).after;
      const after = afterArg === undefined || afterArg === null ? undefined : toId(afterArg);
      if (Number.isNaN(id)) return refuse("`id` must be a number: the id of a journal entry or of an entry.");
      if (after !== undefined && Number.isNaN(after)) return refuse("`after` must be the entry id the previous page ended on.");
      return api.commit(async (tx) => {
        const { ledger, owner } = await targetLedger(tx, api.conversationId);
        const journal = ledger.journal[String(id)];
        if (journal !== undefined) {
          return answer(journal.rank > 1 ? describeCovered(ledger, journal) : await describeSpan(tx, owner, ledger, journal, after, config));
        }
        const entry = await findEntry(tx, owner, id);
        if (entry === undefined) return refuse(`There is no journal entry or entry with id ${id} in this conversation.`);
        if (entryRole(entry) === "other") {
          const span = ledger.spans.find((candidate) => candidate.id === id);
          return refuse(span === undefined ? `Entry ${id} holds nothing to recall.` : `Span ${id} has no journal entry yet, so there is nothing to recall through it.`);
        }
        const text = await renderEntry(tx, owner, entry);
        return text === undefined ? refuse(`Entry ${id} holds nothing to recall.`) : answer(`Original of entry ${id}:\n\n${text}`);
      }, context);
    },
  });
}
