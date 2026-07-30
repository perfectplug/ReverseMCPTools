import path from "node:path";
import fsp from "node:fs/promises";
import type {
  InstallContext,
  Recipe,
  RecipeInstallResult,
} from "../core/types.js";
import { exists, ensureDir, copyFile } from "../core/fs-utils.js";
import {
  downloadFile,
  extractArchive,
  githubReleaseAsset,
} from "../core/download.js";
import { managedLayout } from "../core/layout.js";
import {
  ensureManagedNpmPackage,
  requireDependencyPath,
} from "../core/managed-packages.js";

const PLUGIN_REPO = "SetsunaYukiOvO/x64dbg-mcp";
const X64DBG_REPO = "x64dbg/x64dbg";
const PLUGIN_TAG = "v1.0.10";
const X64DBG_TAG = "2026.05.27";
const MCP_REMOTE_VERSION = "0.1.38";
const PORT = 3000;

function defaultPluginConfig(): Record<string, unknown> {
  return {
    version: "1.0.10",
    server: { address: "127.0.0.1", port: PORT },
    permissions: {
      allow_memory_write: false,
      allow_register_write: false,
      allow_script_execution: false,
      allow_breakpoint_modification: true,
      allowed_methods: [
        "debug.*",
        "register.*",
        "memory.*",
        "breakpoint.*",
        "disasm.*",
        "disassembly.*",
        "module.*",
        "symbol.*",
        "thread.*",
        "stack.*",
        "comment.*",
        "context.*",
        "dump.*",
        "eval.*",
        "xref.*",
        "function.*",
        "assembler.*",
        "bookmark.*",
        "patch.*",
      ],
    },
    security: { origin_allowlist: [], host_allowlist: [] },
    logging: {
      enabled: true,
      level: "info",
      file: "plugin.log",
      max_file_size_mb: 10,
      console_output: true,
    },
    timeout: {
      request_timeout_ms: 30000,
      step_timeout_ms: 10000,
      memory_read_timeout_ms: 5000,
    },
    features: {
      enable_notifications: true,
      enable_heartbeat: true,
      heartbeat_interval_seconds: 30,
      enable_batch_requests: true,
      auto_start_mcp_on_plugin_load: true,
    },
  };
}

function pluginConfigDir(pluginsDir: string, assetName: string): string {
  const base = assetName.replace(/\.dp\d+$/i, "").replace(/_/g, "-");
  return path.join(pluginsDir, base);
}

async function enableAutoStart(
  configDir: string,
): Promise<string | undefined> {
  const configPath = path.join(configDir, "config.json");
  try {
    await ensureDir(configDir);
    if (await exists(configPath)) {
      const cfg = JSON.parse(
        await fsp.readFile(configPath, "utf8"),
      ) as Record<string, unknown>;
      const features =
        cfg.features && typeof cfg.features === "object"
          ? (cfg.features as Record<string, unknown>)
          : {};
      features.auto_start_mcp_on_plugin_load = true;
      cfg.features = features;
      await fsp.writeFile(configPath, JSON.stringify(cfg, null, 2));
    } else {
      await fsp.writeFile(
        configPath,
        JSON.stringify(defaultPluginConfig(), null, 2),
      );
    }
    return configPath;
  } catch {
    return undefined;
  }
}

/** Resolve only the x64dbg copy owned by the shared managed root. */
async function resolveX64dbgRoot(ctx: InstallContext): Promise<string> {
  const layout = managedLayout(ctx.toolsDir);
  const managedBase = path.join(layout.tools, "x64dbg");
  const managed = path.join(managedBase, "release");
  const completionMarker = path.join(managedBase, ".remcp-complete");
  const hasHostBinary = async (): Promise<boolean> =>
    (await exists(path.join(managed, "x64", "x64dbg.exe"))) ||
    (await exists(path.join(managed, "x32", "x32dbg.exe")));
  if (
    (await hasHostBinary()) &&
    (await exists(completionMarker))
  ) {
    return managed;
  }

  ctx.logger.detail(
    "Managed x64dbg is missing; downloading the official snapshot.",
  );
  const asset = await ctx.logger.task("Resolve x64dbg snapshot", () =>
    githubReleaseAsset(X64DBG_REPO, /snapshot_.*\.zip$/i, X64DBG_TAG),
  );
  const archive = path.join(layout.downloads, "x64dbg", asset.name);
  await ctx.logger.task(`Download x64dbg (${asset.tag})`, () =>
    downloadFile(asset.url, archive, { sha256: asset.sha256 }),
  );
  await fsp.rm(completionMarker, { force: true });
  await ctx.logger.task("Extract x64dbg", () =>
    extractArchive(archive, managedBase),
  );
  if (await hasHostBinary()) {
    await fsp.writeFile(completionMarker, `${asset.tag}\n`, "utf8");
    return managed;
  }
  throw new Error(
    `Extracted x64dbg but could not find a release folder under ${managedBase}`,
  );
}

function mcpRemoteEntry(ctx: InstallContext): string {
  const layout = managedLayout(ctx.toolsDir);
  return path.join(
    layout.servers,
    "mcp-remote",
    "node_modules",
    "mcp-remote",
    "dist",
    "proxy.js",
  );
}

