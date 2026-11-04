// Session lifecycle, compaction, and the bus events that carry one AHP event
// each (todos and files).
import type { Hooks as PluginHooks } from "@opencode-ai/plugin";
import type { Event as BusEvent } from "@opencode-ai/sdk";
import { Permission, state } from "agenthooksprotocol/client";
import { type Adapter, type SessionState, injections } from "../adapter.js";
import { json, texts, textPart, type Part } from "../../shared/content.js";
import { canonical, type NativePart } from "../media.js";

/** session.start, once. Its context waits for the session's first prompt, and
 * a prompt waits for it. A subagent is not a session of its own. */
export function startSession(adapter: Adapter, session: SessionState, how: { trigger: "startup" | "resume" }): Promise<void> {
  if (session.agentType) return Promise.resolve();
  session.started ??= (async () => {
    const hooks = await adapter.client("session.start");
    if (!hooks) return;
    const result = await hooks.sessionStart({
      session: adapter.sessionObject(session),
      trigger: how.trigger,
      permissionMode: "default",
      items: [],
      gaps: [{ path: "items", reason: "OpenCode composes startup instructions into each model request, after this boundary" }],
    }, { initialState: state.initial(Permission.None) });
    adapter.report(result);
    session.startContext.push(...injections(result));
  })();
  return adapter.track(session.started);
}

export function lifecycleHooks(adapter: Adapter): Pick<PluginHooks, "experimental.session.compacting"> {
  return {
    "experimental.session.compacting": async (input, output) => {
      const session = await adapter.session(input.sessionID);
      session.compacting = true;
      const hooks = await adapter.client("context.compact.before");
      if (!hooks) return;
      const response = await adapter.host.client.session.messages({ path: { id: input.sessionID } }).catch(() => undefined);
      const rows = response?.data ?? [];
      const auto = rows.some((row) => row.parts.some((part) => part.type === "compaction" && part.auto));
      const result = await hooks.contextCompactBefore({
        ...adapter.scope(session),
        trigger: auto ? "auto" : "manual",
        items: rows.map((row) => canonical(row.info.id, row.info.role, row.parts as unknown as NativePart[])) as never,
        instructions: [],
      }, { initialState: state.initial(Permission.None) });
      adapter.report(result);
      // `output.prompt` would replace the conversation too: instructions add.
      const instructions = (result.event as { instructions?: Part[] }).instructions;
      output.context.push(...texts([{ parts: instructions ?? [] }]));
    },
  };
}

export async function onLifecycleEvent(adapter: Adapter, event: BusEvent): Promise<void> {
  const type = event.type as string;
  if (type === "server.instance.disposed") {
    await Promise.all([...adapter.sessions.values()].map((session) => {
      if (session.agentType || !session.started || session.ended) return undefined;
      return adapter.enqueue(session, () => endSession(adapter, session, "shutdown", "unknown"));
    }));
    return;
  }
  switch (event.type) {
    case "session.created": {
      const { info } = event.properties;
      const session = await adapter.session(info.id, { ...(info.parentID ? { parentID: info.parentID } : {}), directory: info.directory });
      void adapter.enqueue(session, () => startSession(adapter, session, { trigger: "startup" }));
      return;
    }
    case "session.deleted": {
      const { info } = event.properties;
      const session = adapter.sessions.get(info.id);
      if (!session) return;
      await adapter.enqueue(session, async () => {
        if (!session.agentType && session.started && !session.ended) await endSession(adapter, session, "deleted", "completed");
        adapter.sessions.delete(session.id);
      });
      return;
    }
    case "session.compacted": {
      const session = await adapter.session(event.properties.sessionID);
      void adapter.enqueue(session, () => compacted(adapter, session));
      return;
    }
    case "todo.updated": {
      const { sessionID, todos } = event.properties;
      const session = await adapter.session(sessionID);
      void adapter.enqueue(session, () => todosChanged(adapter, session, todos));
      return;
    }
    case "file.edited": {
      const file = event.properties.file;
      void adapter.track(fileChanged(adapter, file, "update", true));
      return;
    }
    case "file.watcher.updated": {
      const { file, event: change } = event.properties;
      void adapter.track(fileChanged(adapter, file, change === "add" ? "create" : change === "unlink" ? "remove" : "update", false));
      return;
    }
  }
}

async function endSession(adapter: Adapter, session: SessionState, reason: string, outcome: "completed" | "unknown"): Promise<void> {
  session.ended = true;
  const hooks = await adapter.client("session.end");
  if (!hooks) return;
  adapter.report(await hooks.sessionEnd({ session: adapter.sessionObject(session), reason, outcome }));
}

async function compacted(adapter: Adapter, session: SessionState): Promise<void> {
  const hooks = await adapter.client("context.compact.after");
  if (!hooks) return;
  const response = await adapter.host.client.session.messages({ path: { id: session.id } }).catch(() => undefined);
  const rows = response?.data ?? [];
  const summary = rows.findLast((row) => row.info.role === "assistant" && row.info.summary);
  const text = summary ? texts([{ parts: summary.parts.filter((part) => part.type === "text") }]).join("\n") : "";
  adapter.report(await hooks.contextCompactAfter({
    ...adapter.scope(session),
    summary: [textPart(summary ? `${summary.info.id}:summary` : `compact:${crypto.randomUUID()}`, text, "summary")],
    removed: [],
    execution: { status: "executed" },
    gaps: [{ path: "removed", reason: "OpenCode keeps every message and hides the compacted ones when it reads the conversation" }],
  }));
}

/** Todos have no identity: their text is what stays put between writes. */
async function todosChanged(adapter: Adapter, session: SessionState, todos: readonly { content: string; status: string; priority?: string }[]): Promise<void> {
  const previous = session.todos;
  session.todos = new Map(todos.map((todo) => [todo.content, todo.status]));
  const hooks = await adapter.client("task.change.after");
  if (!hooks) return;
  const send = async (content: string, operation: "create" | "update" | "remove", change: Record<string, unknown>, prior?: Record<string, unknown>) => {
    adapter.report(await hooks.taskChangeAfter({
      ...adapter.scope(session),
      task: { id: `todo:${session.id}:${content}`, operation, change: json(change), description: content, ...(prior ? { prior: json(prior) } : {}) },
      synthesized: true,
    }));
  };
  for (const todo of todos) {
    const before = previous.get(todo.content);
    if (before === undefined) await send(todo.content, "create", { status: todo.status });
    else if (before !== todo.status) await send(todo.content, "update", { status: todo.status }, { status: before });
  }
  for (const [content, status] of previous)
    if (!session.todos.has(content)) await send(content, "remove", {}, { status });
}

async function fileChanged(adapter: Adapter, path: string, operation: "create" | "update" | "remove", agentCaused: boolean): Promise<void> {
  const hooks = await adapter.client("file.changed");
  if (!hooks) return;
  adapter.report(await hooks.fileChanged({ changes: [{ path, operation, agentCaused }] }));
}
