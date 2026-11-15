import assert from "node:assert/strict";
import { test } from "node:test";
import { scriptedModel, setup, type ForkScript } from "./helpers.ts";

const journalOnly: ForkScript = (_messages, instruction) =>
  [...instruction.matchAll(/^- span (\d+):/gm)].map((match) => ({ name: "memory_journal", args: { span: Number(match[1]), text: `Span ${match[1]}: a lookup was run.` } }));

test("over the hard limit, everything pending is applied at once; with nothing pending, a notice says so", async () => {
  // A reserve larger than any context window puts every context over the limit.
  const t = await setup({ spanTokens: 300, protectedTokens: 200, compactionTokens: 100_000_000, reserveTokens: 100_000_000 }, scriptedModel(journalOnly));
  try {
    await t.say("lookup alpha");
    await t.settle();
    let kinds = (await t.entries()).map((entry) => entry.kind);
    assert.equal(kinds.filter((kind) => kind === "memory.notice").length, 1, "nothing was pending yet, so the notice was written");
    assert.ok(!kinds.includes("memory.compaction"));

    // The fork run has written a journal entry by now. The next end of run applies it although the threshold is far away.
    await t.say("lookup beta");
    await t.settle();
    kinds = (await t.entries()).map((entry) => entry.kind);
    assert.ok(kinds.includes("memory.compaction"), "the pending journal entry was applied at the limit");
    const notice = (await t.entries()).find((entry) => entry.kind === "memory.notice")!;
    assert.match(String((notice.data as { message: string }).message), /over the limit .* nothing is pending that could shrink it/);

    await t.say("hello");
    await t.say("hello again");
    kinds = (await t.entries()).map((entry) => entry.kind);
    assert.ok(kinds.filter((kind) => kind === "memory.notice").length <= 2, "the notice is not repeated at every run");
  } finally {
    await t.close();
  }
});

test("Pi Durable's own compaction is declined for a conversation that uses the extension", async () => {
  const t = await setup({}, scriptedModel(() => []));
  try {
    await t.say("lookup alpha");
    await t.say("lookup beta");
    const { ctx } = await import("./helpers.ts");
    await t.root.configure({ compaction: { keepRecentTokens: 10 } }, ctx);
    const id = await t.root.compact(undefined, ctx);
    const settled = await t.harness.waitForTask(id, ctx);
    assert.deepEqual((settled.state as { outcome: unknown }).outcome, { status: "completed", result: {} });
    assert.ok(!(await t.entries()).some((entry) => entry.kind === "pi.compaction"));
  } finally {
    await t.close();
  }
});
