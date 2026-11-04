// What this adapter can enforce through OpenCode 1's plugin API, and what it
// cannot. Everything here is optional for an AHP runtime: an event or effect
// left out is simply not advertised, and the gaps say why.
import { capabilityCount, type HostCapabilities } from "agenthooksprotocol/client";

import { MAX_CONTINUATIONS } from "../shared/delivery.js";

const injectNow = { context: { append: true, deliverAt: ["now"] } } as const;

export const capabilities = {
  // Lifecycle. session.start's context rides on the session's first prompt.
  sessionStart: { observe: true, intercept: { inject: injectNow, message: true } },
  sessionEnd: { observe: true },

  // chat.message rewrites and refuses the prompt, and takes synthetic parts.
  turnStart: {
    observe: true,
    intercept: { deny: true, modifyPrompt: "replace", inject: injectNow, message: true },
  },
  turnProgress: { observe: true },
  // session.idle: a synthetic prompt continues; the answer is already recorded.
  turnFinishBefore: {
    observe: true,
    intercept: {
      flow: {
        operations: ["continue", "stop"],
        remainingContinuations: capabilityCount(MAX_CONTINUATIONS),
        continuationCount: capabilityCount(0),
        maxContinuations: capabilityCount(MAX_CONTINUATIONS),
      },
      message: true,
    },
  },
  turnEnd: { observe: true },

  // experimental.chat.messages.transform: each request's own copy of the
  // conversation, before it becomes model messages.
  modelRequestBefore: {
    observe: true,
    intercept: { deny: true, modifyRequest: "replace", inject: injectNow, message: true },
  },
  modelResponseAfter: { observe: true },
  modelError: { observe: true },
  // The prompt names its model: putting the current one back refuses a switch.
  modelSwitchBefore: { observe: true, intercept: { deny: true, message: true } },
  modelSwitchAfter: { observe: true },

  // Tools. A throw refuses; args are edited in place; the permission API
  // carries allow; the tool's result text carries context.
  toolBefore: {
    observe: true,
    intercept: { deny: true, allow: true, modifyInput: "replace-and-merge", inject: injectNow, message: true },
  },
  toolAfter: {
    observe: true,
    intercept: { modifyOutput: "replace-and-merge", inject: injectNow, message: true },
  },
  toolProgress: { observe: true },
  toolBatchAfter: { observe: true },
  // The permission reply API answers a pending request.
  toolPermissionRequest: {
    observe: true,
    intercept: { allow: true, deny: true, flow: { operations: ["stop"] }, message: true },
  },
  toolPermissionResolved: { observe: true },

  // experimental.session.compacting takes more instructions.
  contextCompactBefore: { observe: true, intercept: { modifyInstructions: "merge", message: true } },
  contextCompactAfter: { observe: true },

  taskChangeAfter: { observe: true },
  fileChanged: { observe: true },
  userAttention: { observe: true },
  userMessageInbound: { observe: true, intercept: { deny: true, modifyPrompt: "replace", message: true } },
  hookFailure: { observe: true },
} satisfies HostCapabilities;

/** Coverage OpenCode's plugin API does not reach, as manifest gaps. */
export const gaps = [
  { path: "tool.before.return", reason: "a plugin cannot skip a tool and supply its result: a throw reaches the model as a tool error" },
  { path: "tool.before.ask", reason: "a plugin cannot raise a permission prompt; the permission.ask hook is declared but OpenCode 1.19 never fires it" },
  { path: "tool.permission.request.modify", reason: "a tool has read its arguments by the time it asks" },
  { path: "tool.permission.resolved.policy", reason: "only requests that reach the permission prompt are reported: configured allow and deny rules raise no event" },
  { path: "tool.after.flow.continue", reason: "OpenCode has no continuation after a single tool result" },
  { path: "tool.batch.after.effects", reason: "the step's end is a bus event: it is observed, not answered" },
  { path: "turn.finish.before.modify", reason: "the answer is recorded and shown before the session goes idle" },
  { path: "turn.finish.before.subagent", reason: "a subagent's result has already gone back to its parent when it goes idle, so its finish takes no flow" },
  { path: "model.request.before.items.system", reason: "OpenCode composes the system prompt after this boundary: a request reports the one the previous request used, the first has none, and a rewrite cannot change it" },
  { path: "model.request.before.params", reason: "sampling parameters are computed after this boundary; only model and agent are known" },
  { path: "model.request.before.housekeeping", reason: "title and summary requests run outside the session's loop and are not reported" },
  { path: "model.response.after.effects", reason: "a streamed response is observed after the step; it is not rewritten" },
  { path: "model.switch.before.reason", reason: "OpenCode does not say why a prompt names another model" },
  { path: "context.compact.before.deny", reason: "a throw leaves the compaction pending, and every later prompt of the session fails with it" },
  { path: "context.compact.before.modify.replace", reason: "the prompt OpenCode lets a plugin replace also holds the conversation: instructions can only be added" },
  { path: "context.compact.before.return", reason: "a plugin cannot supply a summary" },
  { path: "turn.start.inject.history", reason: "a synthetic part stays in the conversation; context injected at tool.before of a failed call, or at model.request.before, lasts for its turn only" },
  { path: "config.change", reason: "OpenCode raises no configuration event for plugins after startup" },
  { path: "workspace.change", reason: "a plugin instance belongs to one directory; OpenCode raises no event when it changes" },
  { path: "task.change.before", reason: "the todo list changes through the todowrite tool: refuse it at tool.before" },
  { path: "task.change.id", reason: "todos have no identity: a task's id is synthesized from its text" },
  { path: "user.elicitation", reason: "OpenCode does not surface MCP elicitation; its question tool arrives as tool.before and tool.after" },
  { path: "user.message.outbound", reason: "OpenCode has no channel for messages outside the conversation" },
  { path: "file.changed.agentCaused", reason: "the watcher does not say who changed a file: only OpenCode's own edits report true" },
];
