import type { ConversationId, Cursor, EntryRecord, Tx } from "@earendil-works/pi-durable";
import { asEntryId, FOLD_KIND, isMemoryKind, SPAN_KIND, type Ledger, type Span } from "./ledger.ts";
import { entryTokens } from "./tokens.ts";
import { entryRole } from "./view.ts";

/**
 * Count the entries added since the last count into the open span and into the activity since the last compaction.
 * Only what the user, the assistant and the tools produced counts; this extension's own entries do not.
 */
export async function countActivity(tx: Tx, owner: ConversationId, ledger: Ledger, now: number): Promise<void> {
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: owner, minEntryId: asEntryId(ledger.counted + 1), order: "ascending" }, 200, cursor);
    for (const entry of page.items) {
      ledger.counted = Math.max(ledger.counted, entry.id);
      if (isMemoryKind(entry.kind) || entryRole(entry) === "other") continue;
      const tokens = entryTokens(entry);
      if (tokens === 0) continue;
      const at = entryTime(entry) ?? now;
      ledger.open.first ??= entry.id;
      ledger.open.from ??= at;
      ledger.open.to = at;
      ledger.open.tokens += tokens;
      ledger.sinceCompaction += tokens;
    }
    cursor = page.next;
  } while (cursor !== undefined);
}

function entryTime(entry: EntryRecord): number | undefined {
  return entry.model?.[0]?.timestamp;
}

/**
 * Close the open span: append its empty marker entry, whose id becomes the id of the span and of its rank 1 journal
 * entry. A span with no activity is never closed. Returns the span, or `undefined` when there was nothing to close.
 */
export async function closeSpan(tx: Tx, owner: ConversationId, ledger: Ledger, closedBy: "size" | "silence", foldSize: number): Promise<Span | undefined> {
  const { first, from, to, tokens } = ledger.open;
  if (first === undefined || from === undefined || tokens <= 0) return undefined;
  const fields = { first, last: ledger.counted, from, to: to ?? from, tokens };
  const marker = await tx.appendEntry(owner, { kind: SPAN_KIND, data: { rank: 1, closedBy, ...fields } });
  const span: Span = { id: marker.id, ...fields };
  ledger.spans.push(span);
  ledger.open = { tokens: 0 };
  await reserveSlots(tx, owner, ledger, span.id, foldSize);
  return span;
}

/**
 * Reserve the place of the coarser journal entry as soon as a rank has collected `foldSize` new ones: an empty entry
 * right after them. It is written into only when the rank overflows, but its position and its id are fixed now, in
 * time order with everything else. A new slot counts toward the rank above, which can complete a slot there too.
 */
async function reserveSlots(tx: Tx, owner: ConversationId, ledger: Ledger, spanId: number, foldSize: number): Promise<void> {
  let id = spanId;
  for (let rank = 1; ; rank++) {
    // A new list is assigned each time: a change to an array that was just put into the document is not tracked.
    const covers = [...(ledger.ungrouped[String(rank)] ?? []), id];
    if (covers.length < foldSize) {
      ledger.ungrouped[String(rank)] = covers;
      return;
    }
    const slot = await tx.appendEntry(owner, { kind: FOLD_KIND, data: { rank: rank + 1, covers } });
    ledger.slots.push({ id: slot.id, rank: rank + 1, covers });
    ledger.ungrouped[String(rank)] = [];
    id = slot.id;
  }
}
