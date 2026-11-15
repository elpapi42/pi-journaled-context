import assert from "node:assert/strict";
import { test } from "node:test";
import { ctx, scriptedModel, setup } from "./helpers.ts";

test("enabled for a conversation that already has history, it starts counting at what the model still sees", async () => {
  const t = await setup({ spanTokens: 100_000, protectedTokens: 200, compactionTokens: 100_000 }, scriptedModel(() => []));
  try {
    // Three lookups without the extension, then a reset: the model no longer sees them.
    await t.disable();
    for (const topic of ["alpha", "beta", "gamma"]) await t.say(`lookup ${topic}`);
    await t.root.reset("We looked up three topics. Continue.", ctx);
    assert.equal((await t.ledger())?.counted ?? 0, 0, "nothing was counted while the extension was off");

    await t.enable();
    await t.say("hello");
    const ledger = await t.ledger();
    assert.ok(ledger.open.tokens > 0, "activity is counted from now on");
    assert.ok(ledger.open.tokens < 200, `the three earlier lookups are not counted (${ledger.open.tokens} tokens in the open span)`);
    const first = (await t.entries()).find((entry) => entry.id === ledger.open.first)!;
    assert.ok(first.kind === "pi.reset" || first.id > (await t.entries()).find((entry) => entry.kind === "pi.reset")!.id - 1, "the open span starts at the reset");
  } finally {
    await t.close();
  }
});
