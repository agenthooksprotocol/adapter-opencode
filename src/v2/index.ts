// The OpenCode 2 flavour: hooks registered on the plugin context, with an event
// stream. Hooks are awaited and can refuse; the stream only observes.
import { Hooks, Permission, state } from "agenthooksprotocol/client";
import { loadRegistration } from "../shared/config.js";
import { asText, json, message, textPart, texts, type Message, type Part, type Role } from "../shared/content.js";
import { createHooks, EXTENSION, MAX_CONTINUATIONS } from "../shared/delivery.js";
import { denial, describe, eventId, flow, injections, messages, type AnyResult } from "../shared/effects.js";
import { fileParts } from "../shared/media.js";
import { connection } from "../shared/mcp.js";
import { capabilities, gaps } from "./capabilities.js";
import type { BusEvent, CompactionEvent, ContentPart, Context, ContextEvent, ContextRow, Evaluation, IdleEvent, PromptEvent, RequestMessage, ToolAfter, ToolBefore, ToolContent } from "./host.js";

const SUBAGENT_TOOL = "subagent";
const TODO_TOOL = "todowrite";

interface Turn {
  id: string;
  continuationCount: number;
  attempts: number;
  parentEventId?: string;
  /** The idle hook let it end: the execution's event is all that is left. */
  finished?: boolean;
  error?: { class: string; message: string };
}

interface SessionState {
  id: string;
  rootId: string;
  /** Set on a subagent's session. */
  agentType?: string;
  parentEventId?: string;
  model?: { id: string; provider: string };
  turn?: Turn;
  queue: Promise<unknown>;
  started?: Promise<void>;
  startContext: string[];
  /** A queued `/compact` is what the next compaction hook is running. */
  manualCompaction?: boolean;
  ended?: boolean;
  todos: Map<string, string>;
  /** Finished calls by assistant message, for tool.batch.after. */
  batches: Map<string, { descriptor: Descriptor; input: Record<string, unknown>; outcome: "ok" | "error" | "denied" | "cancelled"; id: string }[]>;
}

type Descriptor = { name: string; origin: "native" | "mcp"; path: "native" | "mcp"; toolMcp?: ReturnType<typeof mcpDescriptor> };

interface CallState {
  /** The id AHP knows: OpenCode's own, unless code mode reused it. */
  id: string;
  /** The id OpenCode gives the call. */
  rawId: string;
  synthesized?: boolean;
  /** The event of the execute call that made this one. */
  parentEventId?: string;
  descriptor: Descriptor;
  name: string;
  input: Record<string, unknown>;
  sessionID: string;
  messageID?: string;
  beforeEventId?: string;
  decision?: "allow" | "ask";
  decidedBy?: "hook" | "policy";
  rejected?: boolean;
  /** An agent name while a subagent call waits for its child's first prompt. */
  awaitingChild?: string;
}

