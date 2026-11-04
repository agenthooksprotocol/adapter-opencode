import { afterEach, describe, expect, test } from "bun:test";
import { deny, say, world, type TestWorld } from "./harness.ts";

let w: TestWorld;
afterEach(() => w.close());

const text = (event: any) => event.items[0].parts.map((part: any) => part.text).join("");

describe("turn.start", () => {
  test("carries the prompt under OpenCode's own message and part ids", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hello");
    const [event] = w.of("turn.start");
    expect(event!.turn.id).toBe("msg_1");
    expect(event!.turn.synthesized).toBeUndefined();
    expect(event!.session.id).toBe("ses_1");
    expect(event!.items[0].id).toBe("msg_1");
    expect(event!.items[0].parts[0].id).toBe("prt_msg_1");
    expect(text(event)).toBe("hello");
  });

  test("deny stops the prompt with a throw and says why first", async () => {
    w = await world({ respond: (event) => (event.type === "turn.start" ? [deny("no prompts")] : []) });
    await expect(say(w, "ses_1", "msg_1", "hello")).rejects.toThrow("no prompts");
    expect(w.calls.toasts[0].message).toBe("no prompts");
    // The next prompt is a turn of its own, not a message into a running one.
    await expect(say(w, "ses_1", "msg_2", "again")).rejects.toThrow();
    expect(w.of("user.message.inbound")).toHaveLength(0);
  });

  test("an unreachable fail-closed backend refuses; fail-open passes", async () => {
    w = await world({ unreachable: true, events: ["turn.start"] });
    await expect(say(w, "ses_1", "msg_1", "hello")).rejects.toThrow("fail-closed");
    await w.close();
    w = await world({ unreachable: true, events: ["turn.start"], failurePolicy: "fail-open" });
    const output = await say(w, "ses_1", "msg_1", "hello");
    expect(output.parts[0]!.text).toBe("hello");
  });

  test("modify rewrites the part in place, keeping its id", async () => {
    w = await world({
      respond: (event) => event.type === "turn.start"
        ? [{ type: "modify", target: "prompt", operation: "replace", value: [{ ...event.items[0], parts: [{ ...event.items[0].parts[0], text: "rewritten" }] }] }]
        : [],
    });
    const output = await say(w, "ses_1", "msg_1", "hello");
    expect(output.parts).toHaveLength(1);
    expect(output.parts[0]).toMatchObject({ id: "prt_msg_1", text: "rewritten" });
  });

  test("inject adds a synthetic part that sorts after the prompt", async () => {
    w = await world({
      respond: (event) => event.type === "turn.start"
        ? [{ type: "inject", target: "context", operation: "append", deliverAt: "now", value: [{ id: "i", role: "user", parts: [{ id: "i#0", kind: "text", mediaType: "text/plain", selection: "body", text: "remember this" }] }] }]
        : [],
    });
    const output = await say(w, "ses_1", "msg_1", "hello");
    const added = output.parts[1] as any;
    expect(added).toMatchObject({ type: "text", text: "remember this", synthetic: true, sessionID: "ses_1", messageID: "msg_1" });
    expect(added.id > output.parts[0]!.id).toBe(true);
  });

  test("a slash command says what it expanded from", async () => {
    w = await world();
    await w.hooks["command.execute.before"]({ command: "review", sessionID: "ses_1", arguments: "" }, { parts: [] });
    await say(w, "ses_1", "msg_1", "expanded");
    expect(w.of("turn.start")[0]!.expandedFrom).toBe("/review");
  });
});

describe("session.start", () => {
  test("fires once at creation, and its context rides on the first prompt", async () => {
    w = await world({
      respond: (event) => event.type === "session.start"
        ? [{ type: "inject", target: "context", operation: "append", deliverAt: "now", value: [{ id: "i", role: "user", parts: [{ id: "i#0", kind: "text", mediaType: "text/plain", selection: "body", text: "startup context" }] }] }]
        : [],
    });
    await w.bus("session.created", { sessionID: "ses_1", info: { id: "ses_1", directory: w.directory } });
    const first = await say(w, "ses_1", "msg_1", "hello");
    await w.settled();
    expect(w.of("session.start")).toHaveLength(1);
    expect(w.of("session.start")[0]!.trigger).toBe("startup");
    expect(first.parts.map((part: any) => part.text)).toEqual(["hello", "startup context"]);
    await w.bus("session.idle", { sessionID: "ses_1" });
    await w.settled();
    const second = await say(w, "ses_1", "msg_2", "again");
    expect(second.parts).toHaveLength(1);
  });

  test("a session first seen at a prompt is a resumption", async () => {
    w = await world();
    await say(w, "ses_old", "msg_1", "hello");
    expect(w.of("session.start")[0]!.trigger).toBe("resume");
  });
});

