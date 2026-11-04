import { afterEach, describe, expect, test } from "bun:test";
import { deny, say, world, type TestWorld } from "./harness.ts";

let w: TestWorld;
afterEach(() => w.close());

const row = (id: string, role: string, text: string, sessionID = "ses_1") => ({
  info: { id, role, sessionID, agent: "build", model: { providerID: "fake", modelID: "m" } },
  parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text }],
});
const transform = async (messages: any[]) => {
  await w.hooks["experimental.chat.messages.transform"]({}, { messages });
  return messages;
};

describe("model.request.before", () => {
  test("reports the conversation under native ids, with its attempt", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hello");
    await transform([row("msg_1", "user", "hello")]);
    const event = w.of("model.request.before")[0]!;
    expect(event.model).toEqual({ id: "m", provider: "fake" });
    expect(event.attempt).toMatchObject({ id: "msg_1:1", number: 1, synthesized: true });
    expect(event.items[0].id).toBe("msg_1");
    expect(event.gaps.map((gap: any) => gap.path)).toContain("items.system");
  });

  test("modify changes this request's copy, and can drop a message", async () => {
    w = await world({
      respond: (event) => event.type === "model.request.before"
        ? [{ type: "modify", target: "request", operation: "replace", value: event.items.slice(1).map((item: any) => ({ ...item, parts: [{ ...item.parts[0], text: "edited" }] })) }]
        : [],
    });
    await say(w, "ses_1", "msg_1", "hello");
    const messages = await transform([row("msg_0", "user", "old"), row("msg_1", "user", "hello")]);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts[0].text).toBe("edited");
  });

  test("a message the conversation lacks rides on the last user message", async () => {
    w = await world({
      respond: (event) => event.type === "model.request.before"
        ? [{ type: "modify", target: "request", operation: "replace", value: [...event.items, { id: "new", role: "user", parts: [{ id: "new#0", kind: "text", mediaType: "text/plain", selection: "body", text: "added" }] }] }]
        : [],
    });
    await say(w, "ses_1", "msg_1", "hello");
    const messages = await transform([row("msg_1", "user", "hello")]);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts[1]).toMatchObject({ text: "added", synthetic: true });
  });

  test("deny refuses the request and fails the turn", async () => {
    w = await world({ respond: (event) => (event.type === "model.request.before" ? [deny("over budget")] : []) });
    await say(w, "ses_1", "msg_1", "hello");
    await expect(transform([row("msg_1", "user", "hello")])).rejects.toThrow("over budget");
    await w.bus("session.idle", { sessionID: "ses_1" });
    await w.settled();
    expect(w.of("turn.end")[0]).toMatchObject({ outcome: "failed", error: { class: "Denied", message: "over budget" } });
  });

  test("inject reaches this request as a synthetic part", async () => {
    w = await world({
      respond: (event) => event.type === "model.request.before"
        ? [{ type: "inject", target: "context", operation: "append", deliverAt: "now", value: [{ id: "i", role: "user", parts: [{ id: "i#0", kind: "text", mediaType: "text/plain", selection: "body", text: "note" }] }] }]
        : [],
    });
    await say(w, "ses_1", "msg_1", "hello");
    const messages = await transform([row("msg_1", "user", "hello")]);
    expect(messages[0].parts[1]).toMatchObject({ text: "note", synthetic: true });
  });

  test("a compaction's pass through the hook is not a model request", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hello");
    await w.hooks["experimental.session.compacting"]({ sessionID: "ses_1" }, { context: [] });
    await transform([row("msg_1", "user", "hello")]);
    expect(w.of("model.request.before")).toHaveLength(0);
    await transform([row("msg_1", "user", "hello")]);
    expect(w.of("model.request.before")).toHaveLength(1);
  });

  test("the system prompt is reported from the second request on; a title's is not", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hello");
    await w.hooks["experimental.chat.system.transform"]({ sessionID: "ses_1", model: {} }, { system: ["title prompt"] });
    await w.hooks["chat.params"]({ sessionID: "ses_1", agent: "title" }, {});
    await transform([row("msg_1", "user", "hello")]);
    await w.hooks["experimental.chat.system.transform"]({ sessionID: "ses_1", model: {} }, { system: ["the system prompt"] });
    await w.hooks["chat.params"]({ sessionID: "ses_1", agent: "build" }, {});
    await transform([row("msg_1", "user", "hello")]);
    const [first, second] = w.of("model.request.before");
    expect(first!.items.some((item: any) => item.role === "system")).toBe(false);
    expect(second!.items[0]).toMatchObject({ role: "system", parts: [{ text: "the system prompt", category: "system" }] });
  });
});

describe("what the bus reports", () => {
  const finish = (messageID: string, reason: string) => ({
    sessionID: "ses_1",
    part: { id: "s", sessionID: "ses_1", messageID, type: "step-finish", reason, tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 1, write: 0 } }, cost: 0 },
  });

  test("a step's end is model.response.after, its calls tool.batch.after", async () => {
    w = await world({
      transcript: {
        ses_1: [{
          info: { id: "msg_a", role: "assistant", modelID: "m", providerID: "fake" },
          parts: [
            { id: "p1", type: "text", text: "calling" },
            { id: "p2", type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", input: { command: "ls" }, output: "x" } },
          ],
        }],
      },
    });
    await say(w, "ses_1", "msg_1", "hello");
    await transform([row("msg_1", "user", "hello")]);
    await w.bus("message.part.updated", finish("msg_a", "tool-calls"));
    await w.settled();
    const response = w.of("model.response.after")[0]!;
    expect(response).toMatchObject({ finishReason: "tool-calls", attempt: { id: "msg_1:1" }, model: { id: "m" } });
    expect(response.items[0].parts[0].text).toBe("calling");
    expect(response.usage.inputTokens).toBe(5);
    expect(w.of("tool.batch.after")[0]).toMatchObject({ batch: { id: "msg_a" }, calls: [{ call: { id: "call_1" }, outcome: "ok" }] });
  });

  test("a failure mid-request is model.error", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hello");
    await transform([row("msg_1", "user", "hello")]);
    await w.bus("session.error", { sessionID: "ses_1", error: { name: "APIError", data: { message: "overloaded" } } });
    await w.settled();
    expect(w.of("model.error")[0]).toMatchObject({ attempt: { id: "msg_1:1" }, error: { class: "APIError", message: "overloaded" } });
  });

  test("text deltas are turn.progress", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hello");
    await w.bus("message.part.delta", { sessionID: "ses_1", messageID: "msg_a", partID: "p1", field: "text", delta: "par" });
    await w.settled();
    expect(w.of("turn.progress")[0]).toMatchObject({ item: { id: "msg_a" }, delta: { parts: [{ text: "par" }] }, final: false });
  });
});
