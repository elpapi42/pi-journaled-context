import { defineDoc, type ConversationId, type EntryId, type Tx } from "@earendil-works/pi-durable";
import type { MemoryConfig } from "./config.ts";

/** Entry kinds this extension writes. None of them shows anything to the model by itself. */
export const SPAN_KIND = "memory.span";
export const FOLD_KIND = "memory.fold";
export const COMPACTION_KIND = "memory.compaction";
export const NOTICE_KIND = "memory.notice";
/** Written when a fork run ends. It gives the decisions of that run a place in the transcript, see `endRun()`. */
export const RUN_KIND = "memory.run";
export const isMemoryKind = (kind: string): boolean => kind.startsWith("memory.");

/** A closed span: a contiguous amount of activity. Its id is the id of its marker entry. */
export type Span = {
  id: number;
  /** First and last entry of the span. */
  first: number;
  last: number;
  /** Time range it covers, in milliseconds. */
  from: number;
  to: number;
  tokens: number;
};

/** One journal entry. Rank 1 covers one span; a higher rank covers journal entries of the rank below. */
export type JournalEntry = {
  /** Shown to the model. Rank 1: the span's marker entry. Higher ranks: the fold entry that recorded the fold. */
  id: number;
  /** The marker entry at whose position this journal entry is rendered. */
  anchor: number;
  rank: number;
  text: string;
  from: number;
  to: number;
  /** Ids of the journal entries it was folded from; empty at rank 1. */
  covers: number[];
  /** Whether a compaction has made it visible. */
  applied: boolean;
  /** Set once a journal entry of the next rank covers it. */
  foldedInto?: number;
};

export type PendingCompression = { text: string; applied: boolean };
export type PendingRemoval = { reason: string; applied: boolean };

/** Everything the memory system knows about one conversation. Stored as a conversation document. */
export type Ledger = {
  /** Present only on the copy a worker fork received: the conversation it works for, and its cut point. */
  worker?: { parent: number; cut: number };
  /** Newest entry already counted as activity. */
  counted: number;
  /** The span that is still open. */
  open: { first?: number; from?: number; to?: number; tokens: number };
  /** Activity added since the last compaction. */
  sinceCompaction: number;
  spans: Span[];
  journal: Record<string, JournalEntry>;
  compressions: Record<string, PendingCompression>;
  removals: Record<string, PendingRemoval>;
  /** The conversation this ledger belongs to. A copy received by a fork still names the conversation it came from. */
  self?: number;
  /** The fork run in progress, when it started, and whether another one is wanted when it ends. */
  run: { active: boolean; queued: boolean; startedAt: number };
  /** The silence timer. `last` is the time of the last activity. */
  timer: { armed: boolean; last: number };
  /** Set while the context is over the hard limit with nothing left to apply, so the notice is written once. */
  overLimit: boolean;
};

export const LedgerDoc = defineDoc<Ledger>({
  kind: "memory.ledger",
  version: 1,
  scope: "conversation",
  // A fork receives the ledger as it was at the fork point, which needs the history.
  history: "rewindable",
  fork: "asOf",
  initial: () => ({
    counted: 0,
    open: { tokens: 0 },
    sinceCompaction: 0,
    spans: [],
    journal: {},
    compressions: {},
    removals: {},
    run: { active: false, queued: false, startedAt: 0 },
    timer: { armed: false, last: 0 },
    overLimit: false,
  }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 64,
});

export const asEntryId = (id: number): EntryId => id as EntryId;
export const asConversationId = (id: number): ConversationId => id as ConversationId;

/**
 * The ledger a memory tool works on, and the conversation that owns it. A worker fork never uses the copy it
 * received: it reads and writes the ledger of the conversation it works for.
 */
export async function targetLedger(
  tx: Tx,
  conversationId: ConversationId,
): Promise<{ ledger: Ledger; owner: ConversationId; worker: Ledger["worker"] }> {
  const own = await tx.doc(LedgerDoc, conversationId);
  if (own.worker === undefined) return { ledger: own, owner: conversationId, worker: undefined };
  const owner = asConversationId(own.worker.parent);
  return { ledger: await tx.doc(LedgerDoc, owner), owner, worker: { ...own.worker } };
}

/**
 * The ledger of a conversation that runs the memory system for itself, or `undefined` for a worker fork. A fork made
 * by the user or by another extension received a copy; what only made sense while something was running in the
 * conversation it came from is reset the first time the copy is used.
 */
export async function ownLedger(tx: Tx, conversationId: ConversationId): Promise<Ledger | undefined> {
  const ledger = await tx.doc(LedgerDoc, conversationId);
  if (ledger.worker !== undefined) return undefined;
  if (ledger.self !== conversationId) {
    ledger.self = conversationId;
    ledger.run = { active: false, queued: false, startedAt: 0 };
    ledger.timer = { armed: false, last: 0 };
  }
  return ledger;
}

/** Journal entries of one rank that no higher rank covers yet, oldest first. */
export function liveEntries(ledger: Ledger, rank: number): JournalEntry[] {
  return Object.values(ledger.journal)
    .filter((entry) => entry.rank === rank && entry.foldedInto === undefined)
    .sort((a, b) => a.from - b.from || a.id - b.id);
}

/** The fold that is due, if any: the lowest rank over its limit, and its oldest journal entries. */
export function foldDue(ledger: Ledger, config: MemoryConfig): { rank: number; entries: JournalEntry[] } | undefined {
  const ranks = [...new Set(Object.values(ledger.journal).map((entry) => entry.rank))].sort((a, b) => a - b);
  for (const rank of ranks) {
    const live = liveEntries(ledger, rank);
    if (live.length > config.rankSize) return { rank, entries: live.slice(0, config.foldSize) };
  }
  return undefined;
}

/** Closed spans that have no journal entry yet, oldest first. */
export function spansWithoutJournal(ledger: Ledger): Span[] {
  return ledger.spans.filter((span) => ledger.journal[String(span.id)] === undefined);
}

/** Whether anything is waiting for the next compaction. */
export function hasPending(ledger: Ledger): boolean {
  return (
    Object.values(ledger.compressions).some((item) => !item.applied) ||
    Object.values(ledger.removals).some((item) => !item.applied) ||
    Object.values(ledger.journal).some((entry) => !entry.applied && entry.foldedInto === undefined)
  );
}