/** How OpenCode 2 turns a server's name into its tools' namespace. */
function namespaceOf(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mcpDescriptor(server: string, toolName: string, config: Record<string, unknown> | undefined) {
  return {
    provenance: "runtime" as const,
    server: { id: server, name: server },
    toolName,
    connection: json<never>(connection(config)),
  };
}

/** A request or transcript message's content as canonical parts. Text keeps a
 * positional id, for a rewrite to find it again. */
function partsOf(id: string, content: string | readonly ContentPart[] | undefined): Part[] {
  if (typeof content === "string") return [textPart(`${id}#0`, content)];
  return (content ?? []).flatMap((part, index): Part[] => {
    const partId = `${id}#${index}`;
    if (part.type === "text") return [textPart(partId, part.text ?? "")];
    if (part.type === "reasoning") return [textPart(partId, part.text ?? "", "reasoning")];
    if (part.type === "media" && part.mediaType) {
      const data = part.data;
      const url = typeof data === "string" ? (/^[a-z]+:/.test(data) ? data : `data:${part.mediaType};base64,${data}`) : "";
      return fileParts(partId, part.mediaType, url);
    }
    const category = part.type === "tool-call" ? "tool_call" : part.type === "tool-result" ? "tool_result" : part.type;
    return [textPart(partId, asText(part), category)];
  });
}

function toolText(content: string | readonly ToolContent[] | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

function requestId(row: RequestMessage, index: number, attempt: string): string {
  return row.id ?? `${attempt}:message:${index}`;
}

/** Apply an effective request to OpenCode's own: the same rule as a modified
 * prompt. A changed text part keeps its place, a removed one goes, and what the
 * conversation lacks rides on its last user message. */
function applyRequest(rows: RequestMessage[], effective: readonly { id: string; role?: string; parts?: Part[] }[] | undefined, attempt: string): void {
  if (!effective) return;
  const ids = rows.map((row, index) => requestId(row, index, attempt));
  const byId = new Map(effective.map((item) => [item.id, item]));
  const added = effective.filter((item) => !ids.includes(item.id) && item.role !== "system").flatMap((item) => texts([item]));
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    const id = ids[index]!;
    const item = byId.get(id);
    if (!item) {
      rows.splice(index, 1);
      continue;
    }
    const parts = new Map((item.parts ?? []).map((part) => [part.id, part as { text?: string }]));
    if (typeof row.content === "string") {
      row.content = parts.get(`${id}#0`)?.text ?? row.content;
      continue;
    }
    for (let at = row.content.length - 1; at >= 0; at--) {
      const part = row.content[at]!;
      if (part.type !== "text" && part.type !== "reasoning") continue;
      const next = parts.get(`${id}#${at}`);
      if (!next) row.content.splice(at, 1);
      else if (typeof next.text === "string") part.text = next.text;
    }
  }
  const target = rows.findLast((row) => row.role === "user");
  if (!target || !added.length) return;
  if (typeof target.content === "string") target.content = [{ type: "text", text: target.content }];
  for (const text of added) target.content.push({ type: "text", text });
}

class Adapter {
  hooks: Hooks | undefined;
  readonly sessions = new Map<string, SessionState>();
  /** Calls in flight by OpenCode's id: code mode's calls share their execute's. */
  readonly calls = new Map<string, CallState[]>();
  /** MCP servers' configuration by name, as this plugin can see it. */
  mcp = new Map<string, Record<string, unknown>>();
  /** Each tool's namespace, refreshed when a tool is not in it. */
  #namespaces = new Map<string, string | undefined>();
  #delegated = 0;
  /** Calls with a permission prompt open, by the request's id. */
  readonly permissions = new Map<string, CallState>();
  readonly #ready: Promise<void>;
  readonly #resolving = new Map<string, Promise<SessionState>>();
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(readonly ctx: Context) {
    // Discovery may wait on backends: plugin load must not.
    this.#ready = this.#start().catch((error) => {
      this.hooks = undefined;
      this.log(`not started: ${describe(error)}`);
    });
  }

  async #start(): Promise<void> {
    const directory = this.ctx.location.directory;
    const { registration, sources, diagnostics } = loadRegistration(process.env, directory, this.ctx.location.project?.directory ?? directory);
    for (const line of diagnostics) this.log(line);
    if (!registration) return;
    const hooks = createHooks(registration, this.ctx.app.version, capabilities, gaps);
    await hooks.initialized;
    for (const issue of hooks.initializationDiagnostics ?? []) this.log(`initialization: ${describe(issue)}`);
    this.hooks = hooks;
    this.log(`delivering to ${registration.hooks.length} backend(s) from ${sources.map((source) => source.path).join(", ")}`);
  }

  /** A tool's origin: an MCP server's tools carry its name as their namespace. */
  async describe(name: string): Promise<Descriptor> {
    if (!this.#namespaces.has(name)) {
      const tools = await this.ctx.tool.list().catch(() => []);
      this.#namespaces = new Map(tools.map((tool) => [tool.id, tool.options?.namespace]));
      if (!this.#namespaces.has(name)) this.#namespaces.set(name, undefined);
    }
    const namespace = this.#namespaces.get(name);
    if (!namespace || namespace === "opencode" || !name.startsWith(`${namespace}_`) || !this.#isServer(namespace))
      return { name, origin: "native", path: "native" };
    const server = [...this.mcp.keys()].find((candidate) => namespaceOf(candidate) === namespace) ?? namespace;
    return { name, origin: "mcp", path: "mcp", toolMcp: mcpDescriptor(server, name.slice(namespace.length + 1), this.mcp.get(server)) };
  }

  #isServer(namespace: string): boolean {
    return [...this.mcp.keys()].some((candidate) => namespaceOf(candidate) === namespace);
  }

  /** Start tracking a call. One made inside a call still in flight under the same
   * id is code mode's: it gets an id of its own and hangs off that call. */
  open(event: { id: string; tool: string; sessionID: string; messageID?: string }, input: Record<string, unknown>, descriptor: Descriptor): CallState {
    const stack = this.calls.get(event.id) ?? [];
    const outer = stack.at(-1);
    const call: CallState = {
      id: outer ? `${event.id}:${event.tool}:${++this.#delegated}` : event.id,
      rawId: event.id,
      descriptor,
      name: event.tool,
      input,
      sessionID: event.sessionID,
      ...(event.messageID ? { messageID: event.messageID } : {}),
      ...(outer ? { synthesized: true } : {}),
      ...(outer?.beforeEventId ? { parentEventId: outer.beforeEventId } : {}),
    };
    stack.push(call);
    this.calls.set(event.id, stack);
    return call;
  }

  /** The call a hook or event means: the innermost, or the one with this tool's name. */
  find(rawId: string, tool?: string): CallState | undefined {
    const stack = this.calls.get(rawId) ?? [];
    return tool ? stack.findLast((call) => call.name === tool) : stack.at(-1);
  }

  closeCall(call: CallState): void {
    const stack = this.calls.get(call.rawId) ?? [];
    const rest = stack.filter((entry) => entry !== call);
    if (rest.length) this.calls.set(call.rawId, rest);
    else this.calls.delete(call.rawId);
  }

  /** A server plugin's only output: OpenCode's server log. */
  log(line: string): void {
    console.error(`[agent-hooks-protocol] ${line}`);
  }

  async client(type: string): Promise<Hooks | undefined> {
    await this.#ready;
    const hooks = this.hooks;
    return hooks?.subscribes(type as never) ? hooks : undefined;
  }

  session(id: string): Promise<SessionState> {
    const known = this.sessions.get(id);
    if (known) return Promise.resolve(known);
    let pending = this.#resolving.get(id);
    if (!pending) {
      pending = this.#resolve(id).finally(() => this.#resolving.delete(id));
      this.#resolving.set(id, pending);
    }
    return pending;
  }

  async #resolve(id: string): Promise<SessionState> {
    const info = await this.ctx.session.get({ sessionID: id }).catch(() => undefined);
    const parent = info?.parentID ? await this.session(info.parentID) : undefined;
    const state: SessionState = {
      id,
      rootId: parent?.rootId ?? id,
      queue: Promise.resolve(),
      startContext: [],
      todos: new Map(),
      batches: new Map(),
      ...(parent ? { agentType: info?.agent ?? "subagent" } : {}),
      ...(info?.model ? { model: { id: info.model.id, provider: info.model.providerID } } : parent?.model ? { model: parent.model } : {}),
    };
    this.sessions.set(id, state);
    return state;
  }

  enqueue(state: SessionState, work: () => Promise<unknown>): Promise<unknown> {
    const run = state.queue.then(work).catch((error) => this.log(`event failed: ${describe(error)}`));
    state.queue = run;
    return this.track(run);
  }

  track<T>(work: Promise<T>): Promise<T> {
    this.#inFlight.add(work);
    void work.finally(() => this.#inFlight.delete(work)).catch(() => {});
    return work;
  }

  async close(): Promise<void> {
    await this.#ready;
    while (this.#inFlight.size) await Promise.allSettled([...this.#inFlight]);
    const hooks = this.hooks;
    this.hooks = undefined;
    await hooks?.close();
  }

  sessionObject(state: SessionState) {
    return {
      id: state.rootId,
      cwd: this.ctx.location.directory,
      ...(state.model ? { model: `${state.model.provider}/${state.model.id}` } : {}),
      ...(state.agentType ? { agent: { id: state.id, type: state.agentType } } : {}),
    };
  }

  scope(state: SessionState) {
    return { session: this.sessionObject(state), ...(state.turn ? { turn: { id: state.turn.id } } : {}) };
  }

  report(result: AnyResult): void {
    void result.content?.close().catch(() => {});
    for (const diagnostic of result.diagnostics)
      if (diagnostic.syntheticDenial) this.log(`${diagnostic.backendId} ${diagnostic.phase}: ${diagnostic.code} (denied by failure policy)`);
    // No surface shows a person these; `message` is not advertised.
    for (const text of messages(result)) this.log(text);
  }

  /** Context the model keeps: a durable message that starts no work of its own. */
  async inject(sessionID: string, context: readonly string[]): Promise<void> {
    for (const text of context) await this.ctx.session.synthetic({ sessionID, text, resume: false });
  }
}

function attempt(session: SessionState) {
  return { id: `${session.turn!.id}:${session.turn!.attempts}`, number: 1, synthesized: true };
}

function modelOf(ref: { id: string; providerID: string }) {
  return { id: ref.id, provider: ref.providerID };
}

async function startSession(adapter: Adapter, session: SessionState): Promise<void> {
  if (session.agentType) return;
  session.started ??= (async () => {
    const hooks = await adapter.client("session.start");
    if (!hooks) return;
    const rows = await adapter.ctx.session.context({ sessionID: session.id }).catch(() => []);
    const result = await hooks.sessionStart({
      session: adapter.sessionObject(session),
      trigger: rows.length ? "resume" : "startup",
      permissionMode: "default",
      items: [],
      gaps: [{ path: "items", reason: "OpenCode composes startup instructions into each model request; they are reported on model.request.before" }],
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    session.startContext.push(...injections(result));
  })();
  return adapter.track(session.started);
}

async function endTurn(adapter: Adapter, session: SessionState, outcome: "completed" | "failed" | "cancelled", error?: { class: string; message: string }): Promise<void> {
  const turn = session.turn;
  if (!turn) return;
  session.turn = undefined;
  const hooks = await adapter.client("turn.end");
  if (!hooks) return;
  const answer = await lastAnswer(adapter, session);
  const failure = error ?? turn.error;
  adapter.report(await hooks.turnEnd({
    session: adapter.sessionObject(session),
    turn: { id: turn.id },
    items: answer ? [message(answer.id, "assistant", answer.text)] : [],
    continuationCount: turn.continuationCount,
    outcome: failure && outcome !== "cancelled" ? "failed" : outcome,
    ...(failure && outcome !== "cancelled" ? { error: failure } : {}),
    ...(turn.parentEventId ? { parentEventId: turn.parentEventId } : {}),
    extensions: { [EXTENSION]: { sessionID: session.id } },
  }));
}

async function lastAnswer(adapter: Adapter, session: SessionState): Promise<{ id: string; text: string } | undefined> {
  const rows = await adapter.ctx.session.context({ sessionID: session.id }).catch((): readonly ContextRow[] => []);
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (row.type !== "assistant") continue;
    const text = (row.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
    if (text) return { id: row.id, text };
  }
  return undefined;
}

/** The subagent call a child's first prompt belongs to. */
function claimSubagentCall(adapter: Adapter, session: SessionState): string | undefined {
  for (const call of [...adapter.calls.values()].flat()) {
    if (!call.awaitingChild || call.awaitingChild !== session.agentType) continue;
    if (adapter.sessions.get(call.sessionID)?.rootId !== session.rootId) continue;
    call.awaitingChild = undefined;
    return call.beforeEventId;
  }
  return undefined;
}

async function onPrompt(adapter: Adapter, event: PromptEvent): Promise<void> {
  const session = await adapter.session(event.sessionID);
  await session.queue;
  await startSession(adapter, session);
  // The last turn has let go, and only its execution's event is outstanding.
  if (session.turn?.finished) await endTurn(adapter, session, "completed");
  const id = event.messageID;
  const item: Message = message(id, "user", event.prompt.text);
  for (const [index, file] of (event.prompt.files ?? []).entries())
    item.parts.push(...fileParts(`${id}:media:${index}`, "application/octet-stream", file.uri));
  const rewrite = (effective: { parts?: Part[] } | undefined) => {
    const text = effective ? texts([effective]).join("\n") : undefined;
    if (text !== undefined) event.prompt.text = text;
  };

  if (session.turn) {
    const hooks = await adapter.client("user.message.inbound");
    if (!hooks) return;
    const result = await hooks.userMessageInbound({
      ...adapter.scope(session),
      message: { channel: "prompt", sender: "user", messages: [item as never] },
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    const refused = denial(result);
    if (refused !== undefined) throw new Error(refused);
    rewrite((result.event as { message?: { messages?: { parts?: Part[] }[] } }).message?.messages?.[0]);
    return;
  }

  const child = session.agentType ? claimSubagentCall(adapter, session) : undefined;
  if (child) session.parentEventId = child;
  const context = session.startContext.splice(0);
  const hooks = await adapter.client("turn.start");
  if (hooks) {
    const result = await hooks.turnStart({
      turn: { id },
      session: adapter.sessionObject(session),
      trigger: session.agentType ? "external" : "user",
      items: [item as never],
      ...(session.parentEventId ? { parentEventId: session.parentEventId } : {}),
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    const refused = denial(result);
    if (refused !== undefined) {
      session.startContext.push(...context);
      throw new Error(refused);
    }
    rewrite((result.event as { items?: { parts?: Part[] }[] }).items?.[0]);
    context.push(...injections(result));
  }
  await adapter.inject(session.id, context);
  session.turn = { id, continuationCount: 0, attempts: 0, ...(session.parentEventId ? { parentEventId: session.parentEventId } : {}) };
}

async function onContext(adapter: Adapter, event: ContextEvent): Promise<void> {
  const session = await adapter.session(event.sessionID);
  session.model = modelOf(event.model);
  const turn = session.turn;
  if (!turn) return;
  turn.attempts += 1;
  const hooks = await adapter.client("model.request.before");
  if (!hooks) return;
  const current = attempt(session);
  const system = event.system.flatMap((part, index) => (part.text ? [textPart(`${current.id}:system:${index}`, part.text, "system")] : []));
  const items: Message[] = [
    ...(system.length ? [{ id: `${current.id}:system`, role: "system" as const, parts: system, synthesized: true }] : []),
    ...event.messages.map((row, index) => {
      const id = requestId(row, index, current.id);
      return { id, role: row.role as Role, parts: partsOf(id, row.content), ...(row.id ? {} : { synthesized: true }) };
    }),
  ];
  const result = await hooks.modelRequestBefore({
    ...adapter.scope(session),
    model: modelOf(event.model),
    attempt: current,
    params: json({ model: event.model.id, agent: event.agent, ...event.options, tools: Object.keys(event.tools) }),
    items: items as never,
  }, { initialState: state.initial(Permission.None) });
  adapter.report(result);
  const refused = denial(result);
  if (refused !== undefined) {
    turn.error = { class: "Denied", message: refused };
    throw new Error(refused);
  }
  applyRequest(event.messages, (result.event as { items?: { id: string; role?: string; parts?: Part[] }[] }).items, current.id);
  for (const text of injections(result)) event.system.push({ type: "text", text });
}

async function onCompaction(adapter: Adapter, event: CompactionEvent): Promise<void> {
  const session = await adapter.session(event.sessionID);
  const trigger = session.manualCompaction ? "manual" : "auto";
  session.manualCompaction = false;
  const hooks = await adapter.client("context.compact.before");
  if (!hooks) return;
  const result = await hooks.contextCompactBefore({
    ...adapter.scope(session),
    trigger,
    items: event.messages.map((row, index) => {
      const id = requestId(row, index, `compact:${session.id}`);
      return { id, role: row.role as Role, parts: partsOf(id, row.content), ...(row.id ? {} : { synthesized: true }) };
    }) as never,
    instructions: [],
  }, { initialState: state.initial(Permission.None) });
  adapter.report(result);
  const refused = denial(result);
  if (refused !== undefined) throw new Error(refused);
  const candidate = (result.state as { candidate?: { value: unknown } | null }).candidate;
  if (candidate) {
    // A compaction's `return` carries text parts, not messages.
    event.result = { summary: typeof candidate.value === "string" ? candidate.value : texts([{ parts: candidate.value }]).join("\n") };
    return;
  }
  for (const text of texts([{ parts: (result.event as { instructions?: Part[] }).instructions ?? [] }]))
    event.system.push({ type: "text", text });
}

/** Just before the session goes idle: another pass runs in the same execution. */
async function onIdle(adapter: Adapter, event: IdleEvent): Promise<void> {
  const session = await adapter.session(event.sessionID);
  const turn = session.turn;
  if (!turn) return;
  // Its own background work wakes it, and this hook runs again.
  if (event.background.some((work) => work.sessionID === session.id)) return;
  const hooks = await adapter.client("turn.finish.before");
  if (hooks) {
    const answer = await lastAnswer(adapter, session);
    const continuable = turn.continuationCount < MAX_CONTINUATIONS;
    const result = await hooks.turnFinishBefore({
      session: adapter.sessionObject(session),
      turn: { id: turn.id },
      items: answer ? [message(answer.id, "assistant", answer.text)] : [],
      continuationCount: turn.continuationCount,
      outcome: "completed",
      ...(turn.parentEventId ? { parentEventId: turn.parentEventId } : {}),
    }, {
      initialState: state.initial(Permission.None),
      ...(continuable ? {} : { capabilities: { effects: ["flow"], flow: { operations: ["stop"] } } as never }),
    });
    adapter.report(result);
    const decision = flow(result);
    if (decision?.operation === "continue" && continuable) {
      turn.continuationCount += 1;
      await adapter.ctx.session.synthetic({ sessionID: session.id, text: decision.instruction ?? "Continue: an AHP hook asked for another pass." });
      return;
    }
  }
  turn.finished = true;
}

/** What every event about a call says about it. */
function callFields(call: CallState) {
  return { callId: call.id, ...(call.synthesized ? { callSynthesized: true } : {}), ...call.descriptor };
}

async function toolAfter(adapter: Adapter, session: SessionState, call: CallState, fields: Record<string, unknown>) {
  const hooks = await adapter.client("tool.after");
  if (!hooks) return undefined;
  const result = await hooks.toolAfter({
    ...callFields(call),
    ...adapter.scope(session),
    input: json(call.input),
    ...(call.beforeEventId ? { parentEventId: call.beforeEventId } : {}),
    ...fields,
  } as Parameters<Hooks["toolAfter"]>[0], { initialState: state.initial(Permission.None) });
  adapter.report(result);
  return result;
}

function finishCall(session: SessionState, call: CallState, outcome: "ok" | "error" | "denied" | "cancelled"): void {
  if (!call.messageID) return;
  const batch = session.batches.get(call.messageID) ?? [];
  batch.push({ descriptor: call.descriptor, input: call.input, outcome, id: call.id });
  session.batches.set(call.messageID, batch);
}

async function onToolBefore(adapter: Adapter, event: ToolBefore): Promise<void> {
  const session = await adapter.session(event.sessionID);
  const input = record(event.input);
  const call = adapter.open(event, input, await adapter.describe(event.tool));
  if (event.tool === SUBAGENT_TOOL && typeof input.agent === "string") call.awaitingChild = input.agent;
  const hooks = await adapter.client("tool.before");
  if (!hooks) return;
  const result = await hooks.toolBefore(
    { ...callFields(call), ...adapter.scope(session), input: json(input), ...(call.parentEventId ? { parentEventId: call.parentEventId } : {}) },
    { initialState: state.initial(Permission.None) },
  );
  adapter.report(result);
  const id = eventId(result);
  if (id) call.beforeEventId = id;
  const refused = denial(result);
  if (refused !== undefined) {
    await toolAfter(adapter, session, call, { outcome: "denied", execution: { status: "skipped", reason: "policy" }, items: [] });
    finishCall(session, call, "denied");
    adapter.closeCall(call);
    throw new Error(refused);
  }
  await adapter.inject(session.id, injections(result));
  const permission = (result.state as { permission?: string }).permission;
  if (permission === Permission.Allow) call.decision = "allow";
  if (permission === Permission.Ask) call.decision = "ask";
  const rewritten = (result.event as { tool?: { input?: unknown } }).tool?.input;
  if (rewritten && typeof rewritten === "object" && JSON.stringify(rewritten) !== JSON.stringify(input)) {
    event.input = rewritten;
    call.input = rewritten as Record<string, unknown>;
  }
}

async function onToolAfter(adapter: Adapter, event: ToolAfter): Promise<void> {
  const session = await adapter.session(event.sessionID);
  const call = adapter.find(event.id, event.tool) ?? adapter.open(event, record(event.input), await adapter.describe(event.tool));
  adapter.closeCall(call);
  call.input = record(event.input);
  if (event.status === "error") {
    const blocked = call.rejected || /^Permission\./.test(event.error.error?._tag ?? "");
    await toolAfter(adapter, session, call, blocked
      ? { outcome: "denied", execution: { status: "skipped", reason: "policy" }, items: [] }
      : { outcome: "error", execution: { status: "executed" }, items: [], error: { class: "ToolError", message: event.error.message } });
    finishCall(session, call, blocked ? "denied" : "error");
    return;
  }
  finishCall(session, call, "ok");
  const original = toolText(event.result.content);
  const content = typeof event.result.content === "string" ? [] : event.result.content ?? [];
  const item: Message = message(`${call.id}:result`, "tool", original);
  for (const [index, file] of content.entries())
    if (file.type === "file") item.parts.push(...fileParts(`${call.id}:result:media:${index}`, file.mime, file.uri));
  const result = await toolAfter(adapter, session, call, { outcome: "ok", execution: { status: "executed" }, items: [item] });
  if (call.name === TODO_TOOL) void adapter.enqueue(session, () => todosChanged(adapter, session, call));
  if (!result) return;
  const effective = texts((result.event as { items?: unknown[] }).items).join("\n");
  if (effective !== original)
    event.result = { ...event.result, content: [{ type: "text", text: effective }, ...content.filter((file) => file.type !== "text")] };
  await adapter.inject(session.id, injections(result));
}

async function resolved(adapter: Adapter, session: SessionState, call: CallState, decision: "allow" | "deny", decidedBy: string): Promise<void> {
  const hooks = await adapter.client("tool.permission.resolved");
  if (!hooks) return;
  adapter.report(await hooks.toolPermissionResolved({
    ...callFields(call),
    ...adapter.scope(session),
    input: json(call.input),
    decision,
    decidedBy,
    ...(call.beforeEventId ? { parentEventId: call.beforeEventId } : {}),
  }));
}

/** Rules have spoken: tool.before's decision and a backend's answer go on top. A
 * configured deny never reaches this hook, so it stands. */
async function onEvaluate(adapter: Adapter, event: Evaluation): Promise<void> {
  const session = await adapter.session(event.sessionID);
  const known = event.source && adapter.find(event.source.id);
  const call: CallState = known ?? {
    id: event.source?.id ?? `permission:${crypto.randomUUID()}`,
    rawId: event.source?.id ?? "",
    synthesized: true,
    descriptor: await adapter.describe(event.action),
    name: event.action,
    input: event.metadata ?? {},
    sessionID: event.sessionID,
  };
  if (call.decision === "allow" && event.effect === "ask") {
    event.effect = "allow";
    call.decidedBy = "hook";
  } else if (call.decision === "ask" && event.effect === "allow") event.effect = "ask";

  if (event.effect === "ask") {
    const hooks = await adapter.client("tool.permission.request");
    if (hooks) {
      const result = await hooks.toolPermissionRequest({
        ...callFields(call),
        ...adapter.scope(session),
        input: json(call.input),
        suggestions: event.resources.map((resource) => ({ action: event.action, resource, effect: "allow" })),
        sandboxBypass: false,
        ...(call.beforeEventId ? { parentEventId: call.beforeEventId } : {}),
      }, { initialState: state.initial(Permission.None) });
      adapter.report(result);
      const stop = flow(result);
      const refused = denial(result);
      if (refused !== undefined || stop?.operation === "stop") {
        event.effect = "deny";
        event.message = refused ?? (stop as { reason: string }).reason;
        call.rejected = true;
        call.decidedBy = "hook";
        if (stop?.operation === "stop") void adapter.track(adapter.ctx.session.interrupt({ sessionID: session.id }).catch(() => {}));
      } else if ((result.state as { permission?: string }).permission === Permission.Allow) {
        event.effect = "allow";
        call.decidedBy = "hook";
      }
    }
  } else {
    call.decidedBy ??= "policy";
  }
  // Still "ask": the prompt is the person's, and permission.replied reports it.
  if (event.effect !== "ask") await resolved(adapter, session, call, event.effect, call.decidedBy ?? "policy");
}

/** Todos have no identity: their text is what stays put between writes. */
async function todosChanged(adapter: Adapter, session: SessionState, call: CallState): Promise<void> {
  const todos = Array.isArray(call.input.todos) ? (call.input.todos as { content: string; status: string }[]) : [];
  const previous = session.todos;
  session.todos = new Map(todos.map((todo) => [todo.content, todo.status]));
  const hooks = await adapter.client("task.change.after");
  if (!hooks) return;
  const send = async (content: string, operation: "create" | "update" | "remove", change: Record<string, string>, prior?: Record<string, string>) => {
    adapter.report(await hooks.taskChangeAfter({
      ...adapter.scope(session),
      task: { id: `todo:${session.id}:${content}`, operation, change, description: content, ...(prior ? { prior } : {}) },
      synthesized: true,
      ...(call.beforeEventId ? { parentEventId: call.beforeEventId } : {}),
    }));
  };
  for (const todo of todos) {
    const before = previous.get(todo.content);
    if (before === undefined) await send(todo.content, "create", { status: todo.status });
    else if (before !== todo.status) await send(todo.content, "update", { status: todo.status }, { status: before });
  }
  for (const [content, status] of previous) if (!session.todos.has(content)) await send(content, "remove", {}, { status });
}

async function stepEnded(adapter: Adapter, session: SessionState, data: Record<string, any>): Promise<void> {
  const messageID = String(data.assistantMessageID);
  const batch = session.batches.get(messageID);
  session.batches.delete(messageID);
  if (!session.turn?.attempts) return;
  const response = await adapter.client("model.response.after");
  if (response) {
    const rows = await adapter.ctx.session.context({ sessionID: session.id }).catch((): readonly ContextRow[] => []);
    const row = rows.find((candidate) => candidate.id === messageID);
    const tokens = data.tokens ?? {};
    adapter.report(await response.modelResponseAfter({
      ...adapter.scope(session),
      model: row?.model ? modelOf(row.model) : session.model ?? { id: "unknown", provider: "unknown" },
      attempt: attempt(session),
      execution: { status: "executed" },
      finishReason: String(data.finish ?? "unknown"),
      items: [{ id: messageID, role: "assistant", parts: partsOf(messageID, row?.content) }] as never,
      usage: {
        kind: "amount",
        scope: "attempt",
        provenance: "provider",
        completeness: "complete",
        inputTokens: tokens.input ?? 0,
        outputTokens: tokens.output ?? 0,
        ...(tokens.cache?.read ? { cacheReadTokens: tokens.cache.read } : {}),
        ...(tokens.cache?.write ? { cacheWriteTokens: tokens.cache.write } : {}),
      },
    }));
  }
  if (!batch?.length) return;
  const hooks = await adapter.client("tool.batch.after");
  if (!hooks) return;
  adapter.report(await hooks.toolBatchAfter({
    ...adapter.scope(session),
    batch: { id: messageID },
    calls: batch.map((call) => {
      const { name, origin, path, toolMcp } = call.descriptor;
      return {
        call: { id: call.id },
        tool: { name, origin, input: json(call.input), ...(toolMcp ? { mcp: toolMcp } : {}) },
        path,
        outcome: call.outcome,
        execution: call.outcome === "denied" ? { status: "skipped" as const, reason: "policy" as const } : { status: "executed" as const },
      };
    }),
  } as Parameters<Hooks["toolBatchAfter"]>[0]));
}

async function endSession(adapter: Adapter, session: SessionState, reason: string, outcome: "completed" | "unknown"): Promise<void> {
  session.ended = true;
  const hooks = await adapter.client("session.end");
  if (hooks) adapter.report(await hooks.sessionEnd({ session: adapter.sessionObject(session), reason, outcome }));
}

async function onBusEvent(adapter: Adapter, event: BusEvent): Promise<void> {
  const data = event.data ?? {};
  if (event.location?.directory && event.location.directory !== adapter.ctx.location.directory && !adapter.sessions.has(data.sessionID)) return;
  if (event.type === "file.edited") {
    const hooks = await adapter.client("file.changed");
    if (hooks) adapter.report(await hooks.fileChanged({ changes: [{ path: String(data.file), operation: "update", agentCaused: true }] }));
    return;
  }
  if (typeof data.sessionID !== "string") return;
  // A session's work is the only thing that needs its tree resolved.
  const session = await adapter.session(data.sessionID);
  const run = (work: () => Promise<unknown>) => void adapter.enqueue(session, work);
  switch (event.type) {
    case "session.created":
      return run(() => startSession(adapter, session));
    case "session.deleted":
      return run(async () => {
        if (!session.agentType && session.started && !session.ended) await endSession(adapter, session, "deleted", "completed");
        adapter.sessions.delete(session.id);
      });
    case "session.inbox.enqueued":
      // Only `/compact` queues one: an automatic compaction starts on its own.
      if (data.item?.type === "compaction") session.manualCompaction = true;
      return;
    case "session.execution.succeeded":
      return run(async () => {
        if (session.turn?.finished || session.turn?.attempts) await endTurn(adapter, session, "completed");
      });
    case "session.execution.failed":
      return run(() => endTurn(adapter, session, "failed", { class: String(data.error?.type ?? "Error"), message: String(data.error?.message ?? "The turn failed") }));
    case "session.execution.interrupted":
      return run(() => endTurn(adapter, session, "cancelled"));
    case "session.step.ended":
      return run(() => stepEnded(adapter, session, data));
    case "session.step.failed":
      return run(async () => {
        const hooks = await adapter.client("model.error");
        if (!hooks || !session.turn?.attempts || !session.model) return;
        adapter.report(await hooks.modelError({
          ...adapter.scope(session),
          model: session.model,
          attempt: attempt(session),
          execution: { status: "executed" },
          error: { class: String(data.error?.type ?? "Error"), message: String(data.error?.message ?? "The model request failed") },
        }));
      });
    case "session.text.delta":
      return run(async () => {
        const hooks = await adapter.client("turn.progress");
        if (!hooks || !session.turn) return;
        adapter.report(await hooks.turnProgress({
          session: adapter.sessionObject(session),
          turn: { id: session.turn.id },
          item: { id: String(data.assistantMessageID) },
          delta: message(`${data.assistantMessageID}#${data.ordinal}`, "assistant", String(data.delta)) as never,
          final: false,
        }));
      });
    case "session.tool.progress": {
      const call = adapter.find(String(data.id));
      if (!call) return;
      return run(async () => {
        const hooks = await adapter.client("tool.progress");
        if (!hooks) return;
        const metadata = data.metadata;
        const text = typeof metadata?.output === "string" ? metadata.output : asText(metadata);
        adapter.report(await hooks.toolProgress({
          ...callFields(call),
          ...adapter.scope(session),
          input: json(call.input),
          partialOutput: message(`${call.id}:progress`, "tool", text) as never,
          backgrounded: false,
          ...(call.beforeEventId ? { parentEventId: call.beforeEventId } : {}),
        }));
      });
    }
    case "session.model.selected":
      return run(async () => {
        const next = modelOf(data.model);
        const previous = data.previous ? modelOf(data.previous) : session.model;
        session.model = next;
        const hooks = await adapter.client("model.switch.after");
        if (hooks && previous && (previous.id !== next.id || previous.provider !== next.provider))
          adapter.report(await hooks.modelSwitchAfter({ ...adapter.scope(session), previous, current: next, reason: "the session's model was selected" }));
      });
    case "session.compaction.ended":
      return run(async () => {
        const hooks = await adapter.client("context.compact.after");
        if (!hooks) return;
        adapter.report(await hooks.contextCompactAfter({
          ...adapter.scope(session),
          summary: [textPart(`compact:${session.id}:${crypto.randomUUID()}`, String(data.text ?? ""), "summary")],
          removed: [],
          execution: { status: "executed" },
          gaps: [{ path: "removed", reason: "OpenCode does not report which messages a compaction replaced" }],
        }));
      });
    case "permission.asked": {
      const call = data.source?.id ? adapter.find(data.source.id) : undefined;
      if (call) adapter.permissions.set(String(data.id), call);
      return run(async () => {
        const hooks = await adapter.client("user.attention");
        if (!hooks) return;
        const resources = Array.isArray(data.resources) ? data.resources.join(", ") : "";
        adapter.report(await hooks.userAttention({
          ...adapter.scope(session),
          attention: {
            kind: "permission",
            message: [textPart(`${data.id}:message`, resources || String(data.action))],
            title: [textPart(`${data.id}:title`, `Permission: ${data.action}`)],
          },
        }));
      });
    }
    case "permission.replied": {
      const id = String(data.requestID ?? data.id);
      const call = adapter.permissions.get(id);
      if (!call) return;
      adapter.permissions.delete(id);
      if (data.reply === "reject") call.rejected = true;
      return run(() => resolved(adapter, session, call, data.reply === "reject" ? "deny" : "allow", "user"));
    }
  }
}

export async function setup(input: unknown): Promise<() => Promise<void>> {
  const ctx = input as Context;
  const adapter = new Adapter(ctx);
  // Reads only. It sees the servers of plugins loaded before this one, and config.
  await ctx.mcp.transform((editor) => {
    adapter.mcp = new Map(editor.list());
  });
  await ctx.session.hook("prompt", (event) => onPrompt(adapter, event));
  await ctx.session.hook("context", (event) => onContext(adapter, event));
  await ctx.session.hook("compaction", (event) => onCompaction(adapter, event));
  await ctx.session.hook("experimental.idle", (event) => onIdle(adapter, event));
  await ctx.tool.hook("execute.before", (event) => onToolBefore(adapter, event));
  await ctx.tool.hook("execute.after", (event) => onToolAfter(adapter, event));
  await ctx.permission.hook("evaluate", (event) => onEvaluate(adapter, event));

  const stream = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: stream.signal })) {
      await onBusEvent(adapter, event).catch((error) => adapter.log(`event failed: ${describe(error)}`));
    }
  })().catch(() => {});

  return async () => {
    stream.abort();
    for (const session of adapter.sessions.values())
      if (!session.agentType && session.started && !session.ended)
        void adapter.enqueue(session, () => endSession(adapter, session, "shutdown", "unknown"));
    await adapter.close();
  };
}
