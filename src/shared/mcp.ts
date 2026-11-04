// An MCP server's connection as AHP describes it, without what may hold a
// credential: environment and headers stay out, and a URL keeps only its address.
export function connection(config: Record<string, unknown> | undefined) {
  if (config?.type === "remote" && typeof config.url === "string") {
    const url = new URL(config.url);
    return { transport: "http" as const, url: `${url.origin}${url.pathname}` };
  }
  if (config?.type === "local")
    return {
      transport: "stdio" as const,
      gaps: [
        { path: "command", reason: "a local server's command line may hold a credential" },
        { path: "args", reason: "a local server's command line may hold a credential" },
        { path: "cwd", reason: "OpenCode does not report a local server's working directory" },
      ],
    };
  return { transport: "unknown", gaps: [{ path: "address", reason: "the server's configuration is not visible to this plugin" }, { path: "addressForm", reason: "the server's configuration is not visible to this plugin" }] };
}
