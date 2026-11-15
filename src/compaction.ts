import type { ContextEdit, ContextView, ConversationId, Tx } from "@earendil-works/pi-durable";
import { asEntryId, COMPACTION_KIND, type JournalEntry, type Ledger } from "./ledger.ts";
import { journalMessage } from "./render.ts";
import { isVisible, resultsOf, toolResultMessage } from "./view.ts";

/** What one compaction applied, stored on its entry for inspection. */
export type CompactionSummary = { compressed: number[]; removed: number[]; journal: number[] };

/**
 * Turn everything pending in the ledger into context edits and mark it applied. It calls no model: every text was
 * written beforehand by a fork run. Items whose target is no longer in the context are dropped from the ledger.
 */
export function buildEdits(ledger: Ledger, view: ContextView): { edits: ContextEdit[]; summary: CompactionSummary } {
  const edits: ContextEdit[] = [];
  const summary: CompactionSummary = { compressed: [], removed: [], journal: [] };
  const entryById = new Map(view.entries.map((entry) => [entry.id as number, entry]));

  // Removals first: a result that leaves with its entry needs no compression.
  const leaving = new Set<number>();
  for (const [key, removal] of Object.entries(ledger.removals)) {
    const id = Number(key);
    const entry = entryById.get(id);
    if (removal.applied) continue;
    if (entry !== undefined && isVisible(view, id)) {
      // Pi Durable drops the tool results of an omitted assistant entry, so one edit removes the whole step.
      edits.push({ target: asEntryId(id), action: "omit" });
      summary.removed.push(id);
      leaving.add(id);
      for (const result of resultsOf(view, entry)) {
        leaving.add(result.id);
        delete ledger.compressions[String(result.id)];
      }
      // Only the fact that it left is kept, so a later request for the same entry can be answered.
      ledger.removals[key] = { reason: "", applied: true };
    } else {
      delete ledger.removals[key];
    }
  }

  for (const [key, compression] of Object.entries(ledger.compressions)) {
    if (compression.applied) continue;
    const id = Number(key);
    const original = entryById.get(id);
    const message = original === undefined ? undefined : toolResultMessage(original);
    if (message === undefined || !isVisible(view, id) || leaving.has(id)) {
      delete ledger.compressions[key];
      continue;
    }
    edits.push({ target: asEntryId(id), action: "replace", messages: [{ ...message, content: [{ type: "text", text: compression.text }] }] });
    summary.compressed.push(id);
    // The text now lives in the compaction entry; the ledger only remembers that the result is compressed.
    ledger.compressions[key] = { text: "", applied: true };
  }

  // Journal entries, lowest rank first, so a fold is applied after the entries it covers were considered.
  const pending = Object.values(ledger.journal)
    .filter((entry) => !entry.applied && entry.foldedInto === undefined)
    .sort((a, b) => a.rank - b.rank || a.from - b.from);
  for (const entry of pending) {
    for (const anchor of visibleAnchors(ledger, entry)) {
      if (anchor !== entry.anchor) edits.push({ target: asEntryId(anchor), action: "omit" });
    }
    // The newest edit on a target wins, so this also replaces what the last covered journal entry showed there.
    edits.push({ target: asEntryId(entry.anchor), action: "replace", messages: [journalMessage(entry)] });
    entry.applied = true;
    summary.journal.push(entry.id);
  }
  return { edits, summary };
}

/** Anchors under a journal entry that currently show something: its own once applied, else those of what it covers. */
function visibleAnchors(ledger: Ledger, entry: JournalEntry): number[] {
  return entry.covers.flatMap((id) => {
    const covered = ledger.journal[String(id)];
    if (covered === undefined) return [];
    return covered.applied ? [covered.anchor] : visibleAnchors(ledger, covered);
  });
}

/**
 * Our compaction: apply everything pending as one entry of edits, in the caller's commit. Returns what was applied,
 * or `undefined` when nothing was pending.
 */
export async function applyCompaction(
  tx: Tx,
  owner: ConversationId,
  ledger: Ledger,
  view: ContextView,
): Promise<CompactionSummary | undefined> {
  const { edits, summary } = buildEdits(ledger, view);
  if (edits.length === 0) return undefined;
  await tx.appendEntry(owner, { kind: COMPACTION_KIND, data: summary, edits });
  ledger.sinceCompaction = 0;
  ledger.overLimit = false;
  return summary;
}
