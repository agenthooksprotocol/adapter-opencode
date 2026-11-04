// What this adapter can enforce through OpenCode 2's plugin API, and what it
// cannot. A server plugin has no surface to show a person anything, so no event
// here advertises `message`.
import { capabilityCount, type HostCapabilities } from "agenthooksprotocol/client";
import { MAX_CONTINUATIONS } from "../shared/delivery.js";

const injectNow = { context: { append: true, deliverAt: ["now"] } } as const;

export const capabilities = {
  // A synthetic message is durable and arrives where it was sent.
  sessionStart: { observe: true, intercept: { inject: injectNow } },
  sessionEnd: { observe: true },

  // session `prompt`.
  turnStart: { observe: true, intercept: { deny: true, modifyPrompt: "replace", inject: injectNow } },
  turnProgress: { observe: true },
  // session `experimental.idle`: a synthetic message continues the execution.
  turnFinishBefore: {
    observe: true,
    intercept: {
      flow: {
        operations: ["continue", "stop"],
        remainingContinuations: capabilityCount(MAX_CONTINUATIONS),
        continuationCount: capabilityCount(0),
        maxContinuations: capabilityCount(MAX_CONTINUATIONS),
      },
    },
  },
  turnEnd: { observe: true },

  // session `context`: the whole request, immediately before dispatch.
  modelRequestBefore: { observe: true, intercept: { deny: true, modifyRequest: "replace", inject: injectNow } },
  modelResponseAfter: { observe: true },
  modelError: { observe: true },
  modelSwitchAfter: { observe: true },

  // tool `execute.*`; allow and ask land on permission `evaluate`.
  toolBefore: { observe: true, intercept: { deny: true, allow: true, ask: true, modifyInput: "replace-and-merge", inject: injectNow } },
  toolAfter: { observe: true, intercept: { modifyOutput: "replace-and-merge", inject: injectNow } },
  toolProgress: { observe: true },
  toolBatchAfter: { observe: true },
  toolPermissionRequest: { observe: true, intercept: { allow: true, deny: true, flow: { operations: ["stop"] } } },
  toolPermissionResolved: { observe: true },

  // session `compaction`.
  contextCompactBefore: { observe: true, intercept: { deny: true, modifyInstructions: "merge", returnResult: true } },
  contextCompactAfter: { observe: true },

  taskChangeAfter: { observe: true },
  fileChanged: { observe: true },
  userAttention: { observe: true },
  userMessageInbound: { observe: true, intercept: { deny: true, modifyPrompt: "replace" } },
  hookFailure: { observe: true },
} satisfies HostCapabilities;

/** Coverage OpenCode 2's plugin API does not reach, as manifest gaps. */
export const gaps = [
  { path: "message", reason: "a server plugin has no surface to show a person a message" },
  { path: "tool.before.return", reason: "a plugin cannot skip a tool and supply its result: a wrapper must honour the tool's declared output, and a stand-in tool would be visible to the model" },
  { path: "tool.permission.request.modify", reason: "the permission hook carries no tool input" },
  { path: "tool.after.flow.continue", reason: "OpenCode has no continuation after a single tool result" },
  { path: "tool.batch.after.effects", reason: "a step's end is a bus event: it is observed, not answered" },
  { path: "tool.call.delegated", reason: "code mode's calls reuse the id of the execute call that makes them: they are reported under synthesized ids, as children of that call" },
  { path: "turn.finish.before.modify", reason: "the answer is recorded before the idle hook runs" },
  { path: "model.request.before.params", reason: "AHP's modify targets messages: options are reported but not rewritten" },
  { path: "model.request.before.housekeeping", reason: "title requests run outside the session's loop and are not reported" },
  { path: "model.response.after.effects", reason: "a streamed response is observed after the step; it is not rewritten" },
  { path: "model.switch.before", reason: "a model selection raises only an event, after the fact" },
  { path: "context.compact.before.modify.replace", reason: "OpenCode's compaction instructions are its system prompt: a backend can add to them" },
  { path: "context.compact.after.removed", reason: "OpenCode does not report which messages a compaction replaced" },
  { path: "config.change", reason: "configuration changes are not mapped" },
  { path: "workspace.change", reason: "a plugin instance belongs to one location; moves are not mapped" },
  { path: "task.change.before", reason: "the todo list changes through the todowrite tool: refuse it at tool.before" },
  { path: "task.change.id", reason: "todos have no identity: a task's id is synthesized from its text" },
  { path: "user.elicitation", reason: "OpenCode's forms are not mapped; its question tool arrives as tool.before and tool.after" },
  { path: "user.message.outbound", reason: "OpenCode has no channel for messages outside the conversation" },
  { path: "file.changed.watcher", reason: "only OpenCode's own edits are reported" },
];
