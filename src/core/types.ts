/**
 * Core contracts shared across the whole installer.
 *
 * The design is a registry of "recipes" (one per RE tool). Each recipe declares
 * which dependencies it needs, performs its own tool-specific placement (dropping
 * a plugin, installing a bridge, etc.), and returns the MCP server block(s) to
 * write into the user's MCP clients. The engine wires deps -> recipe -> clients.
 */

export type Platform = "win32" | "darwin" | "linux";
export type Arch = "x64" | "x86" | "arm64";

/** A single MCP server entry as it appears under `mcpServers` in a client config. */
export type McpServerConfig =
  | {
      /** stdio transport: the client spawns a local process. */
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      /** remote transport: the client connects to a URL served by the tool. */
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

export function isStdioServer(
  s: McpServerConfig,
): s is Extract<McpServerConfig, { command: string }> {
  return (s as { command?: string }).command !== undefined;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DepStatus {
  installed: boolean;
  /** Best-effort detected version string, e.g. "21.0.2". */
  version?: string;
  /** Resolved path to the binary / install root when known. */
  path?: string;
  detail?: string;
}

export interface DependencySpec {
  id: string;
  name: string;
  /** Human note about what needs this and why. */
  purpose?: string;
  /** Detect whether the dependency is present (and where / which version). */
  detect(ctx: InstallContext): Promise<DepStatus>;
  /** Auto-install the dependency. Throws on failure. */
  install(ctx: InstallContext): Promise<void>;
  /**
   * Manual fallback instructions, shown when auto-install is off or fails.
   * These make the "detect-and-guide" degradation path usable.
   */
  manualSteps: string[];
}

// ---------------------------------------------------------------------------
// MCP clients
// ---------------------------------------------------------------------------

export interface ClientPresence {
  installed: boolean;
  /** Resolved config file path we would write to. */
  configPath?: string;
  detail?: string;
}

export interface ClientTarget {
  id: string;
  name: string;
  /** Detect whether this client is installed and where its config lives. */
  detect(ctx: InstallContext): Promise<ClientPresence>;
  /**
   * Apply the given servers into this client's config, merging with any
   * existing entries. Implementations own client-specific transforms (e.g.
   * Claude Code wrapping `npx` in `cmd /c` on Windows). Returns the path
   * written and whether a backup was made.
   */
  applyServers(
    ctx: InstallContext,
    servers: Record<string, McpServerConfig>,
  ): Promise<ClientWriteResult>;
  /** What the user must do for changes to take effect. */
  restartHint: string;
}

export interface ClientWriteResult {
  configPath: string;
  backupPath?: string;
  written: string[];
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export interface RecipeInstallResult {
  /** The MCP server block(s) to register in the selected clients. */
  servers: Record<string, McpServerConfig>;
  /** Files this recipe placed (plugins, bridges) for reporting. */
  placedFiles?: string[];
  /** Extra dynamic notes discovered during install. */
  notes?: string[];
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  /** GUI host app that must be running with a target loaded, if any. */
  hostApp?: string;
  platforms: Platform[];
  /** Dependency ids (from the dep registry) this recipe requires, in order. */
  dependencies: string[];
  /** Approximate MB downloaded, for user-facing estimates. */
  approxDownloadMb?: number;
  /**
   * Perform tool-specific placement and return the client config to register.
   * Dependencies are guaranteed satisfied (or the engine has already warned)
   * before this runs.
   */
  install(ctx: InstallContext): Promise<RecipeInstallResult>;
  /** Static post-install guidance (host app must be open, opt-in writes, etc). */
  postInstallNotes: string[];
  /** Optional sanity check that placement succeeded. */
  verify?(ctx: InstallContext): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Execution context + services
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  ok: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Do not treat a non-zero exit as an error the caller must guard. */
  allowFailure?: boolean;
  timeoutMs?: number;
  /** Stream child output to the console (for long installs). */
  inherit?: boolean;
}

export interface Logger {
  info(msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  step(msg: string): void;
  detail(msg: string): void;
  /** Run `fn` under a spinner labelled `label`. */
  task<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

export interface InstallContext {
  platform: Platform;
  arch: Arch;
  /** Managed directory where downloaded tools/bridges live. */
  toolsDir: string;
  home: string;
  logger: Logger;
  /** When true, describe actions without mutating the system. */
  dryRun: boolean;
  /** When true, auto-install missing dependencies; else detect-and-guide. */
  autoInstallDeps: boolean;
  run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Cache of resolved dependency statuses for this run. */
  depStatus: Map<string, DepStatus>;
}
