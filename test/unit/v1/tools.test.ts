import { afterEach, describe, expect, test } from "bun:test";
import { deny, say, world, type TestWorld } from "./harness.ts";

let w: TestWorld;
afterEach(() => w.close());

const before = (args: Record<string, unknown>, callID = "call_1", tool = "bash") =>
  w.hooks["tool.execute.before"]({ tool, sessionID: "ses_1", callID }, { args });
const afterHook = (output: unknown, args = {}, callID = "call_1", tool = "bash") =>
  w.hooks["tool.execute.after"]({ tool, sessionID: "ses_1", callID, args }, output);
const inject = (text: string) => ({ type: "inject", target: "context", operation: "append", deliverAt: "now", value: [{ id: "i", role: "user", parts: [{ id: "i#0", kind: "text", mediaType: "text/plain", selection: "body", text }] }] });

describe("tool.before", () => {
  test("carries the call under OpenCode's own call id", async () => {
    w = await world();
    await say(w, "ses_1", "msg_1", "hi");
    await before({ command: "ls" });
    expect(w.of("tool.before")[0]).toMatchObject({
      call: { id: "call_1" },
      tool: { name: "bash", origin: "native", input: { command: "ls" } },
      path: "native",
      turn: { id: "msg_1" },
    });
  });

  test("deny throws, for the model to read, and reports tool.after denied", async () => {
    w = await world({ respond: (event) => (event.type === "tool.before" ? [deny("not that")] : []) });
    await expect(before({ command: "rm -rf /" })).rejects.toThrow("not that");
    expect(w.of("tool.after")[0]).toMatchObject({ outcome: "denied", execution: { status: "skipped", reason: "policy" } });
    expect(w.of("tool.after")[0]!.parentEventId).toBe(w.of("tool.before")[0]!.id);
  });

  test("modify edits the args object itself: OpenCode ignores a new one", async () => {
    w = await world({ respond: (event) => (event.type === "tool.before" ? [{ type: "modify", target: "input", operation: "replace", value: { command: "safe" } }] : []) });
    const args = { command: "unsafe", description: "gone" };
    await before(args);
    expect(args as unknown).toEqual({ command: "safe" });
  });

  test("context waits for the result text", async () => {
    w = await world({ respond: (event) => (event.type === "tool.before" ? [inject("before context")] : []) });
    await before({ command: "ls" });
    const output = { title: "t", output: "result", metadata: {} };
    await afterHook(output);
    expect(output.output).toBe("result\n\nbefore context");
  });
});

