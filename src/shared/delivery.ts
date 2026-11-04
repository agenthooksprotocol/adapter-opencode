// The AHP client: one per plugin instance, for either OpenCode flavour. OpenCode
// runs plugins in-process on Bun with its whole runtime, so the SDK's own fetch,
// stdio and environment access apply: nothing here is shimmed.
import { Hooks, type HostCapabilities } from "agenthooksprotocol/client";

export const SOURCE = "urn:opencode:opencode";
export const EXTENSION = "ai.opencode";
export const MAX_CONTINUATIONS = 8;

const contentCategories = ["text", "reasoning", "instructions", "attachment", "summary", "system", "tool_call", "tool_result"];

export function createHooks(
  registration: { protocolVersion: "draft"; hooks: Record<string, unknown>[] },
  version: string,
  capabilities: HostCapabilities,
  gaps: { path: string; reason: string }[],
): Hooks {
  return new Hooks(registration, {
    source: SOURCE,
    harness: { name: "opencode", version },
    capabilities,
    manifestMetadata: {
      authentication: ["bearer", "oauth"],
      contentCategories,
      correlationIdentityFields: ["session.id", "turn.id", "call.id", "parentEventId", "session.agent.id"],
      gaps,
      limits: { maxContinuations: MAX_CONTINUATIONS },
      managedPolicy: { disableable: true, scopes: ["user", "project"] },
      toolPaths: ["native", "mcp"],
      transports: ["http", "stdio"],
    },
  });
}
