// model.request.before at experimental.chat.messages.transform: the last hook
// that can still change what the model reads. model.response.after,
// tool.batch.after and turn.progress are observed from the bus.
import type { Hooks as PluginHooks } from "@opencode-ai/plugin";
import type { Event as BusEvent } from "@opencode-ai/sdk";
import { Permission, state } from "agenthooksprotocol/client";
import { type Adapter, type SessionState, denial, injections } from "../adapter.js";
import { message, textPart, type Message, type Part, type Role } from "../../shared/content.js";
import { applyParts, canonical, type NativePart } from "../media.js";
import { descriptor } from "./tools.js";

/** Requests outside the session's loop. */
const HOUSEKEEPING = new Set(["title", "summary"]);

type Row = { info: { id: string; role: string; sessionID: string; model?: { providerID: string; modelID: string }; agent?: string; variant?: string }; parts: NativePart[] };

function attempt(session: SessionState) {
  return { id: `${session.turn!.id}:${session.turn!.attempts}`, number: 1, synthesized: true };
}

export function modelHooks(adapter: Adapter): Pick<PluginHooks, "experimental.chat.messages.transform" | "experimental.chat.system.transform" | "chat.params"> {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const rows = output.messages as unknown as Row[];
      const last = rows.at(-1);
      if (!last) return;
      const session = await adapter.session(last.info.sessionID);
      // A compaction serializes the conversation through this hook too.
      if (session.compacting) {
        session.compacting = false;
        return;
      }
      const turn = session.turn;
      if (!turn) return;
      turn.attempts += 1;
      const lastUser = rows.findLast((row) => row.info.role === "user")?.info;
      const model = lastUser?.model ? { id: lastUser.model.modelID, provider: lastUser.model.providerID } : session.model;
      const context = [...turn.context];
      const hooks = await adapter.client("model.request.before");
      if (hooks && model) {
        const items: Message[] = rows.map((row) => canonical(row.info.id, row.info.role as Role, row.parts));
        const system = session.system
          ? [{ id: `${attempt(session).id}:system`, role: "system" as const, synthesized: true, parts: session.system.map((text, index) => textPart(`${attempt(session).id}:system:${index}`, text, "system")) }]
          : [];
        const result = await hooks.modelRequestBefore({
          ...adapter.scope(session),
          model,
          attempt: attempt(session),
          params: { model: model.id, ...(lastUser?.agent ? { agent: lastUser.agent } : {}), ...(lastUser?.variant ? { variant: lastUser.variant } : {}) },
          items: [...system, ...items] as never,
          gaps: [
            { path: "params", reason: "sampling parameters are computed after this boundary" },
            ...(session.system ? [] : [{ path: "items.system", reason: "OpenCode composes the system prompt after this boundary" }]),
          ],
        }, { initialState: state.initial(Permission.None) });
        adapter.report(result);
        const refused = denial(result);
        if (refused !== undefined) {
          turn.error = { class: "Denied", message: refused };
          adapter.notify(refused, "error");
          throw new Error(refused);
        }
        applyRequest(rows, (result.event as { items?: { id: string; parts?: Part[] }[] }).items);
        context.push(...injections(result));
      }
      if (!context.length) return;
      const target = rows.findLast((row) => row.info.role === "user") ?? last;
      for (const text of context)
        target.parts.push({ id: `${target.parts.at(-1)?.id ?? "prt_"}z${crypto.randomUUID().replaceAll("-", "")}`, type: "text", text, synthetic: true, ...({ sessionID: target.info.sessionID, messageID: target.info.id }) });
    },

    // The system prompt this request will carry, reported with the next one:
    // chat.params says whose it was (title requests compose one as well).
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const session = adapter.sessions.get(input.sessionID);
      if (session) session.composing = [...output.system];
    },

    "chat.params": async (input) => {
      const session = adapter.sessions.get(input.sessionID);
      if (!session) return;
      if (!HOUSEKEEPING.has(input.agent) && input.agent !== "compaction" && session.composing) session.system = session.composing;
      session.composing = undefined;
    },
  };
}

/** Apply the effective request to this request's own copy of the conversation:
 * the copy is not saved, so this holds for this request only. */
