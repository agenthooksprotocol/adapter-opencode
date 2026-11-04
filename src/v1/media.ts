// OpenCode 1's message parts as canonical AHP content.
import { asText, message, textPart, type Message, type Part, type Role } from "../shared/content.js";
import { fileParts } from "../shared/media.js";

/** The native part fields the adapter reads. */
export type NativePart = {
  id: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  mime?: string;
  url?: string;
  filename?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: unknown; output?: string; error?: string; attachments?: NativePart[] };
};

/** One native part as canonical parts, keeping its id: an effective part finds
 * its native part again by that id. */
export function partsOf(part: NativePart): Part[] {
  switch (part.type) {
    case "text":
      return part.ignored ? [] : [textPart(part.id, part.text ?? "")];
    case "reasoning":
      return [textPart(part.id, part.text ?? "", "reasoning")];
    case "file":
      return fileParts(part.id, part.mime ?? "application/octet-stream", part.url ?? "");
    case "tool": {
      const { attachments = [], ...state } = part.state ?? {};
      return [
        textPart(part.id, asText({ tool: part.tool, callID: part.callID, ...state }), state.status === "completed" || state.status === "error" ? "tool_result" : "tool_call"),
        ...attachments.flatMap((file, index) => fileParts(`${part.id}:media:${index}`, file.mime ?? "application/octet-stream", file.url ?? "")),
      ];
    }
    case "subtask":
    case "agent":
    case "compaction":
      return [textPart(part.id, asText(part), part.type)];
    default:
      // Step markers, snapshots and patches are bookkeeping, not content.
      return [];
  }
}

/** A native message as a canonical message; its id is OpenCode's own. */
export function canonical(id: string, role: Role, parts: readonly NativePart[]): Message {
  return { id, role, parts: parts.flatMap(partsOf) };
}

/** A tool's result as the `tool` message of tool.after. */
export function toolResult(id: string, text: string, attachments: readonly { mime?: string; url?: string }[] = []): Message {
  const item: Message = message(id, "tool", text);
  for (const [index, file] of attachments.entries())
    item.parts.push(...fileParts(`${id}:media:${index}`, file.mime ?? "application/octet-stream", file.url ?? ""));
  return item;
}

/** Apply an effective message's text back to its native parts, in place: a
 * changed part keeps its id, a removed text part goes, and text under an id the
 * message did not have arrives as a synthetic part. Other parts are pinned. */
export function applyParts(native: NativePart[], effective: readonly Part[] | undefined, mint: () => NativePart): void {
  if (!effective) return;
  const byId = new Map(effective.map((part) => [part.id, part]));
  for (let index = native.length - 1; index >= 0; index--) {
    const part = native[index]!;
    if (part.type !== "text" && part.type !== "reasoning") continue;
    if (part.ignored) continue;
    const next = byId.get(part.id) as { text?: string } | undefined;
    if (next === undefined) native.splice(index, 1);
    else if (typeof next.text === "string") part.text = next.text;
  }
  const known = new Set(native.flatMap((part) => [part.id, ...partsOf(part).map((item) => item.id)]));
  for (const part of effective as readonly { id: string; text?: string }[]) {
    if (known.has(part.id) || typeof part.text !== "string") continue;
    native.push({ ...mint(), text: part.text });
  }
}
