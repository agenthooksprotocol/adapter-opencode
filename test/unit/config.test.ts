import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistration, registrationPaths } from "../../src/shared/config.ts";

const backend = (id: string, url: string) => ({ id, transport: { type: "http", url } });
const file = (path: string, content: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
};

describe("registration discovery", () => {
  const root = mkdtempSync(join(tmpdir(), "ahp-config-"));
  const home = join(root, "home");
  const project = join(root, "project");
  afterEach(() => {});

  test("reads user then project, .agents then .opencode", () => {
    const paths = registrationPaths({ HOME: "/h" }, "/repo/sub", "/repo").map((source) => source.path);
    expect(paths).toEqual([
      "/h/.agents/hooks.json",
      "/h/.config/opencode/hooks.json",
      "/repo/.agents/hooks.json",
      "/repo/.opencode/hooks.json",
      "/repo/sub/.agents/hooks.json",
      "/repo/sub/.opencode/hooks.json",
    ]);
  });

  test("honours OpenCode's config directory settings", () => {
    expect(registrationPaths({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "/r", "/r")[1]!.path).toBe("/x/opencode/hooks.json");
    expect(registrationPaths({ HOME: "/h", OPENCODE_CONFIG_DIR: "/c", XDG_CONFIG_HOME: "/x" }, "/r", "/r")[1]!.path).toBe("/c/hooks.json");
  });

  test("a later file's backend replaces an earlier one with its id", () => {
    file(join(home, ".agents/hooks.json"), { protocolVersion: "draft", hooks: [backend("a", "https://user/a"), backend("b", "https://user/b")] });
    file(join(project, ".opencode/hooks.json"), { protocolVersion: "draft", hooks: [backend("a", "https://project/a")] });
    const { registration, sources, diagnostics } = loadRegistration({ HOME: home }, project, project);
    expect(registration!.hooks.map((hook: any) => hook.transport.url).sort()).toEqual(["https://project/a", "https://user/b"]);
    expect(sources).toHaveLength(2);
    expect(diagnostics[0]).toContain("replaces");
  });

  test("a bad file is skipped with a diagnostic and poisons nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ahp-config-"));
    file(join(dir, ".agents/hooks.json"), "{ not json");
    file(join(dir, ".opencode/hooks.json"), { hooks: [] });
    const { registration, diagnostics } = loadRegistration({ HOME: "/nowhere" }, dir, dir);
    expect(registration).toBeUndefined();
    expect(diagnostics).toHaveLength(2);
  });

  test("AHP_HOOKS_FILE replaces discovery", () => {
    const pinned = join(root, "pinned.json");
    file(pinned, { protocolVersion: "draft", hooks: [backend("p", "https://pinned")] });
    const { registration, sources } = loadRegistration({ HOME: home, AHP_HOOKS_FILE: pinned }, project, project);
    expect(registration!.hooks).toHaveLength(1);
    expect(sources[0]!.path).toBe(pinned);
  });
});
