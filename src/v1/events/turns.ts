// Turns: turn.start or user.message.inbound at chat.message, where a prompt can
// still be refused, rewritten and annotated; turn.finish.before and turn.end
// when the session goes idle, a synthetic prompt being how a backend continues.
import type { Hooks as PluginHooks } from "@opencode-ai/plugin";
import type { Event as BusEvent } from "@opencode-ai/sdk";
import { Permission, state } from "agenthooksprotocol/client";
import { MAX_CONTINUATIONS } from "../../shared/delivery.js";
import { type Adapter, EXTENSION, type SessionState, denial, flow, injections } from "../adapter.js";
import { message, texts, type Part } from "../../shared/content.js";
import { applyParts, canonical, type NativePart } from "../media.js";
import { startSession } from "./lifecycle.js";

/** A part id that sorts after `after`: OpenCode orders parts by id. */
function nextPartId(after: string | undefined): string {
  return `${after ?? "prt_"}z${crypto.randomUUID().replaceAll("-", "")}`;
}

function syntheticPart(native: NativePart[], sessionID: string, messageID: string, text = ""): NativePart & { sessionID: string; messageID: string } {
  return { id: nextPartId(native.at(-1)?.id), type: "text", text, synthetic: true, sessionID, messageID };
}

export function turnHooks(adapter: Adapter): Pick<PluginHooks, "chat.message" | "command.execute.before"> {
  /** What a slash command expands from, until its prompt arrives. */
  const commands = new Map<string, string>();
  return {
    "command.execute.before": async (input) => {
      commands.set(input.sessionID, `/${input.command}`);
    },

    "chat.message": async (input, output) => {
      const session = await adapter.session(input.sessionID);
      const parts = output.parts as unknown as NativePart[];
      const messageID = output.message.id;
      if (input.agent && session.agentType) session.agentType = input.agent;
      const proposed = input.model ?? output.message.model;
      const expandedFrom = commands.get(input.sessionID);
      commands.delete(input.sessionID);

      // Our own continuation: the same turn goes on.
      if (session.continuing) {
        session.continuing = false;
        return;
      }
      // Whatever the session was finishing decides whether this one starts a turn.
      await session.queue;
      await startSession(adapter, session, { trigger: "resume" });
      if (proposed) await switchModel(adapter, session, output.message as never, proposed);

      const item = canonical(messageID, "user", parts);
      const mint = () => syntheticPart(parts, input.sessionID, messageID);

      if (session.turn) {
        const hooks = await adapter.client("user.message.inbound");
        if (!hooks) return;
        const result = await hooks.userMessageInbound({
          ...adapter.scope(session),
          message: { channel: "prompt", sender: "user", messages: [item as never] },
        }, { initialState: state.initial(Permission.None) });
        adapter.report(result);
        const refused = denial(result);
        if (refused !== undefined) refuse(adapter, refused);
        const effective = (result.event as { message?: { messages?: { parts?: Part[] }[] } }).message?.messages?.[0];
        applyParts(parts, effective?.parts, mint);
        return;
      }

      const child = session.agentType ? claimTaskCall(adapter, session) : undefined;
      if (child) session.parentEventId = child;
      const context = session.startContext.splice(0);
      const hooks = await adapter.client("turn.start");
      if (hooks) {
        const result = await hooks.turnStart({
          turn: { id: messageID },
          session: adapter.sessionObject(session),
          trigger: session.agentType ? "external" : "user",
          items: [item as never],
          ...(expandedFrom ? { expandedFrom } : {}),
          ...(session.parentEventId ? { parentEventId: session.parentEventId } : {}),
        }, { initialState: state.initial(Permission.None) });
        adapter.report(result);
        const refused = denial(result);
        if (refused !== undefined) {
          session.startContext.push(...context);
          refuse(adapter, refused);
        }
        const effective = (result.event as { items?: { parts?: Part[] }[] }).items?.[0];
        applyParts(parts, effective?.parts, mint);
        context.push(...injections(result));
      }
      for (const text of context) parts.push(syntheticPart(parts, input.sessionID, messageID, text));
      session.turn = {
        id: messageID,
        continuationCount: 0,
        attempts: 0,
        context: [],
        ...(session.parentEventId ? { parentEventId: session.parentEventId } : {}),
      };
    },
  };
}

/** A throw is how a plugin stops a prompt; OpenCode's own message for it is
 * generic, so the reason is shown first. */
function refuse(adapter: Adapter, reason: string): never {
  adapter.notify(reason, "error");
  throw new Error(reason);
}

