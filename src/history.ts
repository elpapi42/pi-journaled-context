import type { ConversationId, EntryRecord, Tx } from "@earendil-works/pi-durable";
import { asEntryId } from "./ledger.ts";
import { entryTokens } from "./tokens.ts";
import { toolCalls, toolResultMessage } from "./view.ts";

/**
 * Reads of a conversation's raw history inside a commit. Tools have no context view, so they answer their questions
 * from the original entries and from the ledger.
 */

/** One entry of the conversation's history, or `undefined` when it has none with that id. */
export async function findEntry(tx: Tx, owner: ConversationId, id: number): Promise<EntryRecord | undefined> {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  const page = await tx.scanEntries({ conversationId: owner, minEntryId: asEntryId(id), maxEntryId: asEntryId(id) }, 1);
  return page.items[0];
}

/** Entries of an inclusive id range, oldest first. */
export async function entriesBetween(tx: Tx, owner: ConversationId, first: number, last: number, limit = 100_000): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  if (last < first) return entries;
  let cursor;
  do {
    const page = await tx.scanEntries({ conversationId: owner, minEntryId: asEntryId(first), maxEntryId: asEntryId(last), order: "ascending" }, 200, cursor);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined && entries.length < limit);
  return entries;
}

/** The assistant entry whose tool call a result answers. */
export async function ownerOfResult(tx: Tx, owner: ConversationId, result: EntryRecord): Promise<EntryRecord | undefined> {
  const callId = toolResultMessage(result)?.toolCallId;
  if (callId === undefined || result.id <= 1) return undefined;
  let cursor;
  let scanned = 0;
  do {
    const page = await tx.scanEntries({ conversationId: owner, maxEntryId: asEntryId(result.id - 1), order: "descending" }, 100, cursor);
    for (const entry of page.items) if (toolCalls(entry).some((call) => call.id === callId)) return entry;
    scanned += page.items.length;
    cursor = page.next;
  } while (cursor !== undefined && scanned < 2000);
  return undefined;
}

/** The result entries of an assistant entry's tool calls. Results follow their entry, before the next assistant entry. */
export async function resultsOfEntry(tx: Tx, owner: ConversationId, assistant: EntryRecord): Promise<EntryRecord[]> {
  const callIds = new Set(toolCalls(assistant).map((call) => call.id));
  const results: EntryRecord[] = [];
  if (callIds.size === 0) return results;
  let cursor;
  do {
    const page = await tx.scanEntries({ conversationId: owner, minEntryId: asEntryId(assistant.id + 1), order: "ascending" }, 200, cursor);
    for (const entry of page.items) {
      const callId = toolResultMessage(entry)?.toolCallId;
      if (callId !== undefined && callIds.has(callId)) results.push(entry);
    }
    cursor = results.length >= callIds.size ? undefined : page.next;
  } while (cursor !== undefined);
  return results;
}

/**
 * The cut point from raw history, for a conversation that uses the memory tools itself. It counts the original size
 * of each entry, which is what the recent part holds.
 */
export async function cutFromHistory(tx: Tx, owner: ConversationId, protectedTokens: number): Promise<number> {
  let kept = 0;
  let oldest = 0;
  let cursor;
  do {
    const page = await tx.scanEntries({ conversationId: owner, order: "descending" }, 200, cursor);
    for (const entry of page.items) {
      oldest = entry.id;
      kept += entryTokens(entry);
      if (kept >= protectedTokens) return entry.id;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return oldest;
}
