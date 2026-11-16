import assert from "node:assert/strict";
import { test } from "node:test";
import { LedgerDoc } from "../src/index.ts";
import { ctx, scriptedModel, setup, textOf, type ForkScript } from "./helpers.ts";

// The compaction threshold is out of reach, so what a fork run decides stays pending across runs.
const SMALL = { spanTokens: 600, protectedTokens: 300, compactionTokens: 1_000_000, journalEntryTokens: 120 };

/** A fork that journals what it is asked for and, in its first run only, removes its oldest step: one of its own messages with a tool call. */
const removesOneStep: ForkScript = (messages, instruction) => {
  const cut = Number(/id lower than (\d+)/.exec(instruction)?.[1]);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  for (const match of instruction.matchAll(/^- journal entry (\d+), rank \d+:/gm)) {
    calls.push({ name: "jcm_journal", args: { id: Number(match[1]), text: "The user asked for lookups and I ran them." } });
  }
  if (!instruction.includes("- Removals: none.")) return calls;
  const header = messages.map(textOf).map((text) => /^<entry id="(\d+)" at="[^"]+" after="(\d+)"/.exec(text)).find((match) => match !== null && Number(match[1]) < cut);
  if (header) calls.push({ name: "jcm_remove", args: { items: [{ id: Number(header[2]), reason: "the lookup is done and reported" }] } });
  return calls;
};

const instructions = (requests: Parameters<typeof textOf>[0][][]) => [...new Set(requests.flat().map(textOf).filter((text) => text.includes("<memory-maintenance>")))];

test("a fork run is told which tool results leave with each pending removal", async () => {
  const t = await setup(SMALL, scriptedModel(removesOneStep));
  try {
    await t.say("lookup alpha");
    await t.say("lookup beta");
    await t.settle();
    const [step, removal] = Object.entries((await t.ledger()).removals)[0]!;
    assert.equal(removal.results?.length, 1, "the removal of a step records the result of its tool call");
    const result = removal.results![0]!;
    assert.match(instructions(t.requests)[0]!, /- Removals: none\./, "the first run has nothing pending");

    await t.say("lookup gamma");
    await t.say("lookup delta");
    await t.settle();
    const second = instructions(t.requests)[1]!;
    assert.ok(second.includes(`- Removals: ${step} (results ${result}). When one of your messages is removed, the results of its tool calls leave with it`), second.split("\n").find((line) => line.startsWith("- Removals")));
    assert.match(second, /- Compressions, by the id of the tool result: none\./);
  } finally {
    await t.close();
  }
});

test("a pending removal recorded before results were kept gets them before the next fork run", async () => {
  const t = await setup(SMALL, scriptedModel(removesOneStep));
  try {
    await t.say("lookup alpha");
    await t.say("lookup beta");
    await t.settle();
    const [step, removal] = Object.entries((await t.ledger()).removals)[0]!;
    const result = removal.results![0]!;
    // As an earlier version of the extension left it.
    await t.root.commit(async (tx) => {
      delete (await tx.doc(LedgerDoc, t.root.id)).removals[step]!.results;
    }, ctx);
    assert.equal((await t.ledger()).removals[step]!.results, undefined);

    await t.say("lookup gamma");
    await t.say("lookup delta");
    await t.settle();
    assert.deepEqual((await t.ledger()).removals[step]!.results, [result]);
    assert.ok(instructions(t.requests)[1]!.includes(`- Removals: ${step} (results ${result}).`));
  } finally {
    await t.close();
  }
});
