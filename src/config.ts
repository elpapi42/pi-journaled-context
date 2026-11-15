import { existsSync, readFileSync } from "node:fs";

/** Every tunable of the memory system. Token counts are estimates, as pi-ai estimates them. */
export type MemoryConfig = {
  /** Most recent context that is never a candidate for compression or removal. */
  protectedTokens: number;
  /** New activity that closes a span and starts a fork run. */
  spanTokens: number;
  /** New activity since the last compaction that triggers the next one. */
  compactionTokens: number;
  /** Room kept free below the model's context window. */
  reserveTokens: number;
  /** Ceiling of one journal entry, at any rank. */
  journalEntryTokens: number;
  /** Ceiling of one compressed tool result. */
  compressedTextTokens: number;
  /** A compressed text may be at most this share of the original. */
  compressedTextRatio: number;
  /** Most journal entries one rank may hold. */
  rankSize: number;
  /** How many of a rank's oldest journal entries fold into one of the next rank. */
  foldSize: number;
  /** Most raw history one recall answer returns. */
  recallPageTokens: number;
  /** Turns a fork run may take. */
  forkTurnLimit: number;
  /** Silence that closes an open span. */
  silenceMs: number;
  /**
   * Offer the memory tools only to codemode scripts, not to the model directly. For setups where every tool is
   * reached through codemode.
   */
  codemodeOnly: boolean;
};

export const DEFAULT_CONFIG: MemoryConfig = {
  protectedTokens: 20_000,
  spanTokens: 20_000,
  compactionTokens: 80_000,
  reserveTokens: 16_384,
  journalEntryTokens: 300,
  compressedTextTokens: 300,
  compressedTextRatio: 0.5,
  rankSize: 30,
  foldSize: 10,
  recallPageTokens: 20_000,
  forkTurnLimit: 16,
  silenceMs: 3 * 60_000,
  codemodeOnly: false,
};

/** `overrides` over the defaults. A value of the wrong type, or a number that is not positive and finite, is ignored. */
export function resolveConfig(overrides: Partial<Record<keyof MemoryConfig, unknown>> = {}): MemoryConfig {
  const config: MemoryConfig = { ...DEFAULT_CONFIG };
  const numbers = config as unknown as Record<string, number | boolean>;
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof MemoryConfig)[]) {
    const value = overrides[key];
    if (typeof DEFAULT_CONFIG[key] === "boolean") {
      if (typeof value === "boolean") numbers[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      numbers[key] = value;
    }
  }
  // A fold must leave the rank at or under its limit, and must fold at least two entries.
  config.foldSize = Math.max(2, Math.min(Math.floor(config.foldSize), Math.floor(config.rankSize)));
  config.compressedTextRatio = Math.min(config.compressedTextRatio, 1);
  return config;
}

/** Read the optional settings file, `<workspace>/.hpi/memory.json`. A missing or unreadable file gives the defaults. */
export function loadConfig(file: string): MemoryConfig {
  if (!existsSync(file)) return resolveConfig();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return resolveConfig(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {});
  } catch {
    return resolveConfig();
  }
}
