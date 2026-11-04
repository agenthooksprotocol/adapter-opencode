// The adapter's state and the plumbing every mapping shares: one `Hooks` client
// per plugin instance, the session/turn/call identities AHP events carry, and
// how residual effects become OpenCode's answers.
//
// OpenCode runs plugins in-process on Bun with its whole runtime, so the SDK's
// own fetch, stdio and environment access apply: nothing here is shimmed.
import type { PluginInput } from "@opencode-ai/plugin";
import type { Hooks } from "agenthooksprotocol/client";
import { loadRegistration } from "../shared/config.js";
import { createHooks } from "../shared/delivery.js";
import { describe, messages, type AnyResult } from "../shared/effects.js";
import { capabilities, gaps } from "./capabilities.js";

export { EXTENSION } from "../shared/delivery.js";
export { denial, describe, eventId, flow, injections, messages, type AnyResult } from "../shared/effects.js";

export interface Turn {
  /** The id of the user message that began it: durable, and OpenCode's own. */
  id: string;
  continuationCount: number;
  /** Model requests made so far: the current attempt's ordinal. */
  attempts: number;
  /** The event the turn hangs off (a subagent's task tool.before). */
  parentEventId?: string;
  /** How it ended, when not by answering. */
  error?: { class: string; message: string };
  cancelled?: boolean;
  /** Context for each of the turn's remaining model requests. */
  context: string[];
}

export interface SessionState {
  id: string;
  /** The session subagents belong to: an AHP session is the whole tree. */
  rootId: string;
  /** Set on a subagent's session. */
  agentType?: string;
  parentEventId?: string;
  directory: string;
  model?: { id: string; provider: string };
  turn?: Turn;
  /** Bus events are not awaited: each session's run in order here. */
  queue: Promise<unknown>;
  /** session.start, once. */
  started?: Promise<void>;
  /** session.start's context, waiting for the first prompt. */
  startContext: string[];
  /** The next prompt is the adapter's own continuation of this turn. */
  continuing?: boolean;
  /** The next messages transform belongs to a compaction. */
  compacting?: boolean;
  /** The system prompt of the last request, and the one being composed. */
  system?: string[];
  composing?: string[];
  /** Known todos by content, for task.change.after. */
  todos: Map<string, string>;
  /** session.end has been delivered. */
  ended?: boolean;
}

/** What the adapter remembers about a tool call between its hooks. */
export interface CallState {
  id: string;
  name: string;
  input: Record<string, unknown>;
  sessionID: string;
  beforeEventId?: string;
  /** tool.before allowed it: a permission prompt answers itself. */
  allowed?: boolean;
  /** Set when the adapter answered the permission prompt itself. */
  decidedBy?: "hook";
  rejected?: boolean;
  /** tool.before's context, added to the result. */
  context: string[];
  afterSent?: boolean;
  /** subagent_type of a task call not yet bound to its child session. */
  awaitingChild?: string;
}

export class Adapter {
  hooks: Hooks | undefined;
  readonly sessions = new Map<string, SessionState>();
  readonly calls = new Map<string, CallState>();
  /** Calls with a permission prompt open, by the request's id. */
  readonly permissions = new Map<string, CallState>();
  /** MCP servers by name: tool names are prefixed with them. */
  mcp = new Map<string, Record<string, unknown>>();
  #ready: Promise<void>;
  #resolving = new Map<string, Promise<SessionState>>();
  #inFlight = new Set<Promise<unknown>>();

