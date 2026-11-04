// The adapter inside a real OpenCode 2. As in opencode1.test.ts: an isolated home,
// a local fake model and a recording backend, so nothing real is reached. OpenCode 2
// is not on npm's opencode-ai: OPENCODE2_BIN names it, ~/.opencode/bin by default.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = process.env.OPENCODE2_BIN ?? join(homedir(), ".opencode/bin/opencode");
const VERSION = existsSync(BIN) ? Bun.spawnSync([BIN, "--version"], { stdin: "ignore" }).stdout.toString().trim().replace(/^.*?v?(\d+\.\d+\.\S+)$/, "$1") : "";
const REPO = resolve(import.meta.dir, "../..");
const PASSWORD = "e2e-password";
const MCP_SERVER = join(import.meta.dir, "mcp-server.ts");

type Event = Record<string, any> & { type: string };
const received: Event[] = [];
const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[]; temperature?: number }[] = [];
const of = (type: string, session?: string) => received.filter((event) => event.type === type && (!session || event.session?.id === session));
let continueNext = false;
let compaction: "instructions" | "return" | "deny" = "instructions";

const inject = (event: Event, text: string) => ({ type: "inject", target: "context", operation: "append", deliverAt: "now", value: [{ id: `i-${event.id}`, role: "user", parts: [{ id: `i-${event.id}#0`, kind: "text", mediaType: "text/plain", selection: "body", text }] }] });

const policy = (event: Event): unknown[] => {
  const words = JSON.stringify(event.items ?? event.tool?.input ?? "");
  switch (event.type) {
    case "session.start":
      return startContext ? [inject(event, startContext)] : [];
    case "turn.start":
      if (words.includes("REFUSE-PROMPT")) return [{ type: "deny", reason: "refused prompt" }];
      if (words.includes("REWRITE-PROMPT")) {
        const item = event.items[0];
        return [
          { type: "modify", target: "prompt", operation: "replace", value: [{ ...item, parts: [{ ...item.parts[0], text: "the rewritten prompt" }] }] },
          inject(event, "injected at turn start"),
        ];
      }
      return [];
    case "model.request.before": {
      if (words.includes("REFUSE-REQUEST")) return [{ type: "deny", reason: "refused request" }];
      if (words.includes("EDIT-REQUEST")) {
        return [{
          type: "modify", target: "request", operation: "replace",
          value: event.items.map((item: any) => item.role === "user" ? { ...item, parts: item.parts.map((part: any) => ({ ...part, text: "edited request" })) } : item),
        }, inject(event, "injected into the request")];
      }
      return [];
    }
    case "tool.before":
      if (words.includes("echo refuse-tool") || (event.tool.name === "docs_search" && words.includes("refuse-mcp"))) return [{ type: "deny", reason: "refused tool" }];
      if (words.includes("echo rewrite-input")) return [{ type: "modify", target: "input", operation: "replace", value: { ...event.tool.input, command: "echo rewritten-input" } }];
      if (words.includes("echo force-ask")) return [{ type: "ask" }];
      if (words.includes("echo inject-tool")) return [inject(event, "injected at tool before")];
      return [];
    case "tool.after":
      if (JSON.stringify(event.items).includes("rewritten-input")) {
        const item = event.items[0];
        return [{ type: "modify", target: "output", operation: "replace", value: [{ ...item, parts: [{ ...item.parts[0], text: "rewritten output" }] }] }];
      }
      return [];
    case "tool.permission.request":
      return JSON.stringify(event.tool.input).includes("reject") ? [{ type: "deny", reason: "rejected by backend" }] : [{ type: "allow" }];
    case "turn.finish.before":
      if (continueNext) {
        continueNext = false;
        return [{ type: "flow", operation: "continue", instruction: "CONTINUE-PLEASE" }];
      }
      return [];
    case "context.compact.before":
      if (compaction === "deny") return [{ type: "deny", reason: "no compaction" }];
      if (compaction === "return") return [{ type: "return", value: [{ id: "s", kind: "text", mediaType: "text/plain", selection: "body", text: "SUPPLIED-SUMMARY" }] }];
      return [{ type: "modify", target: "instructions", operation: "merge", value: [{ id: "c", kind: "text", mediaType: "text/plain", selection: "body", text: "KEEP-THE-PLAN" }] }];
    default:
      return [];
  }
};
let startContext: string | undefined;