/** The prompt names its model: a change is a switch a backend may refuse. */
async function switchModel(
  adapter: Adapter,
  session: SessionState,
  info: { model?: { providerID: string; modelID: string } },
  proposed: { providerID: string; modelID: string },
): Promise<void> {
  const next = { id: proposed.modelID, provider: proposed.providerID };
  const current = session.model;
  if (!current || (current.id === next.id && current.provider === next.provider)) {
    session.model = next;
    return;
  }
  const reason = "the prompt names another model";
  const before = await adapter.client("model.switch.before");
  if (before) {
    const result = await before.modelSwitchBefore({
      ...adapter.scope(session),
      current,
      proposed: next,
      reason,
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    if (denial(result) !== undefined) {
      if (info.model) Object.assign(info.model, { providerID: current.provider, modelID: current.id });
      return;
    }
  }
  session.model = next;
  const after = await adapter.client("model.switch.after");
  if (after) adapter.report(await after.modelSwitchAfter({ ...adapter.scope(session), previous: current, current: next, reason }));
}

/** The task call a subagent's first prompt belongs to. */
function claimTaskCall(adapter: Adapter, session: SessionState): string | undefined {
  for (const call of adapter.calls.values()) {
    if (!call.awaitingChild || call.awaitingChild !== session.agentType) continue;
    const parent = adapter.sessions.get(call.sessionID);
    if (parent?.rootId !== session.rootId) continue;
    call.awaitingChild = undefined;
    return call.beforeEventId;
  }
  return undefined;
}

export async function onTurnEvent(adapter: Adapter, event: BusEvent): Promise<void> {
  if (event.type === "session.error") {
    const { sessionID, error } = event.properties;
    if (!sessionID) return;
    const session = await adapter.session(sessionID);
    void adapter.enqueue(session, async () => {
      if (!session.turn) return;
      if (error?.name === "MessageAbortedError") session.turn.cancelled = true;
      else session.turn.error = { class: error?.name ?? "Error", message: String((error?.data as { message?: unknown } | undefined)?.message ?? "The turn failed") };
    });
    return;
  }
  if (event.type !== "session.idle") return;
  const session = await adapter.session(event.properties.sessionID);
  void adapter.enqueue(session, () => finish(adapter, session));
}

/** The session stopped working: ask whether its turn is over, then end it. */
async function finish(adapter: Adapter, session: SessionState): Promise<void> {
  const turn = session.turn;
  if (!turn) return;
  const answer = await lastAnswer(adapter, session);
  const items = answer ? [message(answer.id, "assistant", answer.text)] : [];
  const outcome = turn.cancelled ? "cancelled" : turn.error ? "failed" : "completed";
  const parent = turn.parentEventId ? { parentEventId: turn.parentEventId } : {};

  if (outcome === "completed") {
    const hooks = await adapter.client("turn.finish.before");
    if (hooks) {
      // A subagent's result has gone back to its parent; after the limit a
      // backend may only stop.
      const continuable = !session.agentType && turn.continuationCount < MAX_CONTINUATIONS;
      const result = await hooks.turnFinishBefore({
        session: adapter.sessionObject(session),
        turn: { id: turn.id },
        items: items as never,
        continuationCount: turn.continuationCount,
        outcome,
        ...parent,
      }, {
        initialState: state.initial(Permission.None),
        ...(continuable ? {} : { capabilities: { effects: session.agentType ? ["message"] : ["flow", "message"], ...(session.agentType ? {} : { flow: { operations: ["stop"] } }) } as never }),
      });
      adapter.report(result);
      const decision = flow(result);
      if (decision?.operation === "continue" && continuable) {
        turn.continuationCount += 1;
        session.continuing = true;
        const text = decision.instruction ?? "Continue: an AHP hook asked for another pass.";
        const sent = await adapter.host.client.session.promptAsync({
          path: { id: session.id },
          body: { parts: [{ type: "text", text, synthetic: true }] },
        }).catch((error: unknown) => ({ error }));
        if (!("error" in sent) || !sent.error) return;
        session.continuing = false;
        adapter.log("error", "could not continue the turn");
      }
    }
  }

  session.turn = undefined;
  const hooks = await adapter.client("turn.end");
  if (!hooks) return;
  adapter.report(await hooks.turnEnd({
    session: adapter.sessionObject(session),
    turn: { id: turn.id },
    items: items as never,
    continuationCount: turn.continuationCount,
    outcome,
    ...(turn.error ? { error: turn.error } : {}),
    ...parent,
    extensions: { [EXTENSION]: { sessionID: session.id } },
  }));
}

/** The last answer the transcript holds. */
async function lastAnswer(adapter: Adapter, session: SessionState): Promise<{ id: string; text: string } | undefined> {
  const response = await adapter.host.client.session.messages({ path: { id: session.id } }).catch(() => undefined);
  const rows = response?.data ?? [];
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (row.info.role !== "assistant") continue;
    const text = texts([{ parts: row.parts.filter((part) => part.type === "text" && !part.synthetic) }]).join("\n");
    if (text) return { id: row.info.id, text };
  }
  return undefined;
}
