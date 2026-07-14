import path from "node:path";
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
        "(dry-run) would ensure x64dbg is present and drop the MCP plugin (.dp64/.dp32) into <x64dbg>/release/{x64,x32}/plugins.",
      );
      return {
        servers: { x64dbg: { type: "http", url: `http://127.0.0.1:${PORT}/mcp` } },
        placedFiles: [],
      };
    }

    const root = await resolveX64dbgRoot(ctx);
    const placed: string[] = [];

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
      if (!ctx.dryRun) {
        await ensureDir(pluginsDir);
        const dest = path.join(pluginsDir, asset.name);
        await copyFile(download, dest);
        placed.push(dest);
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
    };
  },

  postInstallNotes: [
    "Launch x64dbg (64-bit) or x32dbg (32-bit); the plugin starts an MCP server on 127.0.0.1:3000. Check the Log tab to confirm it loaded.",
    "The MCP tools only respond while x64dbg is open with a target loaded.",
    "Memory writes, register writes and script execution are OFF by default. Opt in via the plugin's config.json (under the arch plugins folder) only if you need them.",
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
