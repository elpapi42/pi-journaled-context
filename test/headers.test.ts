import assert from "node:assert/strict";
import { test } from "node:test";
import { scriptedModel, setup, textOf } from "./helpers.ts";

test("user messages and tool results get a header; assistant messages are sent as written", async () => {
  const t = await setup({}, scriptedModel(() => []));
  try {
    await t.say("lookup alpha");
    await t.say("thanks");
    const last = t.requests[t.requests.length - 1]!;
    const [user, assistant, result, answer, second] = last;
    assert.match(textOf(user!), /^<entry id="\d+" at="\d{4}-\d\d-\d\d \d\d:\d\d"\/>\nlookup alpha$/);
    assert.equal(textOf(assistant!), "[call lookup]", "nothing is written into an assistant message");
    assert.match(textOf(result!), /^<entry id="\d+" at="[^"]+" after="\d+"\/>\nFact 1 about alpha/);
    assert.equal(textOf(answer!), "The lookup returned forty facts.");
    assert.match(textOf(second!), /^<entry id="\d+" at="[^"]+" after="\d+"\/>\nthanks$/, "a user message names the assistant message before it");

    // The header of an entry is the same on every request, which keeps the provider's cache valid.
    const first = t.requests[1]!;
    assert.equal(textOf(first[0]!), textOf(user!));
    assert.equal(textOf(first[2]!), textOf(result!));

    // Stored entries are not changed.
    const stored = (await t.root.context((await import("./helpers.ts")).ctx)).messages.find((message) => message.role === "user")!;
    assert.equal(textOf(stored), "lookup alpha");
  } finally {
    await t.close();
  }
});
