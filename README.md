# Journaled Context Memory

Journaled Context Memory (JCM) is short-term memory for [Pi Durable](https://github.com/earendil-works/pi). It lets a conversation go on without limit and without a visible compaction step.

This repository is the Pi Durable extension, `pi-journaled-context`. It is experimental.

## The idea

A long conversation cannot keep everything in the model's context. The usual answer is compaction: summarize the old part into one text. This extension does something else. It edits the context piece by piece and keeps a journal of what happened.

- **Tool results are compressed** into a short text when their full content is no longer needed.
- **User messages and assistant messages are never rewritten.** They stay word for word until they are no longer useful, and then they are removed. A message that stays useful can stay for the whole life of the conversation.
- **A journal records what happened.** Each stretch of activity gets one journal entry: a truthful account of what was asked, done, found and left open. Older journal entries fold into coarser ones, so the journal grows very slowly.
- **Nothing is lost.** The original entries stay in storage, and the agent can read them again with a recall tool.

The decisions are made in the background by a fork of the conversation, which has the whole context and reads it from the provider's cache. The agent's own context holds none of that work.

## Where it comes from

JCM combines three ideas, each from someone else's work:

- **Editing the context piece by piece,** from [Context Language Models](https://arxiv.org/abs/2609.37725) (Shao et al., 2026). There the working model edits its own context; here a background copy of the conversation does it.
- **A background process that records what happened,** from [Observational Memory](https://mastra.ai/research/observational-memory) (Mastra, 2026). Here the record is a journal that describes each stretch of activity, and nothing is written by guessing what will matter later.
- **Several levels of detail that always lead back to the originals,** from [LCM: Lossless Context Management](https://papers.voltropy.com/LCM) (Ehrlich and Blackman, Voltropy, 2026). Here these are the ranks of the journal and the recall tool.

## How it works

| Term | Meaning |
| --- | --- |
| Span | A fixed amount of new activity. Closing a span starts a fork run. |
| Fork run | A forked copy of the conversation that decides what to compress and remove and writes the journal entry of the span. It changes nothing in the context; its decisions are stored as pending. |
| Rank | The level of a journal entry. A rank 1 journal entry covers one span. When a rank holds too many, its oldest fold into one journal entry of the next rank. The place and id of that coarser journal entry are reserved as soon as the entries it will cover exist, so every journal entry sits in time order with an id in order. |
| Compaction | Ours, replacing Pi Durable's. At a threshold of new activity it applies everything pending as context edits. It calls no model, so it is immediate. |
| Recall | A tool that returns what is behind an id: the journal entries a higher rank was folded from, the original entries of a span, or the original of a compressed result. |

Between compactions the context only grows by the agent's own activity, so the provider's cache stays valid. A compaction makes the provider process the context again from the oldest thing it changed.

## What the model sees

User messages and tool results get a header with their id and time (UTC). Assistant messages are sent exactly as the model wrote them; the message that follows carries the assistant message's id as `after`.

```
user:         <entry id="23" at="2026-11-15 09:05"/>
              find out why the checkout test is flaky

assistant:    (tool call: bash …)

tool result:  <entry id="25" at="2026-11-15 09:09" after="24" compressed="true"/>
              3 of 20 runs failed, always "applies coupon once": expected total 90, got 80.

user:         <journal id="31" from="2026-11-15 09:05" to="2026-11-15 10:30" rank="1">
              The user asked why the checkout test is flaky. I ruled out pool exhaustion and found
              that two requests race on the same cart row in applyCoupon [25]. Left open: the fix.
              </journal>
```

A number in square brackets inside a journal entry is the id of an entry that mattered there. The agent can recall it directly.

## Install

### With Headless Pi

1. Put this folder in `<workspace>/.hpi/extensions/pi-journaled-context`.
2. Add `"memory"` to `defaultExtensions` in `<workspace>/.hpi/config.json`, or select it per conversation with `--add-extension memory`.
3. Restart the daemon.

Headless Pi imports the extension at the next start in any case; it does nothing in a conversation that does not select it.

The extension turns off Pi Durable's own compaction for the conversations that select it.

### With Pi Durable directly

```ts
import { createMemoryExtension } from "./src/index.ts";

registry.install(createMemoryExtension({ spanTokens: 20_000 }));
```

## Settings

With Headless Pi, settings are read from `<workspace>/.hpi/memory.json`. Every field is optional.

| Setting | Default | What it does |
| --- | --- | --- |
| `protectedTokens` | 20000 | The most recent context that is never compressed or removed |
| `spanTokens` | 20000 | New activity that closes a span and starts a fork run |
| `compactionTokens` | 80000 | New activity since the last compaction that triggers the next one |
| `reserveTokens` | 16384 | Room kept free below the model's context window |
| `journalEntryTokens` | 300 | Ceiling of one journal entry |
| `compressedTextTokens` | 300 | Ceiling of one compressed tool result |
| `compressedTextRatio` | 0.5 | A compressed text may be at most this share of the original |
| `rankSize` | 30 | Most journal entries one rank may hold |
| `foldSize` | 10 | How many of a rank's oldest journal entries fold into one |
| `recallPageTokens` | 20000 | Most raw history one recall answer returns |
| `forkTurnLimit` | 16 | Turns a fork run may take |
| `silenceMs` | 180000 | Silence that closes an open span |
| `codemodeOnly` | false | Offer the memory tools only to codemode scripts, and keep the four maintenance tools out of codemode's tool list. Recommended; see below. |

Token counts are estimates, as pi-ai estimates them.

## Tools

| Tool | What it does |
| --- | --- |
| `jcm_recall` | Returns what is behind an id. This is the one tool the agent uses in normal work. |
| `jcm_compress` | Marks tool results to be replaced by a short text |
| `jcm_remove` | Marks user or assistant messages to leave the context; an assistant message takes its tool calls and their results with it |
| `jcm_cancel` | Withdraws a pending compression or removal |
| `jcm_journal` | Writes the text of one journal entry, of any rank |

The first is for the agent. The other four are the maintenance tools, meant for fork runs. Each one checks what it is asked and refuses with an explanation, for example when a target is inside the protected recent part or when a tool result would be removed alone.

A fork run can call nothing but these tools. Every other tool call is blocked there, so a fork cannot act on the world.

### Who knows about the tools

The extension adds nothing to the system prompt. The agent learns about recall from that tool's description, and a fork run is told about the maintenance tools in its instruction.

- **With `codemodeOnly: true`** (needs the codemode extension): no memory tool is offered to the model directly. The four maintenance tools are deferred, so codemode does not list them and the agent does not know they exist. Only `jcm_recall` appears in codemode's tool list. A fork run calls the tools from codemode scripts.
- **With `codemodeOnly: false`:** all five are ordinary tools the model can call. Expect the agent to call the maintenance tools itself from time to time; in tests one model did so on every turn.

## Limits of this version

- **Spans close and compactions apply only at the end of a run,** or after silence. A very long run is one span until it ends. Pi Durable has an unreleased hook that runs after every tool round; the trigger will move there.
- **At the hard limit the only measure is to apply what is pending.** If the context is still over the model's window, a `jcm.notice` entry says so and the provider may reject the next request.
- **Forks do not always read the parent's cache on OpenAI.** A fork gets a new provider session identity, and in tests most forks paid full price for their first request there. On Anthropic every fork read the cache.
- **The header hook uses a method that is not in Pi Durable's documented hook interface** to map messages to entries. It falls back to the documented entry reads.
- **The whole history stays in Pi Durable's active range,** because the head of the context never moves. Very long conversations will need more work here.
- **The fork of each fork run stays in storage** as a conversation owned by the task that made it.
- **A reset starts from nothing, also for the memory.** After `reset()` the journal entries from before it are not shown, which is what a reset means. The ledger is not cleared, though, so old journal entries still count toward their rank.
- Tested with Pi Durable 1.5.2 and Headless Pi, on `gpt-6-sol`, `gpt-6-luna`, Claude Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.2.

## Development

```sh
npm install
npm test          # tests with a fake provider
npm run typecheck
```

The code is TypeScript that Node runs directly, with no build step.

| File | What it holds |
| --- | --- |
| `src/index.ts` | The extension and its default export |
| `src/config.ts` | Settings and defaults |
| `src/ledger.ts` | The ledger document: spans, journal entries and pending decisions |
| `src/render.ts` | Headers and journal entries as the model sees them |
| `src/hooks.ts` | The hooks into Pi Durable's generation, compaction and tool tasks |
| `src/tasks.ts` | The end-of-run tick, the silence timer and the fork run |
| `src/spans.ts` | Counting activity and closing spans |
| `src/compaction.ts` | Turning pending decisions into context edits |
| `src/prompts.ts` | The prompt section, the fork's instruction and the tool descriptions |
| `src/tools/` | The memory tools |
| `src/view.ts`, `src/history.ts`, `src/tokens.ts` | Helpers for reading the context, the raw history and sizes |
