import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { scriptedModel, setup, sleep, textOf, type ForkScript } from "./helpers.ts";

/** A fork that only writes the journal entry of each span it is asked for. */
const journalOnly: ForkScript = (_messages, instruction) =>
  [...instruction.matchAll(/^- span (\d+):/gm)].map((match) => ({
    name: "memory_journal",
    args: { span: Number(match[1]), text: `Span ${match[1]}: the user asked for a lookup and I ran it [${match[1]}].` },
  }));

const lastResult = (requests: Message[][]) => {
  const results = requests[requests.length - 1]!.filter((message) => message.role === "toolResult");
  return textOf(results[results.length - 1]!);
};

test("a rank over its limit folds into the next rank, and recall walks back down to the raw entries", async () => {
  // Every lookup closes a span, a rank holds two journal entries, and every end of run applies what is pending.
  const t = await setup({ spanTokens: 300, protectedTokens: 200, compactionTokens: 300, rankSize: 2, foldSize: 2, recallPageTokens: 250 }, scriptedModel(journalOnly));
  try {
    // The third span pushes rank 1 over its limit, and its fork run writes the fold. The fourth run's end applies it.
    for (const topic of ["alpha", "beta", "gamma", "delta"]) {
      await t.say(`lookup ${topic}`);
      await t.settle();
    }
    const ledger = await t.ledger();
    const [first, second, third] = ledger.spans;
    const ranks = Object.values(ledger.journal).map((entry) => `${entry.rank}:${entry.foldedInto === undefined ? "live" : "folded"}`).sort();
    assert.deepEqual(ranks, ["1:folded", "1:folded", "1:live", "1:live", "2:live"], "the two oldest journal entries folded into one of rank 2");
    const folded = Object.values(ledger.journal).find((entry) => entry.rank === 2)!;
    assert.deepEqual(folded.covers, [first!.id, second!.id]);
    assert.equal(folded.anchor, second!.id, "it is rendered where the newest one it covers was");
    assert.notEqual(folded.id, second!.id, "and it has an id of its own");
    assert.ok((await t.entries()).some((entry) => entry.kind === "memory.fold" && entry.id === folded.id));

    const journals = (await t.context()).filter((line) => line.startsWith("user: <journal"));
    assert.equal(journals.length, 2, "one journal entry of rank 2 and one of rank 1 are visible");
    assert.match(journals[0]!, new RegExp(`^user: <journal id="${folded.id}" from="[^"]+" to="[^"]+" rank="2">`));
    assert.match(journals[1]!, new RegExp(`^user: <journal id="${third!.id}" from="[^"]+" to="[^"]+" rank="1">`));

    // Recall on rank 2 returns the journal entries it was written from.
    await t.say(`call memory_recall {"id": ${folded.id}}`);
    const down = lastResult(t.requests);
    assert.match(down, new RegExp(`was written from these 2 journal entries of rank 1`));
    assert.ok(down.includes(`<journal id="${first!.id}"`) && down.includes(`<journal id="${second!.id}"`));

    // Recall on rank 1 returns the raw span, one page at a time.
    await t.say(`call memory_recall {"id": ${first!.id}}`);
    const page = lastResult(t.requests);
    assert.match(page, new RegExp(`Original entries of span ${first!.id}`));
    assert.ok(page.includes("[user]\nlookup alpha"), "the user's words, as they were");
    const next = /Call memory_recall with id \d+ and after (\d+) for the next page/.exec(page);
    assert.ok(next, "the span is larger than a page, so the answer says how to continue");
    await t.say(`call memory_recall {"id": ${first!.id}, "after": ${next![1]}}`);
    const rest = lastResult(t.requests);
    assert.match(rest, new RegExp(`continuing after ${next![1]}`));
    assert.ok(rest.includes("[tool result: lookup]\nFact 1 about alpha") || rest.includes("Fact 1 about alpha"), "the original tool result is in a later page");
  } finally {
    await t.close();
  }
});

test("silence closes the open span, and activity restarts the timer", async () => {
  const t = await setup({ spanTokens: 100_000, protectedTokens: 200, compactionTokens: 100_000, silenceMs: 300 }, scriptedModel(journalOnly));
  try {
    await t.say("lookup alpha");
    await sleep(150);
    await t.say("lookup beta");
    await sleep(200);
    assert.equal((await t.ledger()).spans.length, 0, "350 ms after the first run, but only 200 ms after the second: not silent yet");
    await sleep(350);
    await t.settle();
    const ledger = await t.ledger();
    assert.equal(ledger.spans.length, 1, "the span closed on silence, far below the span size");
    assert.equal(ledger.timer.armed, false);
    assert.equal(ledger.journal[String(ledger.spans[0]!.id)]?.rank, 1, "and its fork run wrote the journal entry");
  } finally {
    await t.close();
  }
});

test("a fork made by the user gets its own copy of the ledger and runs the memory system for itself", async () => {
  const t = await setup({ spanTokens: 300, protectedTokens: 200, compactionTokens: 100_000 }, scriptedModel(journalOnly));
  try {
    await t.say("lookup alpha");
    await t.settle();
    const parent = await t.ledger();
    assert.equal(parent.spans.length, 1);
    const { ctx } = await import("./helpers.ts");
    const last = (await t.entries()).at(-1)!;
    const fork = await t.root.fork(last.id, { ownership: { kind: "ownerless" } }, ctx);
    const copy = await t.ledger(fork);
    assert.equal(copy.worker, undefined, "it is not a worker fork");
    assert.deepEqual(copy.spans, parent.spans, "it received the spans as they were at the fork point");
    assert.deepEqual(Object.keys(copy.journal), Object.keys(parent.journal), "and the pending journal entries");

    // The fork keeps working on its own: a new span there does not touch the parent.
    await (await fork.submit({ type: "input", content: "lookup beta" }, ctx)).wait(ctx);
    for (let i = 0; i < 100 && ((await t.ledger(fork)).spans.length < 2 || (await t.ledger(fork)).run.active); i++) await sleep(20);
    assert.equal((await t.ledger(fork)).spans.length, 2);
    assert.equal((await t.ledger()).spans.length, 1);
  } finally {
    await t.close();
  }
});
