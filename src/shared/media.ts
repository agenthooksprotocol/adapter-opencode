// Files as canonical AHP content: attachments, uploaded only when a subscription
// selects the body; their bytes never travel in event text.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Attachment } from "agenthooksprotocol/client";
import { textPart, type Part } from "./content.js";

/** Only non-text, non-JSON media is uploaded (AHP-CONTENT-002). */
function isBinary(mediaType: string): boolean {
  return !/^text\/|[/+]json\b/.test(mediaType);
}

function dataBytes(url: string): Uint8Array {
  const comma = url.indexOf(",");
  const body = url.slice(comma + 1);
  return /;base64$/i.test(url.slice(0, comma))
    ? Uint8Array.fromBase64(body)
    : new TextEncoder().encode(decodeURIComponent(body));
}

/** The parts for one file a message or tool result holds. */
export function fileParts(id: string, mediaType: string, url: string): Part[] {
  const isData = url.startsWith("data:");
  if (!isData && !url.startsWith("file:"))
    return [{ id, kind: "attachment", mediaType, selection: "body", gap: { reason: `the file is at a ${url.split(":")[0]} address the adapter does not fetch` } }];
  const read = async () => (isData ? dataBytes(url) : new Uint8Array(await readFile(fileURLToPath(url))));
  if (!isBinary(mediaType) && isData) return [textPart(id, new TextDecoder().decode(dataBytes(url)))];
  return [{ id, kind: "attachment", mediaType, body: Attachment.lazy(read) }];
}