function applyRequest(rows: Row[], effective: { id: string; role?: string; parts?: Part[] }[] | undefined): void {
  if (!effective) return;
  const byId = new Map(effective.map((item) => [item.id, item]));
  const known = new Set(rows.map((row) => row.info.id));
  // A message the conversation does not have rides on its last user message:
  // OpenCode's messages need ids and metadata a backend cannot supply.
  const added = effective.filter((item) => !known.has(item.id) && item.role !== "system").flatMap((item) => item.parts ?? []);
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    const item = byId.get(row.info.id);
    if (!item) {
      rows.splice(index, 1);
      continue;
    }
    applyParts(row.parts, item.parts, () => ({
      id: `${row.parts.at(-1)?.id ?? "prt_"}z${crypto.randomUUID().replaceAll("-", "")}`,
      type: "text",
      synthetic: true,
      ...({ sessionID: row.info.sessionID, messageID: row.info.id }),
    }));
  }
  const target = rows.findLast((row) => row.info.role === "user");
  if (!target) return;
  for (const part of added as { text?: string }[]) {
    if (typeof part.text !== "string") continue;
    target.parts.push({
      id: `${target.parts.at(-1)?.id ?? "prt_"}z${crypto.randomUUID().replaceAll("-", "")}`,
      type: "text",
      text: part.text,
      synthetic: true,
      ...({ sessionID: target.info.sessionID, messageID: target.info.id }),
    });
  }
}

export async function onModelEvent(adapter: Adapter, event: BusEvent): Promise<void> {
  if (event.type === "session.error") {
    const { sessionID, error } = event.properties;
    if (!sessionID || error?.name === "MessageAbortedError") return;
    const session = await adapter.session(sessionID);
    void adapter.enqueue(session, async () => {
      const hooks = await adapter.client("model.error");
      if (!hooks || !session.turn?.attempts || !session.model) return;
      adapter.report(await hooks.modelError({
        ...adapter.scope(session),
        model: session.model,
        attempt: attempt(session),
        execution: { status: "executed" },
        error: { class: error?.name ?? "Error", message: String((error?.data as { message?: unknown } | undefined)?.message ?? "The model request failed") },
      }));
    });
    return;
  }
  if ((event.type as string) === "message.part.delta") {
    const { sessionID, messageID, partID, field, delta } = (event as unknown as { properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string } }).properties;
    if (field !== "text") return;
    const session = await adapter.session(sessionID);
    void adapter.enqueue(session, async () => {
      const hooks = await adapter.client("turn.progress");
      if (!hooks || !session.turn) return;
      adapter.report(await hooks.turnProgress({
        session: adapter.sessionObject(session),
        turn: { id: session.turn.id },
        item: { id: messageID },
        delta: message(partID, "assistant", delta) as never,
        final: false,
      }));
    });
    return;
  }
  if (event.type !== "message.part.updated") return;
  const part = event.properties.part;
  if (part.type !== "step-finish") return;
  const session = await adapter.session(part.sessionID);
  void adapter.enqueue(session, () => stepFinished(adapter, session, part));
}

async function stepFinished(
  adapter: Adapter,
  session: SessionState,
  part: { messageID: string; reason: string; tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }; cost: number },
): Promise<void> {
  if (!session.turn?.attempts) return;
  const [response, batch] = await Promise.all([adapter.client("model.response.after"), adapter.client("tool.batch.after")]);
  if (!response && !batch) return;
  const fetched = await adapter.host.client.session.message({ path: { id: session.id, messageID: part.messageID } }).catch(() => undefined);
  const row = fetched?.data;
  if (!row) return;
  // Compaction's own request is reported by context.compact.*.
  if ((row.info as { summary?: unknown }).summary) return;
  const info = row.info as { modelID?: string; providerID?: string };
  const parts = row.parts as unknown as NativePart[];
  if (response) {
    adapter.report(await response.modelResponseAfter({
      ...adapter.scope(session),
      model: { id: info.modelID ?? session.model?.id ?? "unknown", provider: info.providerID ?? session.model?.provider ?? "unknown" },
      attempt: attempt(session),
      execution: { status: "executed" },
      finishReason: part.reason,
      items: [canonical(part.messageID, "assistant", parts)] as never,
      usage: {
        kind: "amount",
        scope: "attempt",
        provenance: "provider",
        completeness: "complete",
        inputTokens: part.tokens.input,
        outputTokens: part.tokens.output,
        ...(part.tokens.cache.read ? { cacheReadTokens: part.tokens.cache.read } : {}),
        ...(part.tokens.cache.write ? { cacheWriteTokens: part.tokens.cache.write } : {}),
      },
    }));
  }
  const calls = parts.filter((item) => item.type === "tool" && (item.state?.status === "completed" || item.state?.status === "error"));
  if (batch && part.reason === "tool-calls" && calls.length) {
    adapter.report(await batch.toolBatchAfter({
      ...adapter.scope(session),
      batch: { id: part.messageID },
      calls: calls.map((call) => {
        const { origin, path } = descriptor(adapter, call.tool!);
        return {
          call: { id: call.callID! },
          tool: { name: call.tool!, origin, input: (call.state?.input ?? {}) as { [key: string]: never } },
          path,
          outcome: call.state?.status === "completed" ? "ok" as const : "error" as const,
          execution: { status: "executed" as const },
        };
      }),
    }));
  }
}
