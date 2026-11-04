// Tools: tool.before and tool.after around the execute hooks, tool.progress and
// failures from the bus (tool.execute.after does not fire on an error), and the
// permission prompt answered through OpenCode's reply API.
import type { Hooks as PluginHooks } from "@opencode-ai/plugin";
import type { Event as BusEvent } from "@opencode-ai/sdk";
import { Permission, state } from "agenthooksprotocol/client";
import { type Adapter, type CallState, type SessionState, denial, eventId, flow, injections } from "../adapter.js";
import { json, message, texts, type TextPart } from "../../shared/content.js";
import { connection } from "../../shared/mcp.js";
import { toolResult, type NativePart } from "../media.js";

const TASK_TOOL = "task";

/** How OpenCode names an MCP server in its tools' names. */
function sanitized(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function descriptor(adapter: Adapter, name: string) {
  for (const [server, config] of adapter.mcp) {
    const prefix = `${sanitized(server)}_`;
    if (!name.startsWith(prefix)) continue;
    return {
      name,
      origin: "mcp" as const,
      path: "mcp" as const,
      toolMcp: {
        provenance: "inferred" as const,
        server: { id: server, name: server },
        toolName: name.slice(prefix.length),
        connection: json<never>(connection(config)),
      },
    };
  }
  return { name, origin: "native" as const, path: "native" as const };
}

/** Replace an object's contents: OpenCode runs the tool with this object, and a
 * new one in `output.args` would be ignored. */
function replaceInPlace(target: Record<string, unknown>, value: Record<string, unknown>): void {
  for (const key of Object.keys(target)) if (!(key in value)) delete target[key];
  Object.assign(target, value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function base(adapter: Adapter, session: SessionState, call: CallState) {
  return {
    callId: call.id,
    ...descriptor(adapter, call.name),
    ...adapter.scope(session),
    ...(call.beforeEventId ? { parentEventId: call.beforeEventId } : {}),
  };
}

type AfterFields = {
  outcome: "ok" | "error" | "denied" | "cancelled" | "timeout";
  execution: { status: "executed" } | { status: "skipped"; reason: "policy" | "cancelled" };
  items: unknown[];
  error?: { class: string; message: string };
};

async function after(adapter: Adapter, session: SessionState, call: CallState, fields: AfterFields) {
  call.afterSent = true;
  const hooks = await adapter.client("tool.after");
  if (!hooks) return undefined;
  const result = await hooks.toolAfter(
    { ...base(adapter, session, call), input: call.input, ...fields } as Parameters<NonNullable<Adapter["hooks"]>["toolAfter"]>[0],
    { initialState: state.initial(Permission.None) },
  );
  adapter.report(result);
  return result;
}

export function toolHooks(adapter: Adapter): Pick<PluginHooks, "tool.execute.before" | "tool.execute.after"> {
  return {
    "tool.execute.before": async (input, output) => {
      const session = await adapter.session(input.sessionID);
      const args = (output.args ?? {}) as Record<string, unknown>;
      const call: CallState = { id: input.callID, name: input.tool, input: args, sessionID: input.sessionID, context: [] };
      adapter.calls.set(input.callID, call);
      if (input.tool === TASK_TOOL && typeof args.subagent_type === "string") call.awaitingChild = args.subagent_type;
      const hooks = await adapter.client("tool.before");
      if (!hooks) return;
      const result = await hooks.toolBefore(
        { callId: call.id, ...descriptor(adapter, call.name), ...adapter.scope(session), input: json(args) },
        { initialState: state.initial(Permission.None) },
      );
      adapter.report(result);
      const id = eventId(result);
      if (id) call.beforeEventId = id;
      const refused = denial(result);
      if (refused !== undefined) {
        await after(adapter, session, call, { outcome: "denied", execution: { status: "skipped", reason: "policy" }, items: [] });
        adapter.calls.delete(call.id);
        // The model reads this as the tool's error.
        throw new Error(refused);
      }
      call.context.push(...injections(result));
      if ((result.state as { permission?: string }).permission === Permission.Allow) call.allowed = true;
      const rewritten = (result.event as { tool?: { input?: unknown } }).tool?.input;
      if (rewritten && typeof rewritten === "object" && !sameJson(rewritten, args)) {
        replaceInPlace(args, rewritten as Record<string, unknown>);
        call.input = args;
      }
    },

    "tool.execute.after": async (input, output) => {
      const call = adapter.calls.get(input.callID);
      const session = await adapter.session(input.sessionID);
      const known: CallState = call ?? { id: input.callID, name: input.tool, input: (input.args ?? {}) as Record<string, unknown>, sessionID: input.sessionID, context: [] };
      // MCP results reach this hook in MCP's own shape, whatever the types say.
      const raw = output as unknown as { output?: string; attachments?: { mime?: string; url?: string }[]; content?: McpContent[] };
      const original = raw.content ? mcpText(raw.content) : raw.output ?? "";
      const media = raw.content ? mcpMedia(raw.content) : raw.attachments ?? [];
      const result = await after(adapter, session, known, {
        outcome: "ok",
        execution: { status: "executed" },
        items: [toolResult(`${known.id}:result`, original, media)],
      });
      const effective = result ? texts((result.event as { items?: unknown[] }).items).join("\n") : original;
      const context = [...known.context, ...(result ? injections(result) : [])];
      adapter.calls.delete(known.id);
      const text = [effective, ...context].filter(Boolean).join("\n\n");
      if (text === original) return;
      if (raw.content) raw.content.splice(0, raw.content.length, { type: "text", text }, ...raw.content.filter((item) => item.type !== "text"));
      else raw.output = text;
    },
  };
}

type McpContent = { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string } };

function mcpText(content: readonly McpContent[]): string {
  return content.flatMap((item) => item.text ?? item.resource?.text ?? []).join("\n");
}

function mcpMedia(content: readonly McpContent[]): { mime?: string; url?: string }[] {
  return content.flatMap((item) =>
    item.data !== undefined && item.mimeType ? [{ mime: item.mimeType, url: `data:${item.mimeType};base64,${item.data}` }] : []);
}

type Asked = {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  always?: string[];
  metadata?: Record<string, unknown>;
  tool?: { messageID: string; callID: string };
};

export async function onToolEvent(adapter: Adapter, event: BusEvent): Promise<void> {
  const type = event.type as string;
  if (type === "permission.asked") {
    const asked = event.properties as unknown as Asked;
    const session = await adapter.session(asked.sessionID);
    void adapter.enqueue(session, () => permissionAsked(adapter, session, asked));
    return;
  }
  if (type === "permission.replied") {
    const replied = event.properties as unknown as { sessionID: string; requestID?: string; permissionID?: string; reply?: string; response?: string };
    const session = await adapter.session(replied.sessionID);
    void adapter.enqueue(session, () => permissionReplied(adapter, session, replied.requestID ?? replied.permissionID ?? "", replied.reply ?? replied.response ?? "reject"));
    return;
  }
  if (event.type !== "message.part.updated") return;
  const part = event.properties.part as unknown as NativePart & { sessionID: string };
  if (part.type !== "tool" || !part.callID) return;
  const call = adapter.calls.get(part.callID);
  if (!call) return;
  const state_ = part.state as { status?: string; error?: string; metadata?: { output?: unknown; interrupted?: unknown } } | undefined;
  const session = await adapter.session(part.sessionID);
  if (state_?.status === "running" && typeof state_.metadata?.output === "string" && state_.metadata.output) {
    const output = state_.metadata.output;
    void adapter.enqueue(session, async () => {
      const hooks = await adapter.client("tool.progress");
      if (!hooks) return;
      adapter.report(await hooks.toolProgress({
        ...base(adapter, session, call),
        input: json(call.input),
        partialOutput: message(`${call.id}:progress`, "tool", output) as never,
        backgrounded: false,
      }));
    });
    return;
  }
  if (state_?.status !== "error" || call.afterSent) return;
  call.afterSent = true;
  void adapter.enqueue(session, async () => {
    adapter.calls.delete(call.id);
    // Whatever tool.before had for the model has no result to ride on.
    if (session.turn) session.turn.context.push(...call.context);
    const interrupted = Boolean(state_.metadata?.interrupted);
    if (call.rejected) return after(adapter, session, call, { outcome: "denied", execution: { status: "skipped", reason: "policy" }, items: [] });
    if (interrupted) return after(adapter, session, call, { outcome: "cancelled", execution: { status: "skipped", reason: "cancelled" }, items: [] });
    return after(adapter, session, call, {
      outcome: "error",
      execution: { status: "executed" },
      items: [],
      error: { class: "ToolError", message: state_.error ?? "The tool failed" },
    });
  });
}

async function permissionAsked(adapter: Adapter, session: SessionState, asked: Asked): Promise<void> {
  const call = (asked.tool && adapter.calls.get(asked.tool.callID)) || undefined;
  const known: CallState = call ?? {
    id: asked.tool?.callID ?? `permission:${asked.id}`,
    name: asked.permission,
    input: asked.metadata ?? {},
    sessionID: asked.sessionID,
    context: [],
  };
  adapter.permissions.set(asked.id, known);

  const attention = await adapter.client("user.attention");
  if (attention && !known.allowed) {
    adapter.report(await attention.userAttention({
      ...adapter.scope(session),
      attention: {
        kind: "permission",
        message: [{ id: `${asked.id}:message`, kind: "text", mediaType: "text/plain", selection: "body", text: (asked.patterns ?? []).join(", ") || asked.permission } satisfies TextPart],
        title: [{ id: `${asked.id}:title`, kind: "text", mediaType: "text/plain", selection: "body", text: `Permission: ${asked.permission}` } satisfies TextPart],
      },
    }));
  }

  // tool.before allowed the call: it answers its own prompt.
  if (known.allowed) return reply(adapter, asked, known, "once");

  const hooks = await adapter.client("tool.permission.request");
  if (!hooks) return;
  const result = await hooks.toolPermissionRequest({
    callId: known.id,
    ...(call ? {} : { callSynthesized: true }),
    ...descriptor(adapter, known.name),
    ...adapter.scope(session),
    input: json(known.input),
    suggestions: (asked.always ?? []).map((pattern) => ({ permission: asked.permission, pattern, action: "allow" })),
    sandboxBypass: false,
    ...(known.beforeEventId ? { parentEventId: known.beforeEventId } : {}),
  }, { initialState: state.initial(Permission.None) });
  adapter.report(result);
  const stop = flow(result);
  if (denial(result) !== undefined || stop?.operation === "stop") {
    known.rejected = true;
    await reply(adapter, asked, known, "reject");
    if (stop?.operation === "stop") await adapter.host.client.session.abort({ path: { id: session.id } }).catch(() => {});
    return;
  }
  if ((result.state as { permission?: string }).permission === Permission.Allow) await reply(adapter, asked, known, "once");
  // No decision: the prompt stays with the person.
}

async function reply(adapter: Adapter, asked: Asked, call: CallState, response: "once" | "reject"): Promise<void> {
  call.decidedBy = "hook";
  await adapter.host.client.postSessionIdPermissionsPermissionId({
    path: { id: asked.sessionID, permissionID: asked.id },
    body: { response },
  }).catch((error: unknown) => adapter.log("error", `could not answer a permission request: ${String(error)}`));
}

async function permissionReplied(adapter: Adapter, session: SessionState, id: string, response: string): Promise<void> {
  const call = adapter.permissions.get(id);
  if (!call) return;
  adapter.permissions.delete(id);
  if (response === "reject") call.rejected = true;
  const hooks = await adapter.client("tool.permission.resolved");
  if (!hooks) return;
  adapter.report(await hooks.toolPermissionResolved({
    ...base(adapter, session, call),
    input: json(call.input),
    decision: response === "reject" ? "deny" : "allow",
    decidedBy: call.decidedBy ?? "user",
  }));
}
