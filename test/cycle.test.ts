import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { headerIds, scriptedModel, setup, textOf, type ForkScript } from "./helpers.ts";

const SMALL = { spanTokens: 600, protectedTokens: 300, compactionTokens: 1200, compressedTextTokens: 60, journalEntryTokens: 120 };

/** A fork that journals every span it is asked for, compresses the oldest raw result and removes the oldest user message. */
const diligentFork: ForkScript = (messages, instruction) => {
  const cut = Number(/id lower than (\d+)/.exec(instruction)?.[1]);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  for (const match of instruction.matchAll(/^- span (\d+):/gm)) {
    calls.push({ name: "memory_journal", args: { span: Number(match[1]), text: `The user asked for lookups; I ran them and reported forty facts each time [${match[1]}].` } });
  }
  const before = messages.slice(0, -1);
  const raw = before.filter((message: Message) => message.role === "toolResult" && !textOf(message).includes('compressed="true"'));
  const result = headerIds(raw, "toolResult").find((id) => id < cut);
  if (result !== undefined) calls.push({ name: "memory_compress", args: { items: [{ id: result, text: "lookup returned forty numbered facts; fact 1 is 0." }] } });
  const user = headerIds(before, "user").find((id) => id < cut);
  if (user !== undefined) calls.push({ name: "memory_remove", args: { items: [{ id: user, reason: "the lookup it asked for is done" }] } });
  return calls;
};

test("a span closes, a fork run decides, and our compaction applies everything pending", async () => {
  const t = await setup(SMALL, scriptedModel(diligentFork));
  try {
    await t.say("lookup alpha");
    assert.equal((await t.ledger()).spans.length, 0, "one lookup is below the span size");
    await t.say("lookup beta");
    await t.settle();
    let ledger = await t.ledger();
    assert.equal(ledger.spans.length, 1, "the span closed");
    const span = ledger.spans[0]!;
    assert.equal(ledger.journal[String(span.id)]?.applied, false, "the fork wrote the journal entry, and it is pending");
    assert.equal(Object.values(ledger.compressions).filter((item) => !item.applied).length, 1);
    assert.equal(Object.values(ledger.removals).filter((item) => !item.applied).length, 1);
    assert.ok((await t.context()).every((line) => !line.includes("<journal")), "nothing changes in the context before the compaction");

    await t.say("lookup gamma");
    await t.settle();
    ledger = await t.ledger();
    const context = await t.context();
    const kinds = (await t.entries()).map((entry) => entry.kind);
    assert.ok(kinds.includes("memory.compaction"), "the compaction wrote one entry of edits");
    assert.equal(ledger.journal[String(span.id)]?.applied, true);
    assert.ok(context.some((line) => line.startsWith(`user: <journal id="${span.id}"`)), "the journal entry is rendered as a user message");
    assert.ok(context.some((line) => line.includes("lookup returned forty numbered facts")), "the compressed text replaced the result");
    assert.ok(!context.some((line) => line === "user: lookup alpha"), "the removed user message is gone");
    assert.ok(context.some((line) => line === "user: lookup beta"), "what was not removed is still there, word for word");
    assert.equal(ledger.sinceCompaction < SMALL.compactionTokens, true, "the counter started again");

    // What the provider is sent: the compressed result says so in its header, and the journal entry has no header.
    await t.say("thanks");
    const sent = t.requests[t.requests.length - 1]!.map(textOf);
    assert.ok(sent.some((text) => /^<entry id="\d+" at="[^"]+" after="\d+" compressed="true"\/>\nlookup returned forty/.test(text)));
    assert.ok(sent.some((text) => text.startsWith(`<journal id="${span.id}"`)));
  } finally {
    await t.close();
  }
});

test("a worker fork cannot call tools other than the memory tools", async () => {
  const curious: ForkScript = () => [{ name: "lookup", args: { topic: "secret" } }];
  const t = await setup(SMALL, scriptedModel(curious));
  try {
    await t.say("lookup alpha");
    await t.say("lookup beta");
    await t.settle();
    const blocked = t.requests.flat().filter((message) => message.role === "toolResult" && textOf(message).includes("memory maintenance run"));
    assert.equal(blocked.length, 1, "the call was blocked with an explanation");
    assert.equal((await t.ledger()).run.active, false, "the run ended");
  } finally {
    await t.close();
  }
});
