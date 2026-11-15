import { configure, defineTask, LiveDoc, type ContextView, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { applyCompaction } from "./compaction.ts";
import type { MemoryConfig } from "./config.ts";
import { asConversationId, hasPending, LedgerDoc, NOTICE_KIND, ownLedger, spansWithoutJournal, type Ledger } from "./ledger.ts";
import { forkInstruction } from "./prompts.ts";
import { closeSpan, countActivity } from "./spans.ts";
import { contextTokens, cutPoint } from "./view.ts";

/** A fork run that has been active this long is taken for lost, and the next one may start. */
const RUN_STALE_MS = 30 * 60_000;

type ForkRunState = { phase: "start" } | { phase: "drive"; fork: number; cut: number };
type TimerState = { phase: "wait" } | { phase: "check"; armedFor: number };
type TickState = { phase: "run" };

const completed = { status: "terminal", outcome: { status: "completed", result: null } } as const;
const aborted = { status: "terminal", outcome: { status: "aborted" } } as const;

/** The durable tasks of the memory system. They are created by the end-of-run hook and by each other. */
export function memoryTasks(config: MemoryConfig) {
  /**
   * One fork run: fork the conversation, give the fork its instruction, and wait for it. The fork writes its
   * decisions to this conversation's ledger through the memory tools; nothing here changes the context.
   */
  const ForkRun = defineTask<Record<string, never>, ForkRunState, null>({
    name: "memory.fork-run",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, runtime, context) => {
        const conversationId = runtime.conversationId;
        const view = await runtime.context(conversationId, context);
        const cut = cutPoint(view, config.protectedTokens);
        await runtime.commit(async (tx) => {
          // A rerun after a restart finds the fork it already made.
          const existing = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
          if (existing !== undefined) return { status: "running", checkpoint: { phase: "drive", fork: existing.id, cut } };
          const at = await tx.latestEntryId(conversationId);
          if (at === undefined) {
            await endRun(tx, conversationId);
            return completed;
          }
          const fork = await tx.forkConversation(conversationId, at, { ownership: { kind: "task", taskId: task.id } });
          // The fork received a copy of the ledger. Marking the copy makes it a worker: its memory tools then use
          // this conversation's ledger, and it runs no memory system of its own.
          (await tx.doc(LedgerDoc, fork.id)).worker = { parent: conversationId, cut };
          await configure(tx, fork.id, { maxTurns: config.forkTurnLimit });
          return { status: "running", checkpoint: { phase: "drive", fork: fork.id, cut } };
        }, context);
      },
      drive: async (task, runtime, context) => {
        const conversationId = runtime.conversationId;
        const { fork, cut } = task.state.checkpoint;
        try {
          const ledger = await runtime.snapshot(LedgerDoc, conversationId, context);
          const handle = await runtime.conversation(asConversationId(fork), context);
          if (ledger !== undefined && handle !== undefined) {
            const submission = await handle.submit(
              { type: "input", content: forkInstruction(ledger as Ledger, config, cut), requestId: `memory.fork-run:${task.id}` },
              context,
            );
            await submission.wait(context);
          }
        } catch (error) {
          // A failed run changes nothing: what it wrote stays pending, and the spans it missed are picked up next time.
          runtime.report?.({ kind: "task_error", error });
        }
        await runtime.commit(async (tx) => {
          await endRun(tx, conversationId);
          return completed;
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const ledger = await tx.doc(LedgerDoc, runtime.conversationId);
        ledger.run.active = false;
        return aborted;
      }, context);
    },
  });

  /**
   * Mark the run as over and start the next one when a span closed in the meantime.
   *
   * A fork run's decisions are written in commits that add no entry to this conversation, and a fork receives the
   * ledger as it was at the commit of the entry it is made at. So a fork made right after a fork run does not get that
   * run's decisions. That is accepted: the fork's own fork runs decide them again.
   */
  async function endRun(tx: Tx, conversationId: ConversationId): Promise<void> {
    const ledger = await tx.doc(LedgerDoc, conversationId);
    const again = ledger.run.queued;
    ledger.run = { active: false, queued: false, startedAt: 0 };
    if (again) await requestRun(tx, conversationId, ledger, Date.now());
  }

  /** Start a fork run when a span waits for its journal entry. Only one runs at a time per conversation. */
  async function requestRun(tx: Tx, conversationId: ConversationId, ledger: Ledger, now: number): Promise<void> {
    if (spansWithoutJournal(ledger).length === 0) return;
    if (ledger.run.active && now - ledger.run.startedAt < RUN_STALE_MS) {
      ledger.run.queued = true;
      return;
    }
    ledger.run = { active: true, queued: false, startedAt: now };
    await tx.createTask(ForkRun, {}, { ownership: { kind: "conversation" }, conversationId, background: true });
  }

  /**
   * Everything that follows new activity, in one commit: count it, close the span when it is large enough (or when
   * `closeOpenSpan` asks for it), start a fork run, and run our compaction when its threshold is reached.
   */
  async function afterActivity(
    tx: Tx,
    conversationId: ConversationId,
    ledger: Ledger,
    view: ContextView,
    options: { now: number; closeOpenSpan: boolean; window: number | undefined },
  ): Promise<void> {
    await countActivity(tx, conversationId, ledger, options.now);
    if (ledger.open.tokens >= config.spanTokens || options.closeOpenSpan) await closeSpan(tx, conversationId, ledger, options.closeOpenSpan ? "silence" : "size", config.foldSize);
    await requestRun(tx, conversationId, ledger, options.now);

    const size = contextTokens(view);
    const limit = options.window === undefined ? undefined : options.window - config.reserveTokens;
    const overLimit = limit !== undefined && size > limit;
    if (!overLimit) ledger.overLimit = false;
    if (ledger.sinceCompaction < config.compactionTokens && !overLimit) return;
    const applied = hasPending(ledger) ? await applyCompaction(tx, conversationId, ledger, view) : undefined;
    // The only measure at the hard limit is to apply everything pending. When that is not enough, say so plainly.
    if (overLimit && applied === undefined && !ledger.overLimit) {
      ledger.overLimit = true;
      await tx.appendEntry(conversationId, {
        kind: NOTICE_KIND,
        data: {
          level: "error",
          message: `The context is about ${size} tokens, over the limit of ${limit} for this model, and nothing is pending that could shrink it. The next request may be rejected by the provider.`,
        },
      });
    }
  }

  /** The silence timer: when no activity arrives for `silenceMs`, the open span is closed. Activity restarts it. */
  const SilenceTimer = defineTask<Record<string, never>, TimerState, null>({
    name: "memory.silence-timer",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (_task, runtime, context) => {
        const ledger = await runtime.snapshot(LedgerDoc, runtime.conversationId, context);
        const last = ledger?.timer.last ?? runtime.now();
        await runtime.sleepUntil(last + config.silenceMs, { phase: "check", armedFor: last }, context);
      },
      check: async (task, runtime, context) => {
        const conversationId = runtime.conversationId;
        const view = await runtime.context(conversationId, context);
        await runtime.commit(async (tx) => {
          const ledger = await ownLedger(tx, conversationId);
          if (ledger === undefined) return completed;
          // Activity arrived while it slept: wait again from the new time.
          if (ledger.timer.last !== task.state.checkpoint.armedFor) return { status: "running", checkpoint: { phase: "wait" } };
          // A run in progress is not silence.
          if ((await tx.doc(LiveDoc, conversationId)).run !== undefined) {
            ledger.timer.last = runtime.now();
            return { status: "running", checkpoint: { phase: "wait" } };
          }
          ledger.timer.armed = false;
          await afterActivity(tx, conversationId, ledger, view, { now: runtime.now(), closeOpenSpan: true, window: undefined });
          return completed;
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(async (tx) => {
        (await tx.doc(LedgerDoc, runtime.conversationId)).timer.armed = false;
        return aborted;
      }, context);
    },
  });

  /** Runs at the end of every run of a conversation: the trigger for spans, fork runs and compactions. */
  const Tick = defineTask<Record<string, never>, TickState, null>({
    name: "memory.tick",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, context) => {
        const conversationId = runtime.conversationId;
        const view = await runtime.context(conversationId, context);
        const model = (await runtime.agent(context)).model;
        const window = model === undefined ? undefined : runtime.models.getModel(model.provider, model.modelId)?.contextWindow;
        await runtime.commit(async (tx) => {
          const ledger = await ownLedger(tx, conversationId);
          if (ledger === undefined) return completed;
          const now = runtime.now();
          await afterActivity(tx, conversationId, ledger, view, { now, closeOpenSpan: false, window });
          ledger.timer.last = now;
          if (!ledger.timer.armed) {
            ledger.timer.armed = true;
            await tx.createTask(SilenceTimer, {}, { ownership: { kind: "conversation" }, conversationId, background: true });
          }
          return completed;
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => aborted, context);
    },
  });

  return { ForkRun, SilenceTimer, Tick };
}
