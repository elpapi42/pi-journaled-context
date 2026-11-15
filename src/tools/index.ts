import type { MemoryConfig } from "../config.ts";
import { CANCEL_TOOL, cancelTool } from "./cancel.ts";
import { COMPRESS_TOOL, compressTool } from "./compress.ts";
import { JOURNAL_TOOL, journalTool } from "./journal.ts";
import { RECALL_TOOL, recallTool } from "./recall.ts";
import { REMOVE_TOOL, removeTool } from "./remove.ts";

/** Names of the tools a worker fork may call. Everything else is blocked there. */
export const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set([COMPRESS_TOOL, REMOVE_TOOL, CANCEL_TOOL, JOURNAL_TOOL, RECALL_TOOL]);

/**
 * The memory tools. With `codemodeOnly`, none is offered to the model directly: codemode scripts call them. The four
 * maintenance tools are also deferred, so codemode does not list them in its prompt section and only a fork run, which
 * is told about them in its instruction, knows they exist. Recall is the exception: the agent uses it in normal work.
 */
export function memoryTools(config: MemoryConfig) {
  const recall = recallTool(config);
  const maintenance = [compressTool(config), removeTool(config), cancelTool(), journalTool(config)];
  if (!config.codemodeOnly) return [...maintenance, recall];
  return [...maintenance.map((tool) => ({ ...scripted(tool), deferred: true as const })), scripted(recall)];
}

type AnyTool = ReturnType<typeof recallTool>;

/**
 * A tool as codemode scripts call it. In a script an error result rejects and ends the script, so a refusal is
 * returned as ordinary text there: the script goes on and the model reads why.
 */
function scripted<T extends { execute: AnyTool["execute"] }>(tool: T): T & { callers: readonly ["tools"] } {
  return {
    ...tool,
    callers: ["tools"] as const,
    execute: async (...args: Parameters<AnyTool["execute"]>) => {
      const { isError: _refused, ...result } = await tool.execute(...args);
      return result;
    },
  };
}
