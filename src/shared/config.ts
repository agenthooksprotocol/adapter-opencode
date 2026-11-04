// Registration discovery: `hooks.json` under `.agents/` and OpenCode's own
// directories, for the user and for the project, merged into one AHP
// registration document.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RegistrationSource {
  /** Absolute path of the file. */
  path: string;
  scope: "user" | "project";
}

export interface LoadedRegistration {
  /** The merged registration, or undefined when no file declares a backend. */
  registration?: { protocolVersion: "draft"; hooks: Record<string, unknown>[] };
  /** The files that contributed, lowest precedence first. */
  sources: RegistrationSource[];
  /** Files skipped, and backends replaced by a more specific file. */
  diagnostics: string[];
}

export type Environment = Record<string, string | undefined>;

/** Lowest precedence first: a later file's backend replaces an earlier one with
 * the same `id`, so the project beats the user, and OpenCode's directory beats
 * `.agents` within each. OpenCode itself reads project configuration from the
 * worktree down to the working directory; so does this. */
export function registrationPaths(environment: Environment, directory: string, worktree: string): RegistrationSource[] {
  const home = environment.HOME;
  const paths: RegistrationSource[] = [];
  if (home) paths.push({ path: join(home, ".agents/hooks.json"), scope: "user" });
  const config = environment.OPENCODE_CONFIG_DIR
    ?? (environment.XDG_CONFIG_HOME ? join(environment.XDG_CONFIG_HOME, "opencode") : home ? join(home, ".config/opencode") : undefined);
  if (config) paths.push({ path: join(config, "hooks.json"), scope: "user" });
  const roots = worktree && worktree !== "/" && worktree !== directory ? [worktree, directory] : [directory];
  for (const root of roots) {
    if (root === home) continue;
    paths.push({ path: join(root, ".agents/hooks.json"), scope: "project" });
    paths.push({ path: join(root, ".opencode/hooks.json"), scope: "project" });
  }
  return paths;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read and merge every registration file that exists. Structural validation
 * of the result is the SDK's: this only keeps files from poisoning each other. */
export function loadRegistration(environment: Environment, directory: string, worktree: string): LoadedRegistration {
  // One explicit file replaces discovery (tests, CI, a pinned deployment).
  const pinned = environment.AHP_HOOKS_FILE;
  const paths = pinned ? [{ path: pinned, scope: "user" as const }] : registrationPaths(environment, directory, worktree);
  const diagnostics: string[] = [];
  const sources: RegistrationSource[] = [];
  const backends = new Map<string, { backend: Record<string, unknown>; path: string }>();
  for (const source of paths) {
    if (!existsSync(source.path)) continue;
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(source.path, "utf8"));
    } catch (error) {
      diagnostics.push(`${source.path}: unreadable or not JSON (${error instanceof SyntaxError ? "syntax error" : String(error)}); skipped`);
      continue;
    }
    if (!object(document) || document.protocolVersion !== "draft" || !Array.isArray(document.hooks)) {
      diagnostics.push(`${source.path}: not an AHP draft registration (protocolVersion "draft", hooks[]); skipped`);
      continue;
    }
    sources.push(source);
    for (const backend of document.hooks) {
      if (!object(backend) || typeof backend.id !== "string") {
        diagnostics.push(`${source.path}: a backend without an id; skipped`);
        continue;
      }
      const previous = backends.get(backend.id);
      if (previous) diagnostics.push(`${backend.id}: ${source.path} replaces ${previous.path}`);
      backends.set(backend.id, { backend, path: source.path });
    }
  }
  if (backends.size === 0) return { sources, diagnostics };
  return {
    registration: { protocolVersion: "draft", hooks: [...backends.values()].map(({ backend }) => backend) },
    sources,
    diagnostics,
  };
}