const OBSERVE = ["session.end", "turn.end", "model.response.after", "tool.batch.after", "tool.permission.resolved", "context.compact.after", "task.change.after", "user.attention", "tool.progress"];
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

const text = (content: unknown) => (typeof content === "string" ? content : ((content ?? []) as { text?: string }[]).map((part) => part.text ?? "").join("\n"));

const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = (await request.json()) as (typeof requests)[number];
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

const root = realpathSync(mkdtempSync(join(tmpdir(), "ahp-opencode2-e2e-")));
const home = join(root, "home");
const project = join(root, "project");
let server: ReturnType<typeof Bun.spawn>;
let base = "";
const headers = { "content-type": "application/json", authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}` };
const api = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const newSession = async () => ((await (await api("POST", "/api/session", { location: { directory: project } })).json()) as { data: { id: string } }).data.id;
const prompt = (session: string, words: string) => api("POST", `/api/session/${session}/prompt`, { text: words });
const wait = (session: string) => api("POST", `/api/experimental/session/${session}/wait`);
const say = async (session: string, words: string) => {
  const response = await prompt(session, words);
  await wait(session);
  return response;
};
const callTool = (session: string, tool: string, args: unknown) => say(session, `CALL ${tool} ${JSON.stringify(args)}`);
const until = async (done: () => boolean, what: string) => {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > 20000) throw new Error(`timed out waiting for ${what}; saw ${received.map((event) => event.type).slice(-12).join(",")}`);
    await Bun.sleep(25);
  }
};
const turnEnded = (session: string, count = 1) => until(() => of("turn.end", session).length === count, "turn.end");

describe.skipIf(!VERSION.startsWith("2."))(`OpenCode ${VERSION}`, () => {
  beforeAll(async () => {
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: project, stdin: "ignore" });
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
      plugins: [REPO],
      permissions: [{ action: "shell", resource: "ask*", effect: "ask" }],
      mcp: {
        docs: { type: "local", command: ["bun", MCP_SERVER] },
        direct: { type: "local", command: ["bun", MCP_SERVER], codemode: false },
      },
      providers: { fake: { package: "@opencode/ai/providers/openai/chat", settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "x" }, models: { m: { name: "m", limit: { context: 100000, output: 1000 } } } } },
    }));
    const port = 20000 + Math.floor(Math.random() * 20000);
    base = `http://127.0.0.1:${port}`;
    server = Bun.spawn([BIN, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: project,
      stdin: "ignore",
      stdout: Bun.file(join(root, "serve.log")),
      stderr: Bun.file(join(root, "serve.err")),
      env: {
        PATH: process.env.PATH!,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_STATE_HOME: join(home, ".local/state"),
        OPENCODE_SERVER_PASSWORD: PASSWORD,
        AHP_HOOKS_FILE: registration,
      },
    });
    for (let attempt = 0; ; attempt++) {
      const up = await api("GET", "/api/session").then((response) => response.ok).catch(() => false);
      if (up) break;
      if (attempt > 240) throw new Error("opencode did not start");
      await Bun.sleep(250);
    }
    // MCP servers connect in the background: their tools are there when listed.
    for (let attempt = 0; attempt < 80; attempt++) {
      const servers = await api("GET", `/api/mcp?directory=${encodeURIComponent(project)}`).then((response) => response.json()).catch(() => undefined) as { data?: { status?: { status?: string } }[] } | undefined;
      if (servers?.data?.length === 2 && servers.data.every((server) => server.status?.status === "connected")) break;
      await Bun.sleep(250);
    }
  }, 90000);

  afterAll(async () => {
    server?.kill();
    await server?.exited;
    backend.stop(true);
    model.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("a whole turn reaches the backend in order, under native ids", async () => {
    const session = await newSession();
    expect((await say(session, "hello")).ok).toBe(true);
    await turnEnded(session);
    const events = received.filter((event) => event.session?.id === session).map((event) => event.type);
    expect(events.slice(0, 2)).toEqual(["session.start", "turn.start"]);
    expect(events.indexOf("turn.start")).toBeLessThan(events.indexOf("model.request.before"));
    expect(events.indexOf("model.request.before")).toBeLessThan(events.indexOf("turn.finish.before"));
    expect(events.indexOf("turn.finish.before")).toBeLessThan(events.indexOf("turn.end"));
    const start = of("session.start", session)[0]!;
    expect(start.harness).toMatchObject({ name: "opencode", version: VERSION });
    expect(start.trigger).toBe("startup");
    expect(start.manifest.gaps.map((gap: any) => gap.path)).toContain("tool.before.return");
    const turn = of("turn.start", session)[0]!;
    expect(turn.turn.id).toStartWith("msg_");
    const end = of("turn.end", session)[0]!;
    expect(end).toMatchObject({ outcome: "completed", turn: { id: turn.turn.id } });
    expect(JSON.stringify(end.items)).toContain("final answer");
    await until(() => of("model.response.after", session).length === 1, "model.response.after");
    expect(of("model.response.after", session)[0]).toMatchObject({ finishReason: "stop", usage: { inputTokens: 5 } });
  });

  test("the system prompt, options and tools are on every model request", async () => {
    const session = await newSession();
    await say(session, "hello");
    await turnEnded(session);
    const request = of("model.request.before", session)[0]!;
    expect(request.items[0].role).toBe("system");
    expect(JSON.stringify(request.items[0])).toContain("OpenCode");
    expect(request.gaps ?? []).toEqual([]);
    expect(request.params.agent).toBe("build");
    expect(request.params.tools).toContain("shell");
  });

  test("a prompt is rewritten, and context arrives as a durable message", async () => {
    const session = await newSession();
    await say(session, "REWRITE-PROMPT");
    await turnEnded(session);
    const sent = requests.findLast((body) => (body.tools?.length ?? 0) > 0)!.messages.map((row) => text(row.content)).join("\n");
    expect(sent).toContain("the rewritten prompt");
    expect(sent).toContain("injected at turn start");
    expect(sent).not.toContain("REWRITE-PROMPT");
    await say(session, "again");
    await turnEnded(session, 2);
    expect(requests.findLast((body) => (body.tools?.length ?? 0) > 0)!.messages.map((row) => text(row.content)).join("\n")).toContain("injected at turn start");
  });

  test("session.start's context reaches the first request", async () => {
    startContext = "startup context";
    const session = await newSession();
    await say(session, "hello");
    startContext = undefined;
    await turnEnded(session);
    expect(requests.findLast((body) => (body.tools?.length ?? 0) > 0)!.messages.map((row) => text(row.content)).join("\n")).toContain("startup context");
  });

  test("a refused prompt stops, and the session still works", async () => {
    const session = await newSession();
    const before = requests.length;
    expect((await prompt(session, "REFUSE-PROMPT")).ok).toBe(false);
    expect(requests.length).toBe(before);
    expect(of("turn.end", session)).toHaveLength(0);
    expect((await say(session, "hello again")).ok).toBe(true);
    await turnEnded(session);
  });

  test("a model request is rewritten and annotated", async () => {
    const session = await newSession();
    await say(session, "EDIT-REQUEST");
    await turnEnded(session);
    const body = requests.findLast((row) => (row.tools?.length ?? 0) > 0)!;
    const sent = body.messages.map((row) => text(row.content)).join("\n");
    expect(sent).toContain("edited request");
    expect(sent).not.toContain("EDIT-REQUEST");
    expect(sent).toContain("injected into the request");
  });

  test("a refused model request fails the turn", async () => {
    const session = await newSession();
    const before = requests.filter((row) => (row.tools?.length ?? 0) > 0).length;
    await say(session, "REFUSE-REQUEST");
    await turnEnded(session);
    expect(requests.filter((row) => (row.tools?.length ?? 0) > 0).length).toBe(before);
    expect(of("turn.end", session)[0]).toMatchObject({ outcome: "failed" });
    expect(of("turn.end", session)[0]!.error.message).toContain("refused request");
  });

  test("tool input and output are rewritten for real", async () => {
    const session = await newSession();
    await callTool(session, "shell", { command: "echo rewrite-input", description: "d" });
    await turnEnded(session);
    const after = of("tool.after", session)[0]!;
    expect(after.outcome).toBe("ok");
    expect(after.parentEventId).toBe(of("tool.before", session)[0]!.id);
    expect(JSON.stringify(after.items)).toContain("rewritten-input");
    const body = requests.findLast((row) => row.messages.at(-1)!.role === "tool")!;
    expect(text(body.messages.at(-1)!.content)).toBe("rewritten output");
    await until(() => of("tool.batch.after", session).length === 1, "tool.batch.after");
    expect(of("tool.batch.after", session)[0]!.calls[0]).toMatchObject({ outcome: "ok", tool: { name: "shell" } });
  });

  test("a refused tool does not run, and the model reads why", async () => {
    const session = await newSession();
    await callTool(session, "shell", { command: "echo refuse-tool", description: "d" });
    await turnEnded(session);
    expect(of("tool.after", session)).toHaveLength(1);
    expect(of("tool.after", session)[0]).toMatchObject({ outcome: "denied", execution: { status: "skipped", reason: "policy" } });
    expect(text(requests.findLast((row) => row.messages.at(-1)!.role === "tool")!.messages.at(-1)!.content)).toContain("refused tool");
  });

  test("a failing tool is reported through the after hook", async () => {
    const session = await newSession();
    await callTool(session, "read", { path: join(project, "does-not-exist.txt") });
    await turnEnded(session);
    expect(of("tool.after", session)[0]).toMatchObject({ outcome: "error", error: { class: "ToolError" } });
  });

  test("context from tool.before lands after the result", async () => {
    const session = await newSession();
    await callTool(session, "shell", { command: "echo inject-tool", description: "d" });
    await turnEnded(session);
    const sent = requests.findLast((row) => (row.tools?.length ?? 0) > 0)!.messages.map((row) => text(row.content)).join("\n");
    expect(sent).toContain("injected at tool before");
  });

  test("a configured ask goes to the backend, whose allow answers it", async () => {
    const session = await newSession();
    await callTool(session, "shell", { command: "ask-allowed", description: "d" });
    await turnEnded(session);
    expect(of("tool.permission.request", session)[0]!.call.id).toBe(of("tool.before", session)[0]!.call.id);
    expect(of("tool.permission.resolved", session)[0]).toMatchObject({ decision: "allow", decidedBy: "hook" });
    expect(of("tool.after", session)[0]!.execution.status).toBe("executed");
  });

  test("a backend's deny refuses the call, with its reason", async () => {
    const session = await newSession();
    await callTool(session, "shell", { command: "ask reject-me", description: "d" });
    await turnEnded(session);
    expect(of("tool.permission.resolved", session)[0]).toMatchObject({ decision: "deny", decidedBy: "hook" });
    expect(of("tool.after", session)[0]!.outcome).toBe("denied");
    expect(text(requests.findLast((row) => row.messages.at(-1)!.role === "tool")!.messages.at(-1)!.content)).toContain("rejected by backend");
  });

  test("tool.before's ask raises a permission request a configured allow would skip", async () => {
    const session = await newSession();
    await callTool(session, "shell", { command: "echo force-ask", description: "d" });
    await turnEnded(session);
    expect(of("tool.permission.request", session)).toHaveLength(1);
  });

  test("an ordinary allowed call reports its policy decision", async () => {
    const session = await newSession();
    await callTool(session, "shell", { command: "echo plain", description: "d" });
    await turnEnded(session);
    expect(of("tool.permission.request", session)).toHaveLength(0);
    expect(of("tool.permission.resolved", session)[0]).toMatchObject({ decision: "allow", decidedBy: "policy" });
  });

  test("flow continue runs another pass in the same execution and turn", async () => {
    const session = await newSession();
    continueNext = true;
    await say(session, "hello");
    await turnEnded(session);
    expect(of("turn.start", session)).toHaveLength(1);
    expect(of("turn.finish.before", session)).toHaveLength(2);
    expect(of("turn.end", session)[0]!.continuationCount).toBe(1);
    expect(requests.some((body) => body.messages.some((row) => text(row.content).includes("CONTINUE-PLEASE")))).toBe(true);
  });

  test("a subagent shares the session and hangs off its call", async () => {
    const session = await newSession();
    await callTool(session, "subagent", {
      description: "sub",
      prompt: `child CALL shell ${JSON.stringify({ command: "echo from-child", description: "d" })}`,
      agent: "general",
    });
    await turnEnded(session, 2);
    const [parent, child] = of("turn.start", session);
    const call = of("tool.before", session).find((event) => event.tool.name === "subagent")!;
    expect(parent!.session.agent).toBeUndefined();
    expect(child!.session.agent.type).toBe("general");
    expect(child!.session.agent.id).toStartWith("ses_");
    expect(child!.parentEventId).toBe(call.id);
    const nested = of("tool.before", session).find((event) => event.tool.name === "shell")!;
    expect(nested.session.agent.id).toBe(child!.session.agent.id);
    expect(nested.turn.id).toBe(child!.turn.id);
    expect(of("session.start", session)).toHaveLength(1);
  });

  test("a direct MCP call says which server it reached, without its credentials", async () => {
    const session = await newSession();
    await callTool(session, "direct_search", { q: "one" });
    await turnEnded(session);
    const before = of("tool.before", session)[0]!;
    expect(before.path).toBe("mcp");
    expect(before.tool).toMatchObject({ name: "direct_search", origin: "mcp", mcp: { provenance: "runtime", server: { id: "direct" }, toolName: "search", connection: { transport: "stdio" } } });
    expect(JSON.stringify(before.tool.mcp)).not.toContain("mcp-server.ts");
    expect(JSON.stringify(of("tool.after", session)[0]!.items)).toContain("mcp result for one");
  });

  test("code mode's MCP calls get ids of their own, under the execute call", async () => {
    const session = await newSession();
    await callTool(session, "execute", { code: 'await tools.docs.search({q:"two"}); return await tools.docs.search({q:"three"})' });
    await turnEnded(session);
    const before = of("tool.before", session);
    const outer = before.find((event) => event.tool.name === "execute")!;
    const inner = before.filter((event) => event.tool.name === "docs_search");
    expect(outer.tool.origin).toBe("native");
    expect(inner).toHaveLength(2);
    expect(inner[0]!.tool).toMatchObject({ origin: "mcp", mcp: { server: { id: "docs" }, toolName: "search" } });
    expect(inner[0]!.parentEventId).toBe(outer.id);
    expect(new Set([outer.call.id, inner[0]!.call.id, inner[1]!.call.id]).size).toBe(3);
    expect(inner[0]!.call.synthesized).toBe(true);
    const after = of("tool.after", session);
    expect(after.map((event) => event.tool.name).sort()).toEqual(["docs_search", "docs_search", "execute"]);
    expect(after.find((event) => event.call.id === outer.call.id)!.tool.name).toBe("execute");
    expect(after.find((event) => event.call.id === inner[1]!.call.id)!.parentEventId).toBe(inner[1]!.id);
  });

  test("a refused MCP call inside code mode is refused", async () => {
    const session = await newSession();
    await callTool(session, "execute", { code: 'return await tools.docs.search({q:"refuse-mcp"})' });
    await turnEnded(session);
    expect(of("tool.after", session).find((event) => event.tool.name === "docs_search")).toMatchObject({ outcome: "denied" });
  });

  test("compaction takes more instructions", async () => {
    compaction = "instructions";
    const session = await newSession();
    await say(session, "first");
    await turnEnded(session);
    expect((await api("POST", `/api/session/${session}/compact`, {})).ok).toBe(true);
    await until(() => of("context.compact.before", session).length === 1, "context.compact.before");
    await until(() => requests.some((body) => body.messages.some((row) => text(row.content).includes("KEEP-THE-PLAN"))), "instructions in a request");
    expect(of("context.compact.before", session)[0]!.trigger).toBe("manual");
  });

  test("compaction takes a backend's summary, without a model request", async () => {
    compaction = "return";
    const session = await newSession();
    await say(session, "first");
    await turnEnded(session);
    const before = requests.length;
    await api("POST", `/api/session/${session}/compact`, {});
    await until(() => of("context.compact.after", session).length === 1, "context.compact.after");
    expect(requests.length).toBe(before);
    expect(JSON.stringify(of("context.compact.after", session)[0]!.summary)).toContain("SUPPLIED-SUMMARY");
  });

  test("a refused compaction leaves the session working", async () => {
    compaction = "deny";
    const session = await newSession();
    await say(session, "first");
    await turnEnded(session);
    await api("POST", `/api/session/${session}/compact`, {});
    await until(() => of("context.compact.before", session).length === 1, "context.compact.before");
    await wait(session);
    expect(of("context.compact.after", session)).toHaveLength(0);
    compaction = "instructions";
    await say(session, "after");
    await turnEnded(session, 2);
    expect(of("turn.end", session)[1]!.outcome).toBe("completed");
  });

  test("a deleted session ends", async () => {
    const session = await newSession();
    await say(session, "hello");
    await turnEnded(session);
    await api("DELETE", `/api/session/${session}`);
    await until(() => of("session.end", session).length === 1, "session.end");
    expect(of("session.end", session)[0]).toMatchObject({ reason: "deleted", outcome: "completed" });
  });
});