export const x64dbgRecipe: Recipe = {
  id: "x64dbg",
  name: "x64dbg MCP",
  description:
    "Managed x64dbg snapshot with native MCP plugins and a managed stdio bridge.",
  hostApp: "x64dbg / x32dbg",
  platforms: ["win32"],
  dependencies: ["node2212"],
  approxDownloadMb: 65,

  async install(ctx: InstallContext): Promise<RecipeInstallResult> {
    const layout = managedLayout(ctx.toolsDir);
    const plannedRoot = path.join(layout.tools, "x64dbg", "release");
    const remoteInstallDir = path.join(layout.servers, "mcp-remote");
    const remoteEntry = mcpRemoteEntry(ctx);
    if (ctx.dryRun) {
      ctx.logger.detail(
        `(dry-run) would install x64dbg under ${plannedRoot}, place both native plugins there, and install mcp-remote@${MCP_REMOTE_VERSION} under ${remoteInstallDir}.`,
      );
      return {
        servers: {
          x64dbg: {
            type: "http",
            url: `http://127.0.0.1:${PORT}/mcp`,
          },
        },
        placedFiles: [
          path.join(
            plannedRoot,
            "x64",
            "plugins",
            "x64dbg_mcp.dp64",
          ),
          path.join(
            plannedRoot,
            "x32",
            "plugins",
            "x32dbg_mcp.dp32",
          ),
          remoteEntry,
        ],
      };
    }

    const nodePath = requireDependencyPath(ctx, "node2212");
    const root = await resolveX64dbgRoot(ctx);
    const placed: string[] = [];
    const notes: string[] = [];
    const targets: {
      assetName: string;
      assetRe: RegExp;
      subdir: string;
      label: string;
    }[] = [
      {
        assetName: "x64dbg_mcp.dp64",
        assetRe: /x64dbg_mcp\.dp64$/i,
        subdir: "x64",
        label: "x64 (64-bit)",
      },
      {
        assetName: "x32dbg_mcp.dp32",
        assetRe: /x32dbg_mcp\.dp32$/i,
        subdir: "x32",
        label: "x32 (32-bit)",
      },
    ];

    for (const target of targets) {
      if (!(await exists(path.join(root, target.subdir)))) {
        ctx.logger.detail(
          `Skipping ${target.label}: ${target.subdir}/ is absent from this snapshot.`,
        );
        continue;
      }
      const pluginsDir = path.join(root, target.subdir, "plugins");
      await ensureDir(pluginsDir);
      const destination = path.join(pluginsDir, target.assetName);
      if (!(await exists(destination))) {
        const asset = await githubReleaseAsset(
          PLUGIN_REPO,
          target.assetRe,
          PLUGIN_TAG,
        );
        const download = path.join(
          layout.downloads,
          "x64dbg-mcp",
          asset.name,
        );
        await ctx.logger.task(
          `Download ${target.label} plugin (${asset.tag})`,
          () =>
            downloadFile(asset.url, download, {
              sha256: asset.sha256,
            }),
        );
        await copyFile(download, destination);
      }
      placed.push(destination);

      const config = await enableAutoStart(
        pluginConfigDir(pluginsDir, target.assetName),
      );
      if (config) {
        placed.push(config);
      } else {
        notes.push(
          `Could not write the ${target.label} plugin auto-start config.`,
        );
      }
    }

    if (!placed.some((file) => /\.dp(?:32|64)$/i.test(file))) {
      throw new Error(
        "No x64dbg MCP plugin was placed; the managed snapshot has neither x64 nor x32 targets.",
      );
    }

    const remote = await ctx.logger.task(
      "Install managed mcp-remote bridge",
      () =>
        ensureManagedNpmPackage(ctx, {
          nodePath,
          packageName: "mcp-remote",
          version: MCP_REMOTE_VERSION,
          installDir: remoteInstallDir,
          entryRelativePath: path.join("dist", "proxy.js"),
        }),
    );
    placed.push(remote.entryPath, remote.packageJsonPath);

    return {
      servers: {
        x64dbg: {
          type: "http",
          url: `http://127.0.0.1:${PORT}/mcp`,
        },
      },
      placedFiles: placed,
      notes,
    };
  },

  postInstallNotes: [
    "Launch x64dbg or x32dbg from the managed release directory. The MCP HTTP server auto-starts on 127.0.0.1:3000.",
    "Memory writes, register writes and script execution remain disabled by default in the managed plugin config.",
    "stdio-only clients use the fixed managed mcp-remote@0.1.38 installation; no npx download is needed at client startup.",
    "Run x64dbg in a VM or sandbox when analysing untrusted binaries.",
  ],

  async verify(ctx: InstallContext): Promise<boolean> {
    const layout = managedLayout(ctx.toolsDir);
    const root = path.join(layout.tools, "x64dbg", "release");
    const x64Plugin = path.join(
      root,
      "x64",
      "plugins",
      "x64dbg_mcp.dp64",
    );
    const x32Plugin = path.join(
      root,
      "x32",
      "plugins",
      "x32dbg_mcp.dp32",
    );
    const x64Config = path.join(
      root,
      "x64",
      "plugins",
      "x64dbg-mcp",
      "config.json",
    );
    const x32Config = path.join(
      root,
      "x32",
      "plugins",
      "x32dbg-mcp",
      "config.json",
    );
    return (
      ((await exists(path.join(root, "x64", "x64dbg.exe"))) ||
        (await exists(path.join(root, "x32", "x32dbg.exe")))) &&
      ((await exists(x64Plugin)) || (await exists(x32Plugin))) &&
      ((await exists(x64Config)) || (await exists(x32Config))) &&
      (await exists(
        path.join(layout.tools, "x64dbg", ".remcp-complete"),
      )) &&
      (await exists(mcpRemoteEntry(ctx))) &&
      (await exists(
        path.join(layout.servers, "mcp-remote", ".remcp-complete"),
      ))
    );
  },
};