  constructor(readonly host: PluginInput) {
    // Discovery may wait on backends: plugin load must not.
    this.#ready = this.#start().catch((error) => {
      this.hooks = undefined;
      this.log("error", `not started: ${describe(error)}`);
    });
  }

  async #start(): Promise<void> {
    const { registration, sources, diagnostics } = loadRegistration(process.env, this.host.directory, this.host.worktree);
    for (const line of diagnostics) this.log("warn", line);
    if (!registration) {
      this.log("debug", "no hooks.json registration found; nothing is delivered");
      return;
    }
    const hooks = createHooks(registration, await this.#version(), capabilities, gaps);
    await hooks.initialized;
    for (const issue of hooks.initializationDiagnostics ?? []) this.log("warn", `initialization: ${describe(issue)}`);
    this.hooks = hooks;
    const servers = await this.host.client.config.get().then((response) => response.data?.mcp).catch(() => undefined);
    this.mcp = new Map(Object.entries((servers ?? {}) as Record<string, Record<string, unknown>>));
    this.log("info", `delivering to ${registration.hooks.length} backend(s) from ${sources.map((source) => source.path).join(", ")}`);
  }

  async #version(): Promise<string> {
    // The route exists on every server; the generated v1 client has no method for it.
    const client = (this.host.client as unknown as { _client: { get(options: { url: string }): Promise<{ data?: { version?: string } }> } })._client;
    const health = await client.get({ url: "/global/health" }).catch(() => undefined);
    return health?.data?.version ?? "unknown";
  }

  /** The client, once started; undefined when nothing subscribes to `type`. */
  async client(type: string): Promise<Hooks | undefined> {
    await this.#ready;
    const hooks = this.hooks;
    if (!hooks || !hooks.subscribes(type as never)) return undefined;
    return hooks;
  }

  /** A session's state, resolving where it sits in its tree on first sight. */
  session(id: string, known?: { parentID?: string; directory?: string }): Promise<SessionState> {
    const state = this.sessions.get(id);
    if (state) return Promise.resolve(state);
    let pending = this.#resolving.get(id);
    if (!pending) {
      pending = this.#resolve(id, known).finally(() => this.#resolving.delete(id));
      this.#resolving.set(id, pending);
    }
    return pending;
  }

  async #resolve(id: string, known?: { parentID?: string; directory?: string }): Promise<SessionState> {
    const info = known ?? (await this.host.client.session.get({ path: { id } }).then((response) => response.data ?? undefined).catch(() => undefined));
    const parent = info?.parentID ? await this.session(info.parentID) : undefined;
    const state: SessionState = {
      id,
      rootId: parent?.rootId ?? id,
      directory: info?.directory ?? this.host.directory,
      queue: Promise.resolve(),
      startContext: [],
      todos: new Map(),
      ...(parent ? { agentType: "subagent", ...(parent.model ? { model: parent.model } : {}) } : {}),
    };
    this.sessions.set(id, state);
    return state;
  }

  /** Run bus work after the session's earlier bus work. */
  enqueue(state: SessionState, work: () => Promise<unknown>): Promise<unknown> {
    const run = state.queue.then(work).catch((error) => this.log("error", `event failed: ${describe(error)}`));
    state.queue = run;
    return this.track(run);
  }

  /** Dispose waits for what is still being delivered. */
  track<T>(work: Promise<T>): Promise<T> {
    this.#inFlight.add(work);
    void work.finally(() => this.#inFlight.delete(work)).catch(() => {});
    return work;
  }

  async drain(): Promise<void> {
    await this.#ready;
    while (this.#inFlight.size) await Promise.allSettled([...this.#inFlight]);
  }

  /** The AHP session object: a subagent's events carry `agent`. */
  sessionObject(state: SessionState) {
    return {
      id: state.rootId,
      cwd: state.directory,
      ...(state.model ? { model: `${state.model.provider}/${state.model.id}` } : {}),
      ...(state.agentType ? { agent: { id: state.id, type: state.agentType } } : {}),
    };
  }

  /** Session and turn for an event raised in a session. */
  scope(state: SessionState) {
    return {
      session: this.sessionObject(state),
      ...(state.turn ? { turn: { id: state.turn.id } } : {}),
    };
  }

  log(level: "debug" | "info" | "warn" | "error", message: string): void {
    void this.host.client.app.log({ body: { service: "agent-hooks-protocol", level, message } }).catch(() => {});
  }

  /** Report delivery diagnostics and user-visible messages. */
  report(result: AnyResult): void {
    // The adapter reads no attachment back: release what the SDK kept.
    void result.content?.close().catch(() => {});
    for (const diagnostic of result.diagnostics) {
      this.log(diagnostic.syntheticDenial ? "warn" : "debug", `${diagnostic.backendId} ${diagnostic.phase}: ${diagnostic.code}${diagnostic.syntheticDenial ? " (denied by failure policy)" : ""}`);
    }
    for (const text of messages(result)) this.notify(text);
  }

  /** Show a person something: a toast, and the log for sessions with no TUI. */
  notify(text: string, variant: "info" | "error" = "info"): void {
    this.log(variant === "error" ? "error" : "info", text);
    void this.host.client.tui.showToast({ body: { message: text, variant } }).catch(() => {});
  }

  async close(): Promise<void> {
    await this.drain();
    const hooks = this.hooks;
    this.hooks = undefined;
    await hooks?.close();
  }
}
