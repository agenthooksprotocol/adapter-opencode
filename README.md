# Agent Hooks Protocol adapter for OpenCode

An [OpenCode](https://opencode.ai) plugin that delivers OpenCode's events to
[Agent Hooks Protocol](https://github.com/agenthooksprotocol/agent-hooks-protocol)
backends and applies their effects natively. It is built on the
[AHP TypeScript SDK](https://github.com/agenthooksprotocol/typescript-sdk).

One package serves both OpenCode plugin APIs: OpenCode 2 loads its `setup` export
and OpenCode 1 loads its `server` export. Tested against OpenCode 2.2.5 and 1.19.5.
Both flavours use hooks OpenCode marks experimental, which may change between
releases.

## Install

OpenCode 2, in `opencode.json`:

```json
{ "plugins": ["@agenthooksprotocol/adapter-opencode"] }
```

OpenCode 1 spells the key `plugin`:

```json
{ "plugin": ["@agenthooksprotocol/adapter-opencode"] }
```

While developing, run `npm install && npm run build`, then name this checkout:
`"/absolute/path/to/adapter-opencode"` on OpenCode 2,
`"file:///absolute/path/to/adapter-opencode"` on OpenCode 1.

## Register backends

The adapter reads AHP registrations (the spec's `hooks.json`) and merges them
into one document:

| File | Scope |
| --- | --- |
| `~/.agents/hooks.json` | user |
| `~/.config/opencode/hooks.json` (or `$XDG_CONFIG_HOME/opencode`, `$OPENCODE_CONFIG_DIR`) | user |
| `<worktree>/.agents/hooks.json` | project |
| `<worktree>/.opencode/hooks.json` | project |
| `<cwd>/.agents/hooks.json` | project |
| `<cwd>/.opencode/hooks.json` | project |

Later rows win: a backend in a later file replaces the backend with the same
`id` from an earlier one. A file that is not a `"protocolVersion": "draft"`
registration is skipped with a warning in OpenCode's log.

```json
{
  "protocolVersion": "draft",
  "hooks": [
    {
      "id": "com.example.policy",
      "transport": { "type": "http", "url": "https://hooks.example/ahp" },
      "subscriptions": [
        {
          "mode": "intercept",
          "events": ["tool.before", "turn.start"],
          "timeoutMs": 2000,
          "failurePolicy": "fail-closed",
          "content": { "default": "body" }
        }
      ]
    }
  ]
}
```

Omit `subscriptions` to let the backend choose them (server-driven
configuration). Set `AHP_HOOKS_FILE` to one registration's absolute path to use
that file alone, with no discovery (tests, CI, a pinned deployment).

## What reaches a backend

| AHP event | OpenCode 2 | OpenCode 1 |
| --- | --- | --- |
| `session.start` | inject | inject, message |
| `session.end` | observe | observe |
| `turn.start` | deny, modify(prompt), inject | deny, modify(prompt), inject, message |
| `turn.progress` | observe | observe |
| `turn.finish.before` | flow continue/stop | flow continue/stop, message |
| `turn.end` | observe | observe |
| `model.request.before` | deny, modify(request), inject | deny, modify(request), inject, message |
| `model.response.after`, `model.error` | observe | observe |
| `model.switch.before` | not available | deny, message |
| `model.switch.after` | observe | observe |
| `tool.before` | deny, allow, **ask**, modify(input), inject | deny, allow, modify(input), inject, message |
| `tool.after` | modify(output), inject | modify(output), inject, message |
| `tool.progress`, `tool.batch.after` | observe | observe |
| `tool.permission.request` | allow, deny, flow stop | allow, deny, flow stop, message |
| `tool.permission.resolved` | observe, including configured rules | observe, prompts only |
| `context.compact.before` | **deny**, modify(instructions, merge), **return** | modify(instructions, merge), message |
| `context.compact.after` | observe | observe |
| `task.change.after`, `file.changed`, `user.attention` | observe | observe |
| `user.message.inbound` | deny, modify | deny, modify, message |

Turn, call and message ids are OpenCode's own. Attempt ids are synthesized, and
todos, which have no identity, get ids derived from their text.

An AHP session is a whole OpenCode session tree. A subagent's child session is
not a session of its own: its events carry the root's `session.id`,
`session.agent` (`id` is the child session's id, `type` the agent), and its first
turn hangs off the call that spawned it through `parentEventId`.

Everything the adapter cannot enforce is left unadvertised and listed in the
manifest's `gaps`: [`src/v2/capabilities.ts`](src/v2/capabilities.ts),
[`src/v1/capabilities.ts`](src/v1/capabilities.ts). The two that matter most:
`tool.before`'s `return` is unavailable on both, and an OpenCode 2 server plugin
has no surface for `message` effects, so they are not advertised there.

MCP tools report `origin: mcp` with their server and connection, leaving out the
environment, headers and command line, which may hold credentials. On OpenCode 2,
calls an `execute` tool makes through code mode reuse its call id, so they report
under synthesized ids of their own, with the `execute` call's `tool.before` as parent.

## How effects are applied

On OpenCode 2:

- `session` hooks `prompt`, `context` and `compaction` carry their effects
  directly. `context` holds the whole request, so `model.request.before` reports
  the system prompt, messages, options and tools together.
- **flow continue** admits a synthetic message from `experimental.idle`: another
  pass in the same execution, for subagents too, up to 8 times in a row.
- **inject** is a synthetic message that starts no work of its own, so it stays in
  the conversation. At `model.request.before` it joins that request's system prompt.
- **allow** and **ask** land on the permission `evaluate` hook, as does a backend's
  answer to `tool.permission.request`. A configured deny never reaches the hook, so
  it stands. With no decision, the prompt stays with the person.
- A throw refuses a prompt, tool, request or compaction.

On OpenCode 1, which has no typed verdicts apart from a `permission.ask` hook that
it declares and never fires:

- **deny** is a throw. The model reads a refused tool as a tool error. A refused
  prompt or model request fails with OpenCode's generic server error, so the
  reason also goes to a toast and the log.
- **modify(input)** edits the args object in place: OpenCode runs the tool with
  that object and ignores a replacement.
- **allow** and permission answers go through OpenCode's permission reply API.
- **flow continue** sends a synthetic prompt once the session is idle, up to 8
  times in a row, so the session shows idle, then busy again.
- **inject** becomes a synthetic part on the prompt at `turn.start`, and text on
  the tool's result at `tool.after`. At `model.request.before` it applies to that
  one request.

## Content uploads

File parts leave as attachments, uploaded only for a subscription that selects
their body and configures `upload`; the bytes never travel in event text. A
subscription that selects bodies without `upload` fails on any binary attachment
according to its failure policy, so set `upload`, or select `metadata` for media:

```json
{ "content": { "default": "body", "images": "metadata", "files": "metadata" } }
```

## Develop

```sh
npm run build        # compile to dist
npm run typecheck
npm test             # unit tests against a real local AHP backend (bun)
npm run test:e2e     # the real OpenCode, a fake model, a recording backend
```

The end-to-end tests run `opencode serve` with a temporary `HOME` and a pinned
registration, so they reach neither your plugins nor your backends. OpenCode 1 comes
from the `opencode-ai` dev dependency. OpenCode 2 is not on that package: its tests
use `OPENCODE2_BIN`, or `~/.opencode/bin/opencode`, and skip when neither is 2.x.
