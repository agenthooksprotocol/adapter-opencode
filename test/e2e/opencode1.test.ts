// The adapter inside a real OpenCode: a server with an isolated home, a local
// fake model, and a recording AHP backend. Nothing here reaches a real backend
// or provider: AHP_HOOKS_FILE pins the registration and HOME is a temp directory.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const BIN = join(REPO, "node_modules/.bin/opencode");
const VERSION = "1.19.5";
const root = realpathSync(mkdtempSync(join(tmpdir(), "ahp-opencode-e2e-")));
const home = join(root, "home");
const project = join(root, "project");

type Event = Record<string, any> & { type: string };
const received: Event[] = [];
const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[] = [];
const of = (type: string, session?: string) =>
  received.filter((event) => event.type === type && (!session || event.session?.id === session));

/** Behaviour keyed by what the model's prompt says. */
const policy = (event: Event): unknown[] => {
  const prompt = JSON.stringify(event.items ?? event.tool?.input ?? "");
  const inject = (text: string) => ({ type: "inject", target: "context", operation: "append", deliverAt: "now", value: [{ id: `i-${event.id}`, role: "user", parts: [{ id: `i-${event.id}#0`, kind: "text", mediaType: "text/plain", selection: "body", text }] }] });
  switch (event.type) {
    case "turn.start":
      if (prompt.includes("REFUSE-PROMPT")) return [{ type: "deny", reason: "refused prompt" }];
      if (prompt.includes("REWRITE-PROMPT")) {
        const item = event.items[0];
        return [
          { type: "modify", target: "prompt", operation: "replace", value: [{ ...item, parts: [{ ...item.parts[0], text: "the rewritten prompt" }] }] },
          inject("injected at turn start"),
        ];
      }
      return [];
    case "tool.before":
      if (prompt.includes("echo refuse-tool")) return [{ type: "deny", reason: "refused tool" }];
      if (prompt.includes("echo rewrite-input")) return [{ type: "modify", target: "input", operation: "replace", value: { ...event.tool.input, command: "echo rewritten-input" } }];
      return [];
    case "tool.after":
      if (JSON.stringify(event.items).includes("rewrite-mcp")) {
        const item = event.items[0];
        return [{ type: "modify", target: "output", operation: "replace", value: [{ ...item, parts: [{ ...item.parts[0], text: "rewritten mcp output" }] }] }];
      }
      if (JSON.stringify(event.items).includes("rewritten-input")) {
        const item = event.items[0];
        return [{ type: "modify", target: "output", operation: "replace", value: [{ ...item, parts: [{ ...item.parts[0], text: "rewritten output" }] }] }];
      }
      return [];
    case "tool.permission.request":
      return JSON.stringify(event.tool.input).includes("reject-me") ? [{ type: "deny", reason: "no" }] : [{ type: "allow" }];
    case "turn.finish.before":
      return prompt.includes("final answer") && !event.continuationCount && continueNext ? (continueNext = false, [{ type: "flow", operation: "continue", instruction: "CONTINUE-PLEASE" }]) : [];
    case "context.compact.before":
      return [{ type: "modify", target: "instructions", operation: "merge", value: [{ id: "c", kind: "text", mediaType: "text/plain", selection: "body", text: "KEEP-THE-PLAN" }] }];
    default:
      return [];
  }
};
let continueNext = false;

const OBSERVE = ["session.end", "turn.end", "model.response.after", "tool.batch.after", "tool.permission.resolved", "context.compact.after", "task.change.after", "user.attention"];
const INTERCEPT = ["session.start", "turn.start", "turn.finish.before", "model.request.before", "tool.before", "tool.after", "tool.permission.request", "context.compact.before", "user.message.inbound"];

const backend = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const wire = (await request.json()) as { id?: string; method: string; params: { event: Event } };
    received.push(wire.params.event);
    if (wire.method === "hooks/observe") return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: wire.id, result: { protocolVersion: "draft", effects: policy(wire.params.event) } });
  },
});

const text = (content: unknown) => typeof content === "string" ? content : ((content ?? []) as { text?: string }[]).map((part) => part.text ?? "").join("\n");

