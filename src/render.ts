import type { Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ContextView, EntryRecord } from "@earendil-works/pi-durable";
import { SPAN_KIND, type JournalEntry, type Ledger } from "./ledger.ts";

/** A time as the model sees it: UTC, to the minute. */
export function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** The header that gives a user message or a tool result its id and time. */
export function entryHeader(fields: { id: number; at: number; after?: number; compressed?: boolean }): string {
  const after = fields.after === undefined ? "" : ` after="${fields.after}"`;
  const compressed = fields.compressed ? ` compressed="true"` : "";
  return `<entry id="${fields.id}" at="${stamp(fields.at)}"${after}${compressed}/>`;
}

/** A journal entry as the model sees it. */
export function journalText(entry: JournalEntry): string {
  return `<journal id="${entry.id}" from="${stamp(entry.from)}" to="${stamp(entry.to)}" rank="${entry.rank}">\n${entry.text.trim()}\n</journal>`;
}

/** The message a journal entry is rendered as, at the position of its anchor. */
export function journalMessage(entry: JournalEntry): UserMessage {
  return { role: "user", content: [{ type: "text", text: journalText(entry) }], timestamp: entry.to };
}

const text = (value: string): TextContent => ({ type: "text", text: value });

/**
 * The entry each message of a context came from. Messages are matched by identity first, since the view hands out the
 * same objects, and by role, time and tool call otherwise.
 */
export function entryIndex(view: ContextView): (message: Message) => EntryRecord | undefined {
  const byObject = new Map<Message, EntryRecord>();
  const byFields = new Map<string, EntryRecord>();
  view.entries.forEach((entry, index) => {
    for (const message of view.contributions[index] ?? []) {
      byObject.set(message, entry);
      byFields.set(fieldsKey(message), entry);
    }
  });
  return (message) => byObject.get(message) ?? byFields.get(fieldsKey(message));
}

function fieldsKey(message: Message): string {
  return `${message.role}|${message.timestamp}|${message.role === "toolResult" ? message.toolCallId : ""}`;
}

/**
 * The messages of one request with headers added. Assistant messages are never changed: models copy what they see in
 * their own earlier messages. The id of an assistant entry is carried by the message that follows it, as `after`.
 * The result depends only on the committed context, so every request renders the same bytes for the same entries.
 */
export function withHeaders(messages: readonly Message[], view: ContextView, ledger: Ledger | undefined): Message[] {
  const entryOf = entryIndex(view);
  let lastAssistant: number | undefined;
  let previousRole: Message["role"] | undefined;
  return messages.map((message) => {
    if (message.role === "system") return message;
    const entry = entryOf(message);
    if (message.role === "assistant") {
      lastAssistant = entry?.id;
      previousRole = "assistant";
      return message;
    }
    const role = previousRole;
    previousRole = message.role;
    // A journal entry carries its own wrapper, and a message without an entry was synthesized by the Harness.
    if (entry === undefined || entry.kind === SPAN_KIND) return message;
    const follows = message.role === "toolResult" || role === "assistant";
    const header = text(
      entryHeader({
        id: entry.id,
        at: message.timestamp,
        ...(follows && lastAssistant !== undefined ? { after: lastAssistant } : {}),
        compressed: message.role === "toolResult" && ledger?.compressions[String(entry.id)]?.applied === true,
      }),
    );
    const parts = typeof message.content === "string" ? [text(message.content)] : message.content;
    return { ...message, content: [header, ...parts] } as Message;
  });
}
