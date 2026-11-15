import { defineExtension } from "@earendil-works/pi-durable";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveConfig, type MemoryConfig } from "./config.ts";
import { memoryHooks } from "./hooks.ts";
import { memoryTasks } from "./tasks.ts";
import { memoryTools } from "./tools/index.ts";

export { DEFAULT_CONFIG, resolveConfig, type MemoryConfig } from "./config.ts";
export { LedgerDoc, type Ledger } from "./ledger.ts";

/** The name conversations select the extension by. */
export const EXTENSION_NAME = "pi-journaled-context";

/**
 * Journaled Context Memory: short-term memory for Pi Durable. Fork runs decide in the background what to compress, what to remove and what to
 * write in the journal; a compaction of our own applies those decisions as context edits, without calling a model.
 *
 * The extension adds nothing to the system prompt. The agent learns about recall from that tool's description, and
 * only a fork run is told about the other tools, in its instruction.
 */
export function createMemoryExtension(overrides: Partial<MemoryConfig> = {}) {
  const config = resolveConfig(overrides);
  const tasks = memoryTasks(config);
  return defineExtension({
    name: EXTENSION_NAME,
    tools: memoryTools(config),
    tasks: [tasks.Tick, tasks.SilenceTimer, tasks.ForkRun],
    hooks: memoryHooks(tasks),
  });
}

/** As Headless Pi loads it: settings come from `<workspace>/.hpi/pi-journaled-context.json`, three folders above this one. */
export default createMemoryExtension(loadConfig(fileURLToPath(new URL(`../../../${EXTENSION_NAME}.json`, import.meta.url))));
