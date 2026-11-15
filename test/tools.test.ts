import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { headerIds, setup, textOf, type Responder } from "./helpers.ts";

const SMALL = { spanTokens: 100_000, protectedTokens: 300, compactionTokens: 100_000, compressedTextTokens: 60 };

/**
 * A model that calls the lookup tool like the scripted one, and that makes exactly the memory calls a test asks for
 * in a user message of the form "call <tool> <json>".
 */
const obedient: Responder = (messages) => {
  const last = messages[messages.length - 1]!;
  if (last.role === "toolResult") return fauxAssistantMessage("ok");
  const text = textOf(last);
  const call = /call (\w+) (\{.*\})/s.exec(text);
  if (call !== null) return fauxAssistantMessage(fauxToolCall(call[1]!, JSON.parse(call[2]!)), { stopReason: "toolUse" });
  const topic = /lookup (\w+)/.exec(text)?.[1];
  if (topic !== undefined) return fauxAssistantMessage(fauxToolCall("lookup", { topic }), { stopReason: "toolUse" });
  return fauxAssistantMessage("Understood.");
};

/** The text of the newest tool result the model was sent. */
const lastResult = (requests: Message[][]) => {
  const results = requests[requests.length - 1]!.filter((message) => message.role === "toolResult");
  return textOf(results[results.length - 1]!);
};

test("the memory tools refuse what the design forbids, and say why", async () => {
  const t = await setup(SMALL, obedient);
  try {
    await t.say("lookup alpha");
    await t.say("lookup beta");
    await t.say("lookup gamma");
    const sent = t.requests[t.requests.length - 1]!;
    const users = headerIds(sent, "user");
    const results = headerIds(sent, "toolResult");
    const firstUser = users[0]!;
    const firstResult = results[0]!;
    const firstAssistant = Number(/after="(\d+)"/.exec(textOf(sent.find((message) => message.role === "toolResult")!))![1]);
    const newestResult = results[results.length - 1]!;

    await t.say(`call jcm_compress {"items": [{"id": ${firstUser}, "text": "short"}]}`);
    assert.match(lastResult(t.requests), /is a user message\. Only tool results can be compressed/);

    await t.say(`call jcm_remove {"items": [{"id": ${firstResult}, "reason": "old"}]}`);
    assert.match(lastResult(t.requests), new RegExp(`A tool result cannot be removed alone\\. It belongs to your message ${firstAssistant}`));

    await t.say(`call jcm_compress {"items": [{"id": ${newestResult}, "text": "short"}]}`);
    assert.match(lastResult(t.requests), /inside the protected recent part/);

    await t.say(`call jcm_compress {"items": [{"id": ${firstResult}, "text": "${"long ".repeat(200)}"}]}`);
    assert.match(lastResult(t.requests), /may be at most 60 tokens/);

    await t.say(`call jcm_compress {"items": [{"id": ${firstResult}, "text": "forty facts about alpha"}]}`);
    assert.match(lastResult(t.requests), new RegExp(`Pending: result ${firstResult} goes from about`));
    await t.say(`call jcm_compress {"items": [{"id": ${firstResult}, "text": "again"}]}`);
    assert.match(lastResult(t.requests), /already pending/);

    await t.say(`call jcm_cancel {"ids": [${firstResult}]}`);
    assert.match(lastResult(t.requests), /Cancelled the pending compression/);
    assert.equal(Object.keys((await t.ledger()).compressions).length, 0);
    await t.say(`call jcm_cancel {"ids": [${firstResult}]}`);
    assert.match(lastResult(t.requests), /Nothing is pending/);

    await t.say(`call jcm_compress {"items": [{"id": ${firstResult}, "text": "forty facts about alpha"}]}`);
    await t.say(`call jcm_remove {"items": [{"id": ${firstAssistant}, "reason": "the lookup is done"}]}`);
    assert.match(lastResult(t.requests), new RegExp(`your message ${firstAssistant} leaves the context at the next compaction, together with its 1 tool call\\(s\\) \\(lookup\\) and their results ${firstResult}`));
    const ledger = await t.ledger();
    assert.equal(ledger.removals[String(firstAssistant)]?.reason, "the lookup is done");
    assert.equal(ledger.compressions[String(firstResult)], undefined, "a pending compression of a result that leaves anyway is dropped");

    // Several items in one call: each gets its own line, and one good item is enough for the call to succeed.
    const secondResult = results[1]!;
    await t.say(`call jcm_compress {"items": [{"id": ${secondResult}, "text": "forty facts about beta"}, {"id": ${firstUser}, "text": "no"}]}`);
    assert.match(lastResult(t.requests), new RegExp(`Pending: result ${secondResult} goes from[^\\n]+\\nRefused: Entry ${firstUser} is a user message`));

    await t.say(`call jcm_journal {"id": 12345, "text": "nothing"}`);
    assert.match(lastResult(t.requests), /There is no journal entry 12345 waiting for its text\. Waiting now: none/);
    await t.say(`call jcm_recall {"id": ${firstResult}}`);
    assert.match(lastResult(t.requests), new RegExp(`Original of entry ${firstResult}:[\\s\\S]*\\[tool result: lookup\\]\\nFact 1 about alpha`));
  } finally {
    await t.close();
  }
});
