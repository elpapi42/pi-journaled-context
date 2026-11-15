import type { MemoryConfig } from "../config.ts";
import { CANCEL_TOOL, cancelTool } from "./cancel.ts";
import { COMPRESS_TOOL, compressTool } from "./compress.ts";
import { FOLD_TOOL, foldTool, JOURNAL_TOOL, journalTool } from "./journal.ts";
import { RECALL_TOOL, recallTool } from "./recall.ts";
import { REMOVE_TOOL, removeTool } from "./remove.ts";

/** Names of the tools a worker fork may call. Everything else is blocked there. */
export const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set([COMPRESS_TOOL, REMOVE_TOOL, CANCEL_TOOL, JOURNAL_TOOL, FOLD_TOOL, RECALL_TOOL]);

export function memoryTools(config: MemoryConfig) {
  return [compressTool(config), removeTool(config), cancelTool(), journalTool(config), foldTool(config), recallTool(config)];
}
