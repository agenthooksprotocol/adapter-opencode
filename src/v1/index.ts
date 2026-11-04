// The OpenCode 1 flavour: a hooks object of mutable outputs, with a bus observer.
import type { Plugin } from "@opencode-ai/plugin";
import { Adapter } from "./adapter.js";
import { lifecycleHooks, onLifecycleEvent } from "./events/lifecycle.js";
import { modelHooks, onModelEvent } from "./events/model.js";
import { onToolEvent, toolHooks } from "./events/tools.js";
import { onTurnEvent, turnHooks } from "./events/turns.js";

export const server: Plugin = async (input) => {
  const adapter = new Adapter(input);
  return {
    ...turnHooks(adapter),
    ...modelHooks(adapter),
    ...toolHooks(adapter),
    ...lifecycleHooks(adapter),
    event: async ({ event }) => {
      await onLifecycleEvent(adapter, event);
      await onTurnEvent(adapter, event);
      await onModelEvent(adapter, event);
      await onToolEvent(adapter, event);
    },
    dispose: async () => {
      await onLifecycleEvent(adapter, { type: "server.instance.disposed" } as never);
      await adapter.close();
    },
  };
};