describe("the end of a turn", () => {
  const transcript = { ses_1: [{ info: { id: "msg_a", role: "assistant" }, parts: [{ id: "p", type: "text", text: "the answer" }] }] };

  test("turn.finish.before then turn.end, with the answer", async () => {
    w = await world({ transcript });
    await say(w, "ses_1", "msg_1", "hello");
    await w.bus("session.idle", { sessionID: "ses_1" });
    await w.settled();
    const types = w.types();
    expect(types.indexOf("turn.finish.before")).toBeLessThan(types.indexOf("turn.end"));
    const end = w.of("turn.end")[0]!;
    expect(end).toMatchObject({ outcome: "completed", continuationCount: 0, turn: { id: "msg_1" } });
    expect(text(end)).toBe("the answer");
  });

  test("flow continue prompts synthetically and the same turn goes on", async () => {
    let passes = 0;
    w = await world({
      transcript,
      respond: (event) => event.type === "turn.finish.before" && passes++ === 0
        ? [{ type: "flow", operation: "continue", instruction: "keep going" }]
        : [],
    });
    await say(w, "ses_1", "msg_1", "hello");
    await w.bus("session.idle", { sessionID: "ses_1" });
    await w.settled();
    expect(w.calls.promptAsync).toHaveLength(1);
    expect(w.calls.promptAsync[0].body.parts[0]).toMatchObject({ text: "keep going", synthetic: true });
    expect(w.of("turn.end")).toHaveLength(0);
    // OpenCode runs the prompt: it is no new turn, and no inbound message.
    await say(w, "ses_1", "msg_2", "keep going");
    expect(w.of("turn.start")).toHaveLength(1);
    expect(w.of("user.message.inbound")).toHaveLength(0);
    await w.bus("session.idle", { sessionID: "ses_1" });
    await w.settled();
    expect(w.of("turn.end")[0]).toMatchObject({ continuationCount: 1, turn: { id: "msg_1" } });
  });

  test("past the limit a backend can only stop", async () => {
    w = await world({ respond: (event) => event.type === "turn.finish.before" ? [] : [] });
    const capabilities: any[] = [];
    await w.close();
    w = await world({
      respond: (event, request) => {
        if (event.type !== "turn.finish.before") return [];
        capabilities.push(request.params.capabilities);
        return event.continuationCount < 8 ? [{ type: "flow", operation: "continue" }] : [];
      },
    });
    await say(w, "ses_1", "msg_1", "hello");
    for (let pass = 0; pass < 9; pass++) {
      await w.bus("session.idle", { sessionID: "ses_1" });
      await w.settled();
      if (pass < 8) await say(w, "ses_1", `msg_c${pass}`, "continue");
    }
    expect(w.calls.promptAsync).toHaveLength(8);
    expect(capabilities.at(-1).flow.operations).toEqual(["stop"]);
    expect(w.of("turn.end")).toHaveLength(1);
  });

  test("an abort ends the turn as cancelled, without asking", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hello");
    await w.bus("session.error", { sessionID: "ses_1", error: { name: "MessageAbortedError", data: {} } });
    await w.bus("session.idle", { sessionID: "ses_1" });
    await w.settled();
    expect(w.of("turn.finish.before")).toHaveLength(0);
    expect(w.of("turn.end")[0]!.outcome).toBe("cancelled");
    expect(w.of("model.error")).toHaveLength(0);
  });

  test("a failure ends it as failed", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hello");
    await w.bus("session.error", { sessionID: "ses_1", error: { name: "APIError", data: { message: "overloaded" } } });
    await w.bus("session.idle", { sessionID: "ses_1" });
    await w.settled();
    expect(w.of("turn.end")[0]).toMatchObject({ outcome: "failed", error: { class: "APIError", message: "overloaded" } });
  });

  test("an idle session with no turn raises nothing", async () => {
    w = await world();
    await w.bus("session.idle", { sessionID: "ses_1" });
    await w.settled();
    expect(w.of("turn.end")).toHaveLength(0);
  });
});

