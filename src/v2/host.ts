// The parts of OpenCode 2's plugin context this adapter uses. `@opencode/plugin`
// ships TypeScript source with the whole of OpenCode's schema behind it, so these
// are declared here and held to the real thing by the end-to-end test.
export type Hook<Event> = (callback: (event: Event) => Promise<void> | void) => Promise<unknown>;

export type ContentPart = { type: string; text?: string; mediaType?: string; data?: unknown; [key: string]: unknown };
export type RequestMessage = { id?: string; role: string; content: string | ContentPart[]; [key: string]: unknown };
export type ToolContent = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string };
export type ContextRow = { id: string; type: string; text?: string; content?: ContentPart[]; model?: { id: string; providerID: string } };

export type ToolBefore = { tool: string; sessionID: string; agent: string; messageID: string; id: string; input: unknown };
export type ToolAfter = { tool: string; sessionID: string; agent: string; messageID: string; id: string; input: unknown } & (
  | { status: "completed"; result: { output?: unknown; content?: string | ToolContent[]; metadata?: unknown } }
  | { status: "error"; error: { message: string; error?: { _tag?: string } } }
);
export type Evaluation = {
  sessionID: string;
  agent?: string;
  action: string;
  resources: readonly string[];
  metadata?: Record<string, unknown>;
  source?: { type: "tool"; messageID: string; id: string };
  effect: "allow" | "deny" | "ask";
  message?: string;
};
export type PromptEvent = { sessionID: string; messageID: string; prompt: { text: string; files?: { uri: string; name?: string }[] }; delivery: string };
export type ContextEvent = {
  sessionID: string;
  agent: string;
  model: { id: string; providerID: string };
  system: { type: string; text?: string }[];
  messages: RequestMessage[];
  options: Record<string, unknown>;
  tools: Record<string, unknown>;
};
export type CompactionEvent = {
  sessionID: string;
  agent: string;
  model: { id: string; providerID: string };
  system: { type: string; text?: string }[];
  messages: RequestMessage[];
  result?: { summary: string };
};
export type IdleEvent = { sessionID: string; background: readonly { kind: string; sessionID: string }[] };
export type BusEvent = { type: string; data: Record<string, any>; location?: { directory?: string } };

export interface Context {
  app: { version: string };
  location: { directory: string; project?: { directory?: string } };
  event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<BusEvent> };
  mcp: {
    transform(callback: (editor: { list(): readonly [string, Record<string, unknown>][] }) => void): Promise<unknown>;
  };
  permission: {
    hook(name: "evaluate", callback: (event: Evaluation) => Promise<void> | void): Promise<unknown>;
  };
  session: {
    get(input: { sessionID: string }): Promise<{ parentID?: string; agent?: string; model?: { id: string; providerID: string } }>;
    context(input: { sessionID: string }): Promise<readonly ContextRow[]>;
    synthetic(input: { sessionID: string; text: string; resume?: boolean }): Promise<unknown>;
    interrupt(input: { sessionID: string }): Promise<unknown>;
    hook(name: "prompt", callback: (event: PromptEvent) => Promise<void> | void): Promise<unknown>;
    hook(name: "context", callback: (event: ContextEvent) => Promise<void> | void): Promise<unknown>;
    hook(name: "compaction", callback: (event: CompactionEvent) => Promise<void> | void): Promise<unknown>;
    hook(name: "experimental.idle", callback: (event: IdleEvent) => Promise<void> | void): Promise<unknown>;
  };
  tool: {
    list(): Promise<readonly { id: string; options?: { namespace?: string } }[]>;
    hook(name: "execute.before", callback: (event: ToolBefore) => Promise<void> | void): Promise<unknown>;
    hook(name: "execute.after", callback: (event: ToolAfter) => Promise<void> | void): Promise<unknown>;
  };
}
