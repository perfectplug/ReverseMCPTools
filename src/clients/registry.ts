import os from "node:os";
import path from "node:path";
import {
  isStdioServer,
  type ClientPresence,
  type ClientTarget,
  type ClientWriteResult,
  type InstallContext,
  type McpServerConfig,
} from "../core/types.js";
import { exists, readJsonSafe, writeJsonWithBackup } from "../core/fs-utils.js";
import { which } from "../core/exec.js";

interface ClientCaps {
  /** Client can talk to a remote http/sse URL directly. If false we bridge via mcp-remote. */
  supportsRemote: boolean;
  /** On Windows, wrap `npx ...` as `cmd /c npx ...` (Node can't spawn .cmd shims directly). */
  wrapNpxWithCmd: boolean;
  /** JSON key used for a remote server's URL (Windsurf prefers `serverUrl`). */
  remoteUrlKey: "url" | "serverUrl";
  /** Include an explicit `type: "stdio"` on stdio entries. */
  stdioNeedsType: boolean;
}

interface ClientDef {
  id: string;
  name: string;
  /** Candidate config paths in priority order; first existing wins, else first. */
  candidatePaths(ctx: InstallContext): string[];
  /** Extra presence signals (e.g. a binary on PATH). */
  extraDetect?(ctx: InstallContext): Promise<boolean>;
  caps: ClientCaps;
  restartHint: string;
}

const home = os.homedir();
const APPDATA = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
const LOCALAPPDATA =
  process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");

function isNpx(command: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === "npx" || base === "npx.cmd" || base === "npx.exe";
}

/** Apply a client's transforms to one server entry. */
function transformServer(
  server: McpServerConfig,
  caps: ClientCaps,
  platform: string,
): McpServerConfig {
  if (isStdioServer(server)) {
    let command = server.command;
    let args = server.args ? [...server.args] : [];
    if (platform === "win32" && caps.wrapNpxWithCmd && isNpx(command)) {
      args = ["/c", command, ...args];
      command = "cmd";
    }
    const out: McpServerConfig = { command, ...(args.length ? { args } : {}) };
    if (server.env) (out as { env?: unknown }).env = server.env;
    if (caps.stdioNeedsType) (out as { type?: string }).type = "stdio";
    return out;
  }

  // Remote server (http/sse).
  if (!caps.supportsRemote) {
    // Bridge to a stdio client via mcp-remote.
    return transformServer(
      { command: "npx", args: ["-y", "mcp-remote", server.url] },
      caps,
      platform,
    );
  }
  const out: Record<string, unknown> = { type: server.type };
  out[caps.remoteUrlKey] = server.url;
  if (server.headers) out.headers = server.headers;
  return out as McpServerConfig;
}

class GenericClient implements ClientTarget {
  readonly id: string;
  readonly name: string;
  readonly restartHint: string;

  constructor(private readonly def: ClientDef) {
    this.id = def.id;
    this.name = def.name;
    this.restartHint = def.restartHint;
  }

  async detect(ctx: InstallContext): Promise<ClientPresence> {
    const candidates = this.def.candidatePaths(ctx);
    let configPath: string | undefined;
    for (const c of candidates) {
      if (await exists(c)) {
        configPath = c;
        break;
      }
    }
    // If the config file doesn't exist yet, treat its parent dir as a signal.
    if (!configPath) {
      for (const c of candidates) {
        if (await exists(path.dirname(c))) {
          configPath = c;
          break;
        }
      }
    }
    let installed = configPath !== undefined;
    if (!installed && this.def.extraDetect) {
      installed = await this.def.extraDetect(ctx);
      if (installed) configPath = candidates[0];
    }
    return {
      installed,
      configPath: configPath ?? candidates[0],
    };
  }

