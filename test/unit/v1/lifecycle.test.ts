import { afterEach, describe, expect, test } from "bun:test";
import { say, world, type TestWorld } from "./harness.ts";

let w: TestWorld;
afterEach(() => w.close());

describe("compaction", () => {
  test("merge adds instructions to OpenCode's context and leaves its prompt", async () => {
    w = await world({
      respond: (event) => event.type === "context.compact.before"
        ? [{ type: "modify", target: "instructions", operation: "merge", value: [{ id: "c", kind: "text", mediaType: "text/plain", selection: "body", text: "keep the plan" }] }]
        : [],
      transcript: { ses_1: [{ info: { id: "msg_1", role: "user" }, parts: [{ id: "p", type: "text", text: "hello" }] }] },
    });
    await say(w, "ses_1", "msg_1", "hello");
    const output: { context: string[]; prompt?: string } = { context: [] };
    await w.hooks["experimental.session.compacting"]({ sessionID: "ses_1" }, output);
    expect(output.context).toEqual(["keep the plan"]);
    expect(output.prompt).toBeUndefined();
    const event = w.of("context.compact.before")[0]!;
    expect(event.trigger).toBe("manual");
    expect(event.items[0].parts[0].text).toBe("hello");
  });

  test("the summary is reported after", async () => {
    w = await world({
      transcript: { ses_1: [{ info: { id: "msg_s", role: "assistant", summary: true }, parts: [{ id: "p", type: "text", text: "so far" }] }] },
    });
    await say(w, "ses_1", "msg_1", "hello");
    await w.bus("session.compacted", { sessionID: "ses_1" });
    await w.settled();
    expect(w.of("context.compact.after")[0]).toMatchObject({ summary: [{ text: "so far", category: "summary" }], execution: { status: "executed" } });
  });
});

describe("session.end", () => {
  test("a deleted session ends", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hello");
    await w.bus("session.deleted", { sessionID: "ses_1", info: { id: "ses_1" } });
    expect(w.of("session.end")[0]).toMatchObject({ reason: "deleted", outcome: "completed", session: { id: "ses_1" } });
  });

  test("shutdown ends what is open and waits for deliveries", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hello");
    const { of, hooks } = w;
    await hooks.dispose();
    expect(of("session.end")[0]).toMatchObject({ reason: "shutdown", outcome: "unknown" });
  });

  test("a subagent's session is no session of its own", async () => {
    w = await world({ sessions: { ses_child: { parentID: "ses_1" } } });
    await say(w, "ses_1", "msg_1", "hello");
    await say(w, "ses_child", "msg_c", "child", { agent: "general" });
    await w.bus("session.deleted", { sessionID: "ses_child", info: { id: "ses_child" } });
    expect(w.of("session.end")).toHaveLength(0);
    expect(w.of("session.start")).toHaveLength(1);
  });
});

describe("todos", () => {
  test("each change is one task.change.after", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hello");
    await w.bus("todo.updated", { sessionID: "ses_1", todos: [{ content: "a", status: "pending" }, { content: "b", status: "pending" }] });
    await w.bus("todo.updated", { sessionID: "ses_1", todos: [{ content: "a", status: "completed" }] });
    await w.settled();
    const tasks = w.of("task.change.after").map((event) => event.task);
    expect(tasks.map((task) => [task.description, task.operation])).toEqual([["a", "create"], ["b", "create"], ["a", "update"], ["b", "remove"]]);
    expect(tasks[2]).toMatchObject({ change: { status: "completed" }, prior: { status: "pending" } });
  });
});

describe("files", () => {
  test("OpenCode's edits and the watcher's changes are file.changed", async () => {
    w = await world();
    await w.bus("file.edited", { file: "/a.ts" });
    await w.bus("file.watcher.updated", { file: "/b.ts", event: "unlink" });
    await w.settled();
    expect(w.of("file.changed").map((event) => event.changes[0])).toEqual([
      { path: "/a.ts", operation: "update", agentCaused: true },
      { path: "/b.ts", operation: "remove", agentCaused: false },
    ]);
  });
});