describe("tool.after", () => {
  test("hangs off its tool.before and reports the result", async () => {
    w = await world();
    await before({ command: "ls" });
    await afterHook({ title: "t", output: "files", metadata: {} }, { command: "ls" });
    const event = w.of("tool.after")[0]!;
    expect(event.parentEventId).toBe(w.of("tool.before")[0]!.id);
    expect(event).toMatchObject({ outcome: "ok", execution: { status: "executed" } });
    expect(event.items[0].parts[0].text).toBe("files");
  });

  test("modify rewrites what the model reads", async () => {
    w = await world({
      respond: (event) => event.type === "tool.after"
        ? [{ type: "modify", target: "output", operation: "replace", value: [{ ...event.items[0], parts: [{ ...event.items[0].parts[0], text: "redacted" }] }] }]
        : [],
    });
    await before({ command: "ls" });
    const output = { title: "t", output: "secret", metadata: {} };
    await afterHook(output);
    expect(output.output).toBe("redacted");
  });

  test("an MCP result is rewritten in MCP's own shape", async () => {
    w = await world({
      mcp: { docs: { type: "remote", url: "https://docs.example/mcp?token=hunter2" } },
      upload: true,
      respond: (event) => event.type === "tool.after"
        ? [{ type: "modify", target: "output", operation: "replace", value: [{ ...event.items[0], parts: [{ ...event.items[0].parts[0], text: "redacted" }, ...event.items[0].parts.slice(1)] }] }]
        : [],
    });
    await before({ q: "x" }, "call_m", "docs_search");
    const image = { type: "image", data: "aGk=", mimeType: "image/png" };
    const output = { content: [{ type: "text", text: "secret" }, image] };
    await afterHook(output, {}, "call_m", "docs_search");
    expect(output.content).toEqual([{ type: "text", text: "redacted" }, image]);
    const event = w.of("tool.before")[0]!;
    expect(event.path).toBe("mcp");
    expect(event.tool).toMatchObject({ origin: "mcp", mcp: { server: { id: "docs" }, toolName: "search", connection: { transport: "http", url: "https://docs.example/mcp" } } });
  });

  test("a failure, which never reaches the after hook, comes from the bus", async () => {
    w = await world();
    await before({ command: "ls" });
    await w.bus("message.part.updated", { sessionID: "ses_1", part: { id: "p", sessionID: "ses_1", messageID: "m", type: "tool", tool: "bash", callID: "call_1", state: { status: "error", input: {}, error: "boom", time: {} } } });
    await w.settled();
    expect(w.of("tool.after")[0]).toMatchObject({ outcome: "error", error: { class: "ToolError", message: "boom" } });
  });

  test("a binary attachment is uploaded, and never travels in text", async () => {
    w = await world({ upload: true });
    await before({ filePath: "/x.png" }, "call_r", "read");
    await afterHook({ title: "t", output: "image read", metadata: {}, attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,aGVsbG8=" }] }, {}, "call_r", "read");
    await w.settled();
    expect(new TextDecoder().decode(w.uploads[0]!.body)).toBe("hello");
    const event = w.of("tool.after")[0]!;
    const media = event.items[0].parts[1];
    expect(media).toMatchObject({ kind: "attachment", mediaType: "image/png", selection: "body", body: { ref: "urn:test:1" } });
    expect(JSON.stringify(event)).not.toContain("aGVsbG8=");
  });
});

describe("tool.progress", () => {
  test("reports running output", async () => {
    w = await world();
    await before({ command: "ls" });
    await w.bus("message.part.updated", { sessionID: "ses_1", part: { id: "p", sessionID: "ses_1", messageID: "m", type: "tool", tool: "bash", callID: "call_1", state: { status: "running", input: {}, metadata: { output: "line 1\n" }, time: {} } } });
    await w.settled();
    const event = w.of("tool.progress")[0]!;
    expect(event.partialOutput.parts[0].text).toBe("line 1\n");
    expect(event.backgrounded).toBe(false);
  });
});

describe("permissions", () => {
  const asked = (id = "per_1", callID = "call_1") => ({ id, sessionID: "ses_1", permission: "bash", patterns: ["ls"], always: ["ls *"], metadata: {}, tool: { messageID: "m", callID } });

  test("allow answers the prompt through the reply API", async () => {
    w = await world({ respond: (event) => (event.type === "tool.permission.request" ? [{ type: "allow" }] : []) });
    await before({ command: "ls" });
    await w.bus("permission.asked", asked());
    await w.settled();
    expect(w.calls.permissions[0]).toMatchObject({ path: { id: "ses_1", permissionID: "per_1" }, body: { response: "once" } });
    await w.bus("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "once" });
    await w.settled();
    expect(w.of("tool.permission.resolved")[0]).toMatchObject({ decision: "allow", decidedBy: "hook", call: { id: "call_1" } });
  });

  test("deny rejects, and the failure that follows reads as denied", async () => {
    w = await world({ respond: (event) => (event.type === "tool.permission.request" ? [deny("no")] : []) });
    await before({ command: "ls" });
    await w.bus("permission.asked", asked());
    await w.settled();
    expect(w.calls.permissions[0].body.response).toBe("reject");
    await w.bus("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "reject" });
    await w.bus("message.part.updated", { sessionID: "ses_1", part: { id: "p", sessionID: "ses_1", messageID: "m", type: "tool", tool: "bash", callID: "call_1", state: { status: "error", input: {}, error: "rejected", time: {} } } });
    await w.settled();
    expect(w.of("tool.after")[0]!.outcome).toBe("denied");
  });

  test("no decision leaves the prompt with the person", async () => {
    w = await world();
    await before({ command: "ls" });
    await w.bus("permission.asked", asked());
    await w.settled();
    expect(w.calls.permissions).toHaveLength(0);
    await w.bus("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "always" });
    await w.settled();
    expect(w.of("tool.permission.resolved")[0]).toMatchObject({ decision: "allow", decidedBy: "user" });
  });

  test("flow stop rejects and aborts the session", async () => {
    w = await world({ respond: (event) => (event.type === "tool.permission.request" ? [{ type: "flow", operation: "stop", reason: "halt" }] : []) });
    await before({ command: "ls" });
    await w.bus("permission.asked", asked());
    await w.settled();
    expect(w.calls.permissions[0].body.response).toBe("reject");
    expect(w.calls.aborts).toEqual(["ses_1"]);
  });

  test("tool.before's allow answers the prompt without asking again", async () => {
    w = await world({ respond: (event) => (event.type === "tool.before" ? [{ type: "allow" }] : []) });
    await before({ command: "ls" });
    await w.bus("permission.asked", asked());
    await w.settled();
    expect(w.calls.permissions[0].body.response).toBe("once");
    expect(w.of("tool.permission.request")).toHaveLength(0);
  });

  test("a prompt also reaches a person's attention", async () => {
    w = await world();
    await before({ command: "ls" });
    await w.bus("permission.asked", asked());
    await w.settled();
    expect(w.of("user.attention")[0]!.attention.kind).toBe("permission");
  });
});
