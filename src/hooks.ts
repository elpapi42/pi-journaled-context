import type { Message } from "@earendil-works/pi-ai";
import { CompactionTask, GenerationTask, hook, runEndTask, ToolTask, type ContextView, type EntryRecord, type HookApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { LedgerDoc, type Ledger } from "./ledger.ts";
import { withHeaders } from "./render.ts";
import type { memoryTasks } from "./tasks.ts";
import { MEMORY_TOOL_NAMES } from "./tools/index.ts";

/** The tool a model calls to run a codemode script. Scripts run by a worker fork may only reach the memory tools. */
const CODEMODE_TOOL = "codemode";

/**
 * The context the request was built from. In Pi Durable 1.5 the object a hook receives is the task's runtime, which
 * has `context()`, but the documented hook interface does not list it. When it is missing, the same mapping is built
 * from the raw history, which the interface does offer.
 */
async function requestView(api: HookApi, context: Context): Promise<Pick<ContextView, "entries" | "contributions">> {
  const runtime = api as HookApi & { context?: (id: HookApi["conversationId"], context: Context) => Promise<ContextView> };
  if (typeof runtime.context === "function") return runtime.context(api.conversationId, context);
  const entries: EntryRecord[] = [];
  let cursor;
  do {
    const page = await api.entries({ order: "ascending" }, 500, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return { entries, contributions: entries.map((entry): readonly Message[] => entry.model ?? []) };
}

async function ledgerOf(api: HookApi, context: Context): Promise<Ledger | undefined> {
  return (await api.snapshot(LedgerDoc, api.conversationId, context)) as Ledger | undefined;
}

export function memoryHooks(tasks: ReturnType<typeof memoryTasks>) {
  return [
    hook(GenerationTask, {
      // Headers are added to every request from the committed context, so the same entries always render the same.
      beforeRequest: async (request, api, context) => {
        const [view, ledger] = await Promise.all([requestView(api, context), ledgerOf(api, context)]);
        return { messages: withHeaders(request.messages, view as ContextView, ledger) };
      },
      // The end of a run is where spans close, fork runs start and compactions apply. A worker fork runs none of it.
      afterRun: async (_run, api, context) => {
        if ((await ledgerOf(api, context))?.worker !== undefined) return undefined;
        return { tasks: [runEndTask(tasks.Tick, {})] };
      },
    }),
    // Pi Durable's own compaction would replace the old part with one summary. Ours applies prepared edits instead.
    hook(CompactionTask, { beforeCompact: () => ({ decline: true as const }) }),
    hook(ToolTask, {
      // A worker fork is a copy of the agent with all of its tools. It must not act on the world.
      beforeTool: async (call, api, context) => {
        if ((await ledgerOf(api, context))?.worker === undefined) return undefined;
        if (MEMORY_TOOL_NAMES.has(call.name)) return undefined;
        if (call.name === CODEMODE_TOOL && call.parent === undefined) return undefined;
        return { block: `This is a memory maintenance run. Only the memory tools are available here; "${call.name}" was not run.` };
      },
    }),
  ];
}
