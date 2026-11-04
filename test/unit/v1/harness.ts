// The world beneath the adapter in a unit test: a real AHP backend on a local
// port, a registration pointing at it, and a fake of the OpenCode client.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../../../src/index.ts";

export type Effect = Record<string, unknown>;
export type Wire = { id?: string; method: string; params: { event: Record<string, any> & { type: string }; capabilities?: Record<string, any> } };

export interface World {
  /** The backend's answer to each intercept. */
  respond?: (event: Wire["params"]["event"], request: Wire) => Effect[] | undefined;
  events?: string[];
  mode?: "intercept" | "observe";
  failurePolicy?: "fail-open" | "fail-closed";
  /** session.get answers by id. */
  sessions?: Record<string, { parentID?: string; directory?: string }>;
  /** session.messages answers by session id. */
  transcript?: Record<string, { info: Record<string, any>; parts: Record<string, any>[] }[]>;
  mcp?: Record<string, unknown>;
  upload?: boolean;
  unreachable?: boolean;
}

export const ALL_EVENTS = [
  "session.start", "session.end", "turn.start", "turn.finish.before", "turn.end", "turn.progress",
  "model.request.before", "model.response.after", "model.error", "model.switch.before", "model.switch.after",
  "tool.before", "tool.after", "tool.progress", "tool.batch.after", "tool.permission.request", "tool.permission.resolved",
  "context.compact.before", "context.compact.after", "task.change.after", "file.changed", "user.attention", "user.message.inbound",
];

const OBSERVE_ONLY = new Set(["session.end", "turn.end", "turn.progress", "model.response.after", "model.error", "model.switch.after", "tool.progress", "tool.batch.after", "tool.permission.resolved", "context.compact.after", "task.change.after", "file.changed", "user.attention"]);

export async function world(options: World = {}) {
  const received: Wire[] = [];
  const uploads: { body: Uint8Array; headers: Headers }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/content") {
        const body = new Uint8Array(await request.arrayBuffer());
        uploads.push({ body, headers: request.headers });
        const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
        return Response.json({ ref: `urn:test:${uploads.length}`, size: body.length, sha256 }, { status: 201 });
      }
      const wire = (await request.json()) as Wire;
      received.push(wire);
      if (wire.method === "hooks/observe") return new Response(null, { status: 202 });
      const effects = options.respond?.(wire.params.event, wire) ?? [];
      return Response.json({ jsonrpc: "2.0", id: wire.id, result: { protocolVersion: "draft", effects } });
    },
  });
  const url = options.unreachable ? "http://127.0.0.1:9/ahp" : `http://127.0.0.1:${server.port}/ahp`;
  const events = options.events ?? ALL_EVENTS;
  const mode = options.mode ?? "intercept";
  const intercepted = events.filter((event) => !OBSERVE_ONLY.has(event));
  const observed = mode === "observe" ? events : events.filter((event) => OBSERVE_ONLY.has(event));
  const content = { default: "body" };
  const upload = options.upload ? { upload: { endpoint: `http://127.0.0.1:${server.port}/content`, timeoutMs: 5000, maxBytes: 1048576 } } : {};
  const subscriptions = [
    ...(mode === "intercept" && intercepted.length ? [{ mode: "intercept", events: intercepted, timeoutMs: 5000, failurePolicy: options.failurePolicy ?? "fail-closed", content, ...upload }] : []),
    ...(observed.length ? [{ mode: "observe", events: observed, content, ...upload }] : []),
  ];
  const directory = mkdtempSync(join(tmpdir(), "ahp-opencode-"));
  const file = join(directory, "hooks.json");
  writeFileSync(file, JSON.stringify({ protocolVersion: "draft", hooks: [{ id: "org.example.backend", transport: { type: "http", url }, subscriptions }] }));
  process.env.AHP_HOOKS_FILE = file;

  const calls = {
    promptAsync: [] as any[],
    permissions: [] as any[],
    aborts: [] as string[],
    toasts: [] as any[],
    logs: [] as any[],
  };
  const client = {
    _client: { get: async () => ({ data: { version: "1.19.5" } }) },
    app: { log: async (o: any) => { calls.logs.push(o.body); return {}; } },
    tui: { showToast: async (o: any) => { calls.toasts.push(o.body); return {}; } },
    config: { get: async () => ({ data: { mcp: options.mcp ?? {} } }) },
    session: {
      get: async ({ path }: any) => ({ data: options.sessions?.[path.id] ?? { directory } }),
      messages: async ({ path }: any) => ({ data: options.transcript?.[path.id] ?? [] }),
      message: async ({ path }: any) => ({ data: (options.transcript?.[path.id] ?? []).find((row) => row.info.id === path.messageID) }),
      promptAsync: async (o: any) => { calls.promptAsync.push(o); return {}; },
      abort: async ({ path }: any) => { calls.aborts.push(path.id); return {}; },
    },
    postSessionIdPermissionsPermissionId: async (o: any) => { calls.permissions.push(o); return {}; },
  };
  const hooks = (await plugin.server({ client, directory, worktree: directory, project: {}, serverUrl: new URL("http://localhost:4096") } as never)) as Record<string, any>;
  const bus = (type: string, properties: unknown) => hooks.event({ event: { type, properties } });
  const settled = async () => {
    // Bus work is not awaited by OpenCode: let the session queues run dry.
    for (let round = 0; round < 8; round++) await new Promise((resolve) => setTimeout(resolve, 15));
  };
  return {
    hooks, bus, settled, calls, received, uploads, directory,
    of: (type: string) => received.filter((wire) => wire.params?.event?.type === type).map((wire) => wire.params.event),
    types: () => received.filter((wire) => wire.params?.event).map((wire) => wire.params.event.type),
    close: async () => { await hooks.dispose(); server.stop(true); delete process.env.AHP_HOOKS_FILE; },
  };
}

export type TestWorld = Awaited<ReturnType<typeof world>>;

/** One prompt as OpenCode hands it to chat.message. */
export function prompt(sessionID: string, id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    input: { sessionID, messageID: id, ...extra },
    output: {
      message: { id, role: "user", sessionID, time: { created: 1 }, agent: "build", model: { providerID: "fake", modelID: "m" } },
      parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text }],
    },
  };
}

export async function say(w: TestWorld, sessionID: string, id: string, text: string, extra: Record<string, unknown> = {}) {
  const { input, output } = prompt(sessionID, id, text, extra);
  await w.hooks["chat.message"](input, output);
  return output;
}

export function deny(reason: string): Effect {
  return { type: "deny", reason };
}
