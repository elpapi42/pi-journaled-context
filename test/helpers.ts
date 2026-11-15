import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { createMemoryExtension, LedgerDoc, type Ledger, type MemoryConfig } from "../src/index.ts";

export const ctx = BACKGROUND_CONTEXT;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plain text of one provider-facing message. */
export function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : part.type === "toolCall" ? `[call ${part.name}]` : "")).join("\n");
}

/** A tool that returns a long, deterministic text, to give the conversation volume. */
export const lookup = defineTool({
  name: "lookup",
  description: "Look up the numbered facts of a topic.",
  parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"], additionalProperties: false },
  replay: "safe",
  execute: async (args) => ({
    output: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `Fact ${i + 1} about ${(args as { topic: string }).topic}: the value is ${(i * 37) % 100}.`).join("\n") }],
  }),
});

export type Responder = (messages: readonly Message[], request: number) => AssistantMessage;

/** What a scripted fork does in its maintenance run. Each function gets the provider-facing messages. */
export type ForkScript = (messages: readonly Message[], instruction: string) => { name: string; args: Record<string, unknown> }[];

const MAINTENANCE = "<memory-maintenance>";
export const headerIds = (messages: readonly Message[], role: Message["role"]) =>
  messages.filter((message) => message.role === role).map((message) => Number(/<entry id="(\d+)"/.exec(textOf(message))?.[1])).filter((id) => !Number.isNaN(id));

/**
 * The model of the tests. A user message "lookup <topic>" makes it call the lookup tool and then answer; any other
 * message gets a short answer. In a maintenance run it makes the calls `fork` returns, then says done. A tool answer
 * that announces a fold makes it write the fold.
 */
export function scriptedModel(fork: ForkScript): Responder {
  return (messages) => {
    const last = messages[messages.length - 1]!;
    const users = messages.filter((message) => message.role === "user");
    const lastUser = users[users.length - 1];
    const instruction = lastUser === undefined ? "" : textOf(lastUser);
    const maintenance = instruction.includes(MAINTENANCE);
    if (last.role === "toolResult") {
      if (maintenance && textOf(last).includes("A fold is now due")) {
        return fauxAssistantMessage(fauxToolCall("memory_fold", { text: "Folded: earlier spans looked up several topics; all lookups succeeded." }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(maintenance ? "done" : "The lookup returned forty facts.");
    }
    if (maintenance) {
      const calls = fork(messages, instruction);
      if (calls.length === 0) return fauxAssistantMessage("done");
      return fauxAssistantMessage(calls.map((call) => fauxToolCall(call.name, call.args)), { stopReason: "toolUse" });
    }
    const topic = /lookup (\w+)/.exec(textOf(last))?.[1];
    if (topic !== undefined) return fauxAssistantMessage(fauxToolCall("lookup", { topic }), { stopReason: "toolUse" });
    return fauxAssistantMessage("Understood.");
  };
}

export async function setup(config: Partial<MemoryConfig>, respond: Responder) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const requests: Message[][] = [];
  let count = 0;
  faux.setResponses(Array.from({ length: 400 }, () => (context: { messages: Message[] }) => {
    const messages = context.messages.filter((message) => message.role !== "system");
    requests.push(messages);
    return respond(messages, count++);
  }));
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test-tools", tools: [lookup] }));
  registry.install(createMemoryExtension(config));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: faux.provider.id, modelId: faux.provider.getModels()[0]!.id } } });

  const say = async (text: string) => {
    const settled = await (await root.submit({ type: "input", content: text }, ctx)).wait(ctx);
    await harness.waitForIdle(ctx);
    return settled.status;
  };
  const ledger = async (conversation: Conversation = root) => (await harness.snapshot(LedgerDoc, conversation.id, ctx)) as Ledger;
  const entries = async (): Promise<EntryRecord[]> =>
    root.commit(async (tx) => [...(await tx.scanEntries({ conversationId: root.id, order: "ascending" }, 2000)).items], ctx);
  /** What the model would be sent now, without the system message, as text per message. */
  const context = async () => (await root.context(ctx)).messages.filter((message) => message.role !== "system").map((message) => `${message.role}: ${textOf(message)}`);
  /** Wait until background work (fork runs) has settled. */
  const settle = async (ms = 4000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await harness.waitForIdle(ctx);
      const state = await ledger();
      if (!state.run.active) return;
      await sleep(20);
    }
    throw new Error("the fork run did not finish in time");
  };
  return { harness, root, say, ledger, entries, context, settle, requests, close: () => harness.close(ctx) };
}