  async applyServers(
    ctx: InstallContext,
    servers: Record<string, McpServerConfig>,
  ): Promise<ClientWriteResult> {
    // Pick the existing config among candidates, else the first candidate.
    let configPath = this.def.candidatePaths(ctx)[0] ?? "";
    for (const c of this.def.candidatePaths(ctx)) {
      if (await exists(c)) {
        configPath = c;
        break;
      }
    }

    const existing =
      (await readJsonSafe<Record<string, unknown>>(configPath)) ?? {};
    const key = "mcpServers";
    const bucket = { ...((existing[key] as Record<string, unknown>) ?? {}) };

    const written: string[] = [];
    for (const [name, server] of Object.entries(servers)) {
      bucket[name] = transformServer(server, this.def.caps, ctx.platform);
      written.push(name);
    }
    const next = { ...existing, [key]: bucket };

    if (ctx.dryRun) {
      ctx.logger.detail(`(dry-run) would write to ${configPath}:`);
      for (const name of written) {
        ctx.logger.detail(`  "${name}": ${JSON.stringify(bucket[name])}`);
      }
      return { configPath, written };
    }

    const { backupPath } = await writeJsonWithBackup(configPath, next, {
      backupStamp: "remcp",
    });
    return { configPath, backupPath, written };
  }
}

const COMMON_CAPS: ClientCaps = {
  supportsRemote: true,
  wrapNpxWithCmd: false,
  remoteUrlKey: "url",
  stdioNeedsType: false,
};

const DEFS: ClientDef[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    candidatePaths: () => {
      const msix = path.join(
        LOCALAPPDATA,
        "Packages",
        "Claude_pzs8sxrjxfjjc",
        "LocalCache",
        "Roaming",
        "Claude",
        "claude_desktop_config.json",
      );
      const standard = path.join(APPDATA, "Claude", "claude_desktop_config.json");
      const macish = path.join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      );
      if (process.platform === "win32") return [msix, standard];
      if (process.platform === "darwin") return [macish];
      return [path.join(home, ".config", "Claude", "claude_desktop_config.json")];
    },
    caps: {
      // Claude Desktop is classically stdio-only; bridge remote URLs via mcp-remote.
      supportsRemote: false,
      wrapNpxWithCmd: true,
      remoteUrlKey: "url",
      stdioNeedsType: false,
    },
    restartHint: "Fully quit Claude Desktop from the tray and reopen it.",
  },
  {
    id: "cursor",
    name: "Cursor",
    candidatePaths: () => [path.join(home, ".cursor", "mcp.json")],
    caps: COMMON_CAPS,
    restartHint: "Quit and reopen Cursor (or toggle the server in Settings → Tools & MCP).",
  },
  {
    id: "cline",
    name: "Cline (VS Code)",
    candidatePaths: () => {
      const base =
        process.platform === "win32"
          ? path.join(APPDATA, "Code", "User")
          : process.platform === "darwin"
            ? path.join(home, "Library", "Application Support", "Code", "User")
            : path.join(home, ".config", "Code", "User");
      return [
        path.join(
          base,
          "globalStorage",
          "saoudrizwan.claude-dev",
          "settings",
          "cline_mcp_settings.json",
        ),
      ];
    },
    caps: COMMON_CAPS,
    restartHint:
      "In VS Code, run 'Developer: Reload Window' or reopen the Cline MCP Servers panel.",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    candidatePaths: () => [
      path.join(home, ".codeium", "windsurf", "mcp_config.json"),
    ],
    caps: {
      supportsRemote: true,
      wrapNpxWithCmd: false,
      remoteUrlKey: "serverUrl",
      stdioNeedsType: false,
    },
    restartHint: "Restart Windsurf or click Refresh in the Cascade MCP panel.",
  },
  {
    id: "claude-code",
    name: "Claude Code (CLI)",
    candidatePaths: () => [path.join(home, ".claude.json")],
    extraDetect: async () => (await which("claude")) !== undefined,
    caps: {
      supportsRemote: true,
      wrapNpxWithCmd: true,
      remoteUrlKey: "url",
      stdioNeedsType: true,
    },
    restartHint:
      "Restart any running `claude` session; run `/mcp` to confirm the servers connected.",
  },
];

export const CLIENTS: ClientTarget[] = DEFS.map((d) => new GenericClient(d));

export function getClient(id: string): ClientTarget {
  const c = CLIENTS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown client: ${id}`);
  return c;
}
