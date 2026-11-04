// Canonical AHP content built from what Claude Code hands a hook. Structured
// values (tool records, tool-use blocks) travel as their JSON serialization in a
// text part, which is how the spec carries structured data; media is media.ts's.
import type { Attachment } from "agenthooksprotocol/client";

export type Role = "system" | "developer" | "user" | "assistant" | "tool";

export type TextPart = {
  id: string;
  kind: "text";
  mediaType: "text/plain";
  selection: "body";
  text: string;
  category?: string;
}

/** An attachment part: a body the SDK may upload, or the reason there is none. */
export type AttachmentPart =
  | { id: string; kind: "attachment"; mediaType: string; body: Attachment; category?: string }
  | { id: string; kind: "attachment"; mediaType: string; selection: "body"; gap: { reason: string }; category?: string };

export type Part = TextPart | AttachmentPart;

export type Message = {
  id: string;
  role: Role;
  parts: Part[];
  synthesized?: boolean;
}

export type TextMessage = Omit<Message, "parts"> & { parts: TextPart[] };

/** A message of one text part. `id` is durable when the caller has a native id
 * for the content (a transcript row, a tool_use_id); otherwise it is derived
 * from the event it belongs to and marked synthesized. */
export function message(
  id: string,
  role: Role,
  text: string,
  options: { category?: string; synthesized?: boolean } = {},
): TextMessage {
  return {
    id,
    role,
    parts: [{
      id: `${id}#0`,
      kind: "text",
      mediaType: "text/plain",
      selection: "body",
      text,
      ...(options.category ? { category: options.category } : {}),
    }],
    ...(options.synthesized ? { synthesized: true } : {}),
  };
}

/** A host value as the JSON the SDK's payload types declare. Values reach
 * here from the engine, which hands hooks plain JSON. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export function json<T = { [key: string]: Json }>(value: unknown): T {
  return value as T;
}

/** One text part, for fields typed as `TextParts` or `TextPart`. */
export function textPart(id: string, text: string, category?: string): TextPart {
  return { id, kind: "text", mediaType: "text/plain", selection: "body", text, ...(category ? { category } : {}) };
}

/** Serialize any value as model-visible text. */
export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
  } catch {
    return String(value);
  }
}

/** The text of every part of the messages, in order. */
export function texts(messages: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const entry of messages ?? []) {
    const parts = (entry as { parts?: unknown[] })?.parts;
    for (const part of parts ?? []) {
      const text = (part as { text?: unknown })?.text;
      if (typeof text === "string" && text !== "") out.push(text);
    }
  }
  return out;
}
