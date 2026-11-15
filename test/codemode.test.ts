import assert from "node:assert/strict";
import { test } from "node:test";
import { headerIds, scriptedModel, setup, textOf, type ForkScript } from "./helpers.ts";

const SMALL = { spanTokens: 600, protectedTokens: 300, compactionTokens: 1200, compressedTextTokens: 60, codemodeOnly: true };

/**
 * A fork that does its work in one codemode script: a request that is refused, then the journal entry and a
 * compression. The refusal must not end the script.
 */
const scriptingFork: ForkScript = (messages, instruction) => {
  const cut = Number(/id lower than (\d+)/.exec(instruction)?.[1]);
  const span = Number(/^- journal entry (\d+), rank 1:/m.exec(instruction)?.[1]);
  const before = messages.slice(0, -1);
  const user = headerIds(before, "user")[0]!;
  const result = headerIds(before, "toolResult").find((id) => id < cut)!;
  const code = [
    `console.log(await tools.jcm_compress({ items: [{ id: ${user}, text: "not a result" }] }));`,
    `console.log(await tools.jcm_journal({ id: ${span}, text: "The user asked for lookups and I ran them [${result}]." }));`,
    `console.log(await tools.jcm_compress({ items: [{ id: ${result}, text: "lookup returned forty facts." }] }));`,
  ].join("\n");
  return [{ name: "codemode", args: { code } }];
};

test("with codemodeOnly, only recall is shown to the agent, and a fork does its work through codemode scripts", async () => {
  const t = await setup(SMALL, scriptedModel(scriptingFork), { codemode: true });
  try {
    await t.say("lookup alpha");
    await t.say("lookup beta");
    await t.settle();

    // What the main agent is told: recall is declared in the codemode section, the maintenance tools are nowhere.
    const system = t.systems[0]!;
    assert.ok(system.includes("jcm_recall"), "recall is listed for codemode scripts");
    for (const name of ["jcm_compress", "jcm_remove", "jcm_cancel", "jcm_journal"]) {
      assert.ok(!system.includes(name), `${name} is not mentioned in the system prompt`);
    }
    assert.ok(!system.includes("## Memory"), "the extension adds no prompt section");

    // The fork was told about the tools in its instruction, and its script ran all three calls.
    const instruction = t.requests.flat().map(textOf).find((text) => text.includes("<memory-maintenance>"))!;
    assert.match(instruction, /Call them from a codemode script as `await tools\.<name>\(arguments\)`/);
    assert.match(instruction, /jcm_remove\(\{ items: \[\{ id: number, reason: string \}/);
    const output = t.requests.flat().map(textOf).find((text) => text.includes("Script completed"))!;
    assert.match(output, /Refused: Entry \d+ is a user message/, "the refusal came back as text");
    assert.match(output, /Recorded journal entry \d+ of rank 1/, "and the script went on");
    const ledger = await t.ledger();
    assert.equal(Object.keys(ledger.journal).length, 1);
    assert.equal(Object.values(ledger.compressions).filter((item) => !item.applied).length, 1);
  } finally {
    await t.close();
  }
});
