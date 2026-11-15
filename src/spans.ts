import type { ConversationId, Cursor, EntryRecord, Tx } from "@earendil-works/pi-durable";
import { asEntryId, isMemoryKind, SPAN_KIND, type Ledger, type Span } from "./ledger.ts";
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
export async function closeSpan(tx: Tx, owner: ConversationId, ledger: Ledger, closedBy: "size" | "silence"): Promise<Span | undefined> {
  const { first, from, to, tokens } = ledger.open;
  if (first === undefined || from === undefined || tokens <= 0) return undefined;
  const fields = { first, last: ledger.counted, from, to: to ?? from, tokens };
  const marker = await tx.appendEntry(owner, { kind: SPAN_KIND, data: { rank: 1, closedBy, ...fields } });
  const span: Span = { id: marker.id, ...fields };
  ledger.spans.push(span);
  ledger.open = { tokens: 0 };
  return span;
}