/** A fake OpenAI-compatible model: `CALL <tool> <json>` in the last user text. */
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = (await request.json()) as (typeof requests)[number] & { stream?: boolean };
    requests.push(body);
    const last = body.messages.at(-1)!;
    const call = last.role === "user" ? /CALL (\S+) (\{.*\})/.exec(text(last.content)) : null;
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const frames = call
      ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: call[1], arguments: call[2] } }] }), chunk({}, "tool_calls")]
      : [chunk({ role: "assistant", content: "final answer" }), chunk({}, "stop")];
    frames.push(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`, "data: [DONE]\n\n");
    return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
  },
});

let server: ReturnType<typeof Bun.spawn>;
let base = "";
const api = (path: string, body?: unknown) =>
  fetch(`${base}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const newSession = async () => ((await (await api("/session", {})).json()) as { id: string }).id;
const say = (session: string, words: string) => api(`/session/${session}/message`, { parts: [{ type: "text", text: words }] });
const callTool = (session: string, tool: string, args: unknown) => say(session, `CALL ${tool} ${JSON.stringify(args)}`);
const until = async (done: () => boolean, what: string) => {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > 20000) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const registration = join(root, "hooks.json");
  const content = { default: "body" };
  writeFileSync(registration, JSON.stringify({
    protocolVersion: "draft",
    hooks: [{
      id: "org.example.recorder",
      transport: { type: "http", url: `http://127.0.0.1:${backend.port}/ahp` },
      subscriptions: [
        { mode: "intercept", events: INTERCEPT, timeoutMs: 10000, failurePolicy: "fail-closed", content },
        { mode: "observe", events: OBSERVE, content },
      ],
    }],
  }));
  writeFileSync(join(project, "opencode.json"), JSON.stringify({
    model: "fake/m",
    small_model: "fake/m",
    autoupdate: false,
    share: "disabled",
    plugin: [`file://${REPO}`],
    permission: { bash: { "*": "allow", "ask*": "ask" } },
    mcp: { docs: { type: "local", command: ["bun", join(import.meta.dir, "mcp-server.ts")] } },
    provider: { fake: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "x" }, models: { m: { name: "m", tool_call: true, limit: { context: 100000, output: 1000 } } } } },
  }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  server = Bun.spawn([BIN, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: project,
    stdout: Bun.file(join(root, "serve.log")),
    stderr: Bun.file(join(root, "serve.err")),
    env: {
      PATH: process.env.PATH!,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local/state"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      AHP_HOOKS_FILE: registration,
    },
  });
  for (let attempt = 0; ; attempt++) {
    const up = await fetch(`${base}/session?directory=${encodeURIComponent(project)}`).then((response) => response.ok).catch(() => false);
    if (up) break;
    if (attempt > 240) throw new Error("opencode did not start");
    await Bun.sleep(250);
  }
  // The MCP server connects in the background.
  for (let attempt = 0; attempt < 80; attempt++) {
    const status = await api("/mcp").then((response) => response.json()).catch(() => ({})) as { docs?: { status?: string } };
    if (status.docs?.status === "connected") break;
    await Bun.sleep(250);
  }
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  backend.stop(true);
  model.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("a whole turn reaches the backend in order, under native ids", async () => {
  const session = await newSession();
  const response = await say(session, "hello");
  expect(response.ok).toBe(true);
  await until(() => of("turn.end", session).length === 1, "turn.end");
  const events = received.filter((event) => event.session?.id === session).map((event) => event.type);
  expect(events.slice(0, 2)).toEqual(["session.start", "turn.start"]);
  expect(events.indexOf("turn.start")).toBeLessThan(events.indexOf("model.request.before"));
  expect(events.indexOf("model.request.before")).toBeLessThan(events.indexOf("model.response.after"));
  expect(events.indexOf("model.response.after")).toBeLessThan(events.indexOf("turn.finish.before"));
  expect(events.indexOf("turn.finish.before")).toBeLessThan(events.indexOf("turn.end"));
  const start = of("session.start", session)[0]!;
  expect(start.harness.name).toBe("opencode");
  expect(start.harness.version).toBe(VERSION);
  expect(start.manifest.gaps.length).toBeGreaterThan(0);
  const turn = of("turn.start", session)[0]!;
  expect(turn.turn.id).toStartWith("msg_");
  expect(turn.turn.synthesized).toBeUndefined();
  const end = of("turn.end", session)[0]!;
  expect(end.turn.id).toBe(turn.turn.id);
  expect(end.outcome).toBe("completed");
  expect(JSON.stringify(end.items)).toContain("final answer");
  const answer = of("model.response.after", session)[0]!;
  expect(answer.finishReason).toBe("stop");
  expect(answer.usage.inputTokens).toBe(5);
});

test("a prompt is rewritten and annotated before the model reads it", async () => {
  const session = await newSession();
  await say(session, "REWRITE-PROMPT");
  await until(() => of("turn.end", session).length === 1, "turn.end");
  const request = requests.findLast((body) => (body.tools?.length ?? 0) > 0)!;
  const sent = text(request.messages.at(-1)!.content);
  expect(sent).toContain("the rewritten prompt");
  expect(sent).toContain("injected at turn start");
  expect(sent).not.toContain("REWRITE-PROMPT");
});

test("a refused prompt stops, and the session still works", async () => {
  const session = await newSession();
  const before = requests.length;
  const refused = await say(session, "REFUSE-PROMPT");
  expect(refused.ok).toBe(false);
  expect(requests.length).toBe(before);
  expect(of("turn.end", session)).toHaveLength(0);
  const again = await say(session, "hello again");
  expect(again.ok).toBe(true);
  await until(() => of("turn.end", session).length === 1, "turn.end");
});

test("tool input and output are rewritten for real", async () => {
  const session = await newSession();
  await callTool(session, "bash", { command: "echo rewrite-input", description: "d" });
  await until(() => of("turn.end", session).length === 1, "turn.end");
  const after = of("tool.after", session)[0]!;
  expect(after.outcome).toBe("ok");
  expect(after.parentEventId).toBe(of("tool.before", session)[0]!.id);
  // The command that ran is the rewritten one, and the model reads the rewrite.
  expect(JSON.stringify(after.items)).toContain("rewritten-input");
  const request = requests.findLast((body) => body.messages.at(-1)!.role === "tool")!;
  expect(text(request.messages.at(-1)!.content)).toBe("rewritten output");
  expect(of("tool.batch.after", session)[0]!.calls[0].outcome).toBe("ok");
});

test("a refused tool does not run, and the model reads why", async () => {
  const session = await newSession();
  await callTool(session, "bash", { command: "echo refuse-tool", description: "d" });
  await until(() => of("turn.end", session).length === 1, "turn.end");
  expect(of("tool.after", session)[0]).toMatchObject({ outcome: "denied", execution: { status: "skipped", reason: "policy" } });
  expect(of("tool.after", session)).toHaveLength(1);
  const request = requests.findLast((body) => body.messages.at(-1)!.role === "tool")!;
  expect(text(request.messages.at(-1)!.content)).toContain("refused tool");
});

test("a failing tool is reported as an error", async () => {
  const session = await newSession();
  await callTool(session, "read", { filePath: join(project, "does-not-exist.txt") });
  await until(() => of("tool.after", session).length === 1, "tool.after");
  expect(of("tool.after", session)[0]!.outcome).toBe("error");
  await until(() => of("turn.end", session).length === 1, "turn.end");
});

test("the permission prompt is answered through the reply API", async () => {
  const session = await newSession();
  await callTool(session, "bash", { command: "ask-allowed", description: "d" });
  await until(() => of("turn.end", session).length === 1, "turn.end");
  const request = of("tool.permission.request", session)[0]!;
  expect(request.call.id).toBe(of("tool.before", session)[0]!.call.id);
  expect(of("tool.permission.resolved", session)[0]).toMatchObject({ decision: "allow", decidedBy: "hook" });
  expect(of("user.attention", session)[0]!.attention.kind).toBe("permission");
  expect(of("tool.after", session)[0]!.outcome).toBe("ok");
});

test("a rejected permission reads as denied", async () => {
  const session = await newSession();
  await callTool(session, "bash", { command: "ask reject-me", description: "d" });
  await until(() => of("tool.after", session).length === 1, "tool.after");
  expect(of("tool.after", session)[0]!.outcome).toBe("denied");
  expect(of("tool.permission.resolved", session)[0]).toMatchObject({ decision: "deny", decidedBy: "hook" });
  await until(() => of("turn.end", session).length === 1, "turn.end");
});

test("flow continue runs another pass in the same turn", async () => {
  const session = await newSession();
  continueNext = true;
  await say(session, "hello");
  await until(() => of("turn.end", session).length === 1, "turn.end");
  expect(of("turn.start", session)).toHaveLength(1);
  expect(of("turn.end", session)[0]!.continuationCount).toBe(1);
  expect(of("turn.finish.before", session)).toHaveLength(2);
  const request = requests.findLast((body) => body.messages.some((row) => text(row.content).includes("CONTINUE-PLEASE")));
  expect(request).toBeDefined();
});

test("a subagent shares the session and hangs off its task call", async () => {
  const session = await newSession();
  await callTool(session, "task", {
    description: "sub",
    prompt: `child CALL bash ${JSON.stringify({ command: "echo from-child", description: "d" })}`,
    subagent_type: "general",
  });
  await until(() => of("turn.end", session).length === 2, "both turn.ends");
  const [parent, child] = of("turn.start", session);
  const taskBefore = of("tool.before", session).find((event) => event.tool.name === "task")!;
  expect(parent!.session.agent).toBeUndefined();
  expect(child!.session.agent.type).toBe("general");
  expect(child!.session.agent.id).toStartWith("ses_");
  expect(child!.parentEventId).toBe(taskBefore.id);
  const childTool = of("tool.before", session).find((event) => event.tool.name === "bash")!;
  expect(childTool.session.agent.id).toBe(child!.session.agent.id);
  expect(childTool.turn.id).toBe(child!.turn.id);
  expect(of("session.start", session)).toHaveLength(1);
});

test("compaction takes more instructions and reports its summary", async () => {
  const session = await newSession();
  await say(session, "first");
  await until(() => of("turn.end", session).length === 1, "turn.end");
  const response = await api(`/session/${session}/summarize`, { providerID: "fake", modelID: "m" });
  expect(response.ok).toBe(true);
  await until(() => of("context.compact.after", session).length === 1, "context.compact.after");
  expect(of("context.compact.before", session)[0]!.trigger).toBe("manual");
  expect(JSON.stringify(of("context.compact.after", session)[0]!.summary)).toContain("final answer");
  const request = requests.find((body) => body.messages.some((row) => text(row.content).includes("KEEP-THE-PLAN")));
  expect(request).toBeDefined();
  // A compaction's request is not reported as a turn's model request.
  expect(of("model.request.before", session)).toHaveLength(1);
});

test("an MCP call is described, and its result rewritten in MCP's shape", async () => {
  const session = await newSession();
  await callTool(session, "docs_search", { q: "rewrite-mcp" });
  await until(() => of("turn.end", session).length === 1, "turn.end");
  expect(of("tool.before", session)[0]).toMatchObject({ path: "mcp", tool: { origin: "mcp", mcp: { server: { id: "docs" }, toolName: "search", connection: { transport: "stdio" } } } });
  expect(JSON.stringify(of("tool.after", session)[0]!.items)).toContain("mcp result for rewrite-mcp");
  const request = requests.findLast((body) => body.messages.at(-1)!.role === "tool")!;
  expect(text(request.messages.at(-1)!.content)).toBe("rewritten mcp output");
});

test("a deleted session ends", async () => {
  const session = await newSession();
  await say(session, "hello");
  await until(() => of("turn.end", session).length === 1, "turn.end");
  await fetch(`${base}/session/${session}?directory=${encodeURIComponent(project)}`, { method: "DELETE" });
  await until(() => of("session.end", session).length === 1, "session.end");
  expect(of("session.end", session)[0]).toMatchObject({ reason: "deleted", outcome: "completed" });
});
