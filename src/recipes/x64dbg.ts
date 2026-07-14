import path from "node:path";
import fsp from "node:fs/promises";
import type {
  InstallContext,
  Recipe,
  RecipeInstallResult,
} from "../core/types.js";
import { exists, ensureDir, copyFile } from "../core/fs-utils.js";
import { which } from "../core/exec.js";
import {
  downloadFile,
  extractZip,
  githubReleaseAsset,
} from "../core/download.js";

const PLUGIN_REPO = "SetsunaYukiOvO/x64dbg-mcp";
const X64DBG_REPO = "x64dbg/x64dbg";
const PORT = 3000;

/**
 * The plugin's own generated defaults, but with `auto_start_mcp_on_plugin_load`
 * turned ON. Without it the HTTP server does NOT start on launch: the user has
 * to click Plugins -> MCP Server -> Start MCP HTTP Server every time, and the
 * client shows the server as "failed" until they do. Dangerous operations
 * (memory/register writes, script execution) stay OFF by default.
 */
function defaultPluginConfig(): Record<string, unknown> {
  return {
    version: "1.0.9",
    server: { address: "127.0.0.1", port: PORT },
    permissions: {
      allow_memory_write: false,
      allow_register_write: false,
      allow_script_execution: false,
      allow_breakpoint_modification: true,
      allowed_methods: [
        "debug.*", "register.*", "memory.*", "breakpoint.*", "disasm.*",
        "disassembly.*", "module.*", "symbol.*", "thread.*", "stack.*",
        "comment.*", "context.*", "dump.*", "eval.*", "xref.*", "function.*",
        "assembler.*", "bookmark.*", "patch.*",
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

/**
 * The plugin reads its config from `<plugins>/<name>/config.json`, where <name>
 * is the plugin basename with underscores turned to hyphens (the .dp64
 * `x64dbg_mcp` -> `x64dbg-mcp`; the .dp32 `x32dbg_mcp` -> `x32dbg-mcp`).
 */
function pluginConfigDir(pluginsDir: string, assetName: string): string {
  const base = assetName.replace(/\.dp\d+$/i, "").replace(/_/g, "-");
  return path.join(pluginsDir, base);
}

/**
 * Ensure the plugin's HTTP server auto-starts. If a config already exists (the
 * plugin generated one on a prior run, or the user hand-edited it), flip only
 * the single flag so their other settings survive; otherwise seed the full
 * default. Returns the config path written, or undefined on failure.
 */
async function enableAutoStart(configDir: string): Promise<string | undefined> {
  const configPath = path.join(configDir, "config.json");
  try {
    await ensureDir(configDir);
    if (await exists(configPath)) {
      const cfg = JSON.parse(await fsp.readFile(configPath, "utf8")) as Record<
        string,
        unknown
      >;
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

/**
 * Locate an x64dbg install `release` root (the folder containing `x32/` and
 * `x64/`). Checks PATH and common locations; otherwise downloads the official
 * snapshot into our managed tools dir.
 */
async function resolveX64dbgRoot(ctx: InstallContext): Promise<string> {
  const managed = path.join(ctx.toolsDir, "x64dbg", "release");
  const candidates: string[] = [];

  const onPath = await which("x64dbg");
  if (onPath) {
    // .../release/x64/x64dbg.exe -> .../release
    candidates.push(path.resolve(path.dirname(onPath), "..", ".."));
  }
  candidates.push(managed);

  for (const c of candidates) {
    if ((await exists(path.join(c, "x64"))) || (await exists(path.join(c, "x32")))) {
      return c;
    }
  }

  // Not found: download the official snapshot (full-auto).
  ctx.logger.detail("x64dbg not found — downloading the official snapshot.");
  const asset = await ctx.logger.task("Resolve x64dbg snapshot", () =>
    githubReleaseAsset(X64DBG_REPO, /snapshot_.*\.zip$/i),
  );
  const zip = path.join(ctx.toolsDir, "x64dbg", asset.name);
  await ctx.logger.task(`Download x64dbg (${asset.tag})`, () =>
    downloadFile(asset.url, zip),
  );
  await ctx.logger.task("Extract x64dbg", () =>
    extractZip(zip, path.join(ctx.toolsDir, "x64dbg")),
  );
  if (await exists(managed)) return managed;
  throw new Error(
    `Extracted x64dbg but could not find a 'release' folder under ${path.join(ctx.toolsDir, "x64dbg")}`,
  );
}

export const x64dbgRecipe: Recipe = {
  id: "x64dbg",
  name: "x64dbg MCP",
  description:
    "Native C++ plugin that serves MCP over HTTP from inside x64dbg (SetsunaYukiOvO/x64dbg-mcp).",
  hostApp: "x64dbg / x32dbg",
  platforms: ["win32"],
  dependencies: [], // zero runtime deps — the plugin is self-contained
  approxDownloadMb: 60,

  async install(ctx: InstallContext): Promise<RecipeInstallResult> {
    if (ctx.dryRun) {
      ctx.logger.detail(
        "(dry-run) would ensure x64dbg is present, drop the MCP plugin (.dp64/.dp32) into <x64dbg>/release/{x64,x32}/plugins, and enable auto_start_mcp_on_plugin_load in each plugin's config.json.",
      );
      return {
        servers: { x64dbg: { type: "http", url: `http://127.0.0.1:${PORT}/mcp` } },
        placedFiles: [],
      };
    }

    const root = await resolveX64dbgRoot(ctx);
    const placed: string[] = [];
    const notes: string[] = [];

    const targets: { assetRe: RegExp; subdir: string; label: string }[] = [
      { assetRe: /x64dbg_mcp\.dp64$/i, subdir: "x64", label: "x64 (64-bit)" },
      { assetRe: /x32dbg_mcp\.dp32$/i, subdir: "x32", label: "x32 (32-bit)" },
    ];

    for (const t of targets) {
      const pluginsDir = path.join(root, t.subdir, "plugins");
      if (!(await exists(path.join(root, t.subdir)))) {
        ctx.logger.detail(`Skipping ${t.label}: ${t.subdir}/ not present in this x64dbg build.`);
        continue;
      }
      const asset = await githubReleaseAsset(PLUGIN_REPO, t.assetRe);
      const download = path.join(ctx.toolsDir, "x64dbg-mcp", asset.name);
      await ctx.logger.task(`Download ${t.label} plugin (${asset.tag})`, () =>
        downloadFile(asset.url, download),
      );
      await ensureDir(pluginsDir);
      const dest = path.join(pluginsDir, asset.name);
      await copyFile(download, dest);
      placed.push(dest);

      // Make the HTTP server start on launch, so the client connects without the
      // user having to click Plugins -> MCP Server -> Start MCP HTTP Server.
      const cfg = await enableAutoStart(pluginConfigDir(pluginsDir, asset.name));
      if (cfg) {
        placed.push(cfg);
      } else {
        notes.push(
          `Could not write the ${t.label} plugin config — the MCP server will not auto-start. Enable it via Plugins -> MCP Server -> Start MCP HTTP Server, or set features.auto_start_mcp_on_plugin_load=true in the plugin's config.json.`,
        );
      }
    }

    if (placed.length === 0 && !ctx.dryRun) {
      throw new Error(
        "No x64dbg plugin was placed — check that the x64dbg release folder has x64/ or x32/ subfolders.",
      );
    }

    return {
      servers: {
        x64dbg: { type: "http", url: `http://127.0.0.1:${PORT}/mcp` },
      },
      placedFiles: placed,
      notes,
    };
  },

  postInstallNotes: [
    "Launch x64dbg (64-bit) or x32dbg (32-bit). This installer enabled auto-start, so the plugin brings up the MCP server on 127.0.0.1:3000 automatically at startup — no menu action needed. The Log tab should show 'MCP HTTP Server started'.",
    "The server only responds while x64dbg is open, and returns live data once you load a target. To disable auto-start, set features.auto_start_mcp_on_plugin_load=false in <x64dbg>/release/<arch>/plugins/<arch>dbg-mcp/config.json (or just start it manually via Plugins -> MCP Server -> Start MCP HTTP Server).",
    "Memory writes, register writes and script execution are OFF by default. Opt in via the plugin's config.json only if you need them.",
    "For stdio-only clients, this installer bridges the HTTP URL through `npx mcp-remote` automatically (Claude Desktop). Other clients connect to the URL directly.",
    "Run x64dbg inside a VM/sandbox when analysing untrusted binaries — you are giving an AI live debugger control.",
  ],

  async verify(ctx: InstallContext): Promise<boolean> {
    const root = path.join(ctx.toolsDir, "x64dbg", "release");
    return (
      (await exists(path.join(root, "x64", "plugins"))) ||
      (await exists(path.join(root, "x32", "plugins")))
    );
  },
};