describe("prompts into a running turn", () => {
  test("are inbound messages, which can be refused", async () => {
    w = await world({ respond: (event) => (event.type === "user.message.inbound" ? [deny("not now")] : []) });
    await say(w, "ses_1", "msg_1", "hello");
    await expect(say(w, "ses_1", "msg_2", "and also")).rejects.toThrow("not now");
    expect(w.of("turn.start")).toHaveLength(1);
    const inbound = w.of("user.message.inbound")[0]!;
    expect(inbound.turn.id).toBe("msg_1");
    expect(inbound.message.messages[0].parts[0].text).toBe("and also");
  });
});

describe("subagents", () => {
  test("share the root's session, carry agent, and hang off their task call", async () => {
    w = await world({ sessions: { ses_child: { parentID: "ses_1" } } });
    await say(w, "ses_1", "msg_1", "hello");
    await w.hooks["tool.execute.before"](
      { tool: "task", sessionID: "ses_1", callID: "call_t" },
      { args: { description: "d", prompt: "child", subagent_type: "general" } },
    );
    await w.bus("session.created", { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_1", directory: w.directory } });
    await say(w, "ses_child", "msg_c", "child", { agent: "general" });
    await w.settled();
    expect(w.of("session.start")).toHaveLength(1);
    const before = w.of("tool.before")[0]!;
    const child = w.of("turn.start")[1]!;
    expect(child.session).toMatchObject({ id: "ses_1", agent: { id: "ses_child", type: "general" } });
    expect(child.parentEventId).toBe(before.id);
    expect(child.trigger).toBe("external");

    await w.bus("session.idle", { sessionID: "ses_child" });
    await w.settled();
    expect(w.of("turn.end")[0]).toMatchObject({ turn: { id: "msg_c" }, parentEventId: before.id });
  });

  test("a subagent's finish takes no flow", async () => {
    const capabilities: any[] = [];
    w = await world({
      sessions: { ses_child: { parentID: "ses_1" } },
      respond: (event, request) => {
        if (event.type === "turn.finish.before") capabilities.push(request.params.capabilities);
        return [];
      },
    });
    await say(w, "ses_1", "msg_1", "hello");
    await say(w, "ses_child", "msg_c", "child", { agent: "general" });
    await w.bus("session.idle", { sessionID: "ses_child" });
    await w.settled();
    expect(capabilities[0].effects).toEqual(["message"]);
  });
});

describe("model switches", () => {
  test("a refused switch puts the current model back", async () => {
    w = await world({ respond: (event) => (event.type === "model.switch.before" ? [deny("stay")] : []) });
    await say(w, "ses_1", "msg_1", "hello");
    await w.bus("session.idle", { sessionID: "ses_1" });
    await w.settled();
    const { output, input } = (await import("./harness.ts")).prompt("ses_1", "msg_2", "again");
    output.message.model = { providerID: "other", modelID: "big" };
    await w.hooks["chat.message"]({ ...input, model: { providerID: "other", modelID: "big" } }, output);
    expect(w.of("model.switch.before")[0]).toMatchObject({ current: { id: "m", provider: "fake" }, proposed: { id: "big", provider: "other" } });
    expect(output.message.model).toEqual({ providerID: "fake", modelID: "m" });
    expect(w.of("model.switch.after")).toHaveLength(0);
  });

  test("an accepted one is reported after", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hello");
    await w.bus("session.idle", { sessionID: "ses_1" });
    await w.settled();
    await say(w, "ses_1", "msg_2", "again", { model: { providerID: "other", modelID: "big" } });
    expect(w.of("model.switch.after")[0]).toMatchObject({ previous: { id: "m" }, current: { id: "big" } });
  });
});
