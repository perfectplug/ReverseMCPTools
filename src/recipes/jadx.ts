import path from "node:path";
import fsp from "node:fs/promises";
import type {
  InstallContext,
  Platform,
  Recipe,
  RecipeInstallResult,
} from "../core/types.js";
import { exists } from "../core/fs-utils.js";
import { which, winCmd } from "../core/exec.js";
import {
  downloadFile,
  extractZip,
  githubReleaseAsset,
} from "../core/download.js";

const JADX_REPO = "skylot/jadx";
// Plugin ref understood by the jadx CLI plugin installer.
const PLUGIN_REF = "github:zinja-coder:jadx-ai-mcp";
const SERVER_PKG = "git+https://github.com/zinja-coder/jadx-mcp-server";
// The plugin serves live decompiler context on this loopback port.
const PLUGIN_PORT = 8650;

function jadxLauncherName(platform: Platform): string {
  return platform === "win32" ? "jadx.bat" : "jadx";
}

/** Find `bin/<name>` under `root`, tolerating an archive that wraps its files. */
async function findLauncherIn(
  root: string,
  name: string,
  depth: number,
): Promise<string | undefined> {
  const direct = path.join(root, "bin", name);
  if (await exists(direct)) return direct;
  if (depth <= 0) return undefined;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findLauncherIn(path.join(root, e.name), name, depth - 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Resolve the jadx CLI launcher (`bin/jadx.bat` on Windows, `bin/jadx`
 * elsewhere). Checks PATH and our managed dir; otherwise downloads the official
 * release into `ctx.toolsDir/jadx` and extracts it.
 */
async function resolveJadxLauncher(ctx: InstallContext): Promise<string> {
  const name = jadxLauncherName(ctx.platform);
  const managed = path.join(ctx.toolsDir, "jadx");

  // On PATH already? `which` returns the launcher itself.
  const onPath =
    (await which("jadx")) ??
    (ctx.platform === "win32" ? await which("jadx.bat") : undefined);
  if (onPath) return onPath;

  // Previously downloaded into our managed dir?
  const cached = await findLauncherIn(managed, name, 2);
  if (cached) return cached;

  // Download the official release. Prefer the cross-platform `jadx-<ver>.zip`:
  // it is the only asset that ships the CLI launcher (bin/jadx[.bat]) AND the
  // GUI launcher (bin/jadx-gui[.bat]). The Windows `jadx-gui-<ver>-win.zip` is a
  // GUI-only bundle (jadx-gui.exe + lib/) with no bin/jadx.bat, so it cannot
  // drive the plugin CLI — keep it only as a last-resort fallback.
  const patterns: RegExp[] =
    ctx.platform === "win32"
      ? [/jadx-\d.*\.zip$/i, /jadx-gui-.*\.zip$/i]
      : [/jadx-\d.*\.zip$/i];

  ctx.logger.detail("jadx not found — downloading the official release.");
  let asset: { url: string; name: string; tag: string } | undefined;
  let lastErr: unknown;
  for (const pat of patterns) {
    try {
      asset = await githubReleaseAsset(JADX_REPO, pat);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!asset) {
    throw new Error(`Could not resolve a jadx release asset: ${String(lastErr)}`);
  }
  const chosen = asset;

  const zip = path.join(managed, chosen.name);
  await ctx.logger.task(`Download jadx (${chosen.tag})`, () =>
    downloadFile(chosen.url, zip),
  );
  await ctx.logger.task("Extract jadx", () => extractZip(zip, managed));

  const found = await findLauncherIn(managed, name, 2);
  if (!found) {
    throw new Error(
      `Extracted jadx into ${managed} but could not find bin/${name}.`,
    );
  }
  return found;
}

/**
 * Resolve the absolute path to the `jadx_mcp_server` executable that
 * `uv tool install` produced. `uv tool dir --bin` reports the exact directory;
 * we fall back to the conventional `~/.local/bin`, then to whatever is on PATH,
 * and finally to the bare name if nothing is found.
 */
async function resolveJadxServerCommand(ctx: InstallContext): Promise<string> {
  const exe = ctx.platform === "win32" ? "jadx_mcp_server.exe" : "jadx_mcp_server";

  const candidateDirs: string[] = [];
  const res = await ctx.run("uv", ["tool", "dir", "--bin"], { allowFailure: true });
  if (res.ok) {
    const dir = res.stdout.trim();
    if (dir) candidateDirs.push(dir);
  }
  candidateDirs.push(path.join(ctx.home, ".local", "bin"));

  for (const dir of candidateDirs) {
    const full = path.join(dir, exe);
    if (await exists(full)) return full;
  }

  const onPath = await which("jadx_mcp_server");
  return onPath ?? "jadx_mcp_server";
}

export const jadxRecipe: Recipe = {
  id: "jadx",
  name: "JADX MCP",
  description:
    "Bridges jadx-gui's Android decompiler to MCP: installs the jadx-ai-mcp plugin into jadx-gui plus the jadx_mcp_server bridge (zinja-coder).",
  hostApp: "jadx-gui",
  platforms: ["win32", "darwin", "linux"],
  dependencies: ["jdk21", "python", "uv", "git"],
  approxDownloadMb: 50,

  async install(ctx: InstallContext): Promise<RecipeInstallResult> {
    if (ctx.dryRun) {
      ctx.logger.detail(
        "(dry-run) would ensure jadx-gui, install the jadx-ai-mcp plugin, and `uv tool install` jadx_mcp_server.",
      );
      return { servers: { jadx: { command: "jadx_mcp_server" } }, placedFiles: [] };
    }

    const notes: string[] = [];
    const launcher = await resolveJadxLauncher(ctx);

    // 1) Install the jadx-ai-mcp plugin via the jadx CLI (writes into the user's
    //    jadx config). The .bat launcher must go through cmd /c on Windows.
    await ctx.logger.task("Install jadx-ai-mcp plugin", async () => {
      const args = ["plugins", "--install", PLUGIN_REF];
      const res =
        ctx.platform === "win32"
          ? await winCmd(launcher, args, { allowFailure: true })
          : await ctx.run(launcher, args, { allowFailure: true });
      if (!res.ok) {
        const why = res.stderr.trim() || res.stdout.trim() || "network/plugin repo error";
        ctx.logger.warn(
          `Could not install jadx-ai-mcp automatically (${why}). In jadx-gui: Plugins -> Install plugin -> ${PLUGIN_REF}.`,
        );
        notes.push(
          `jadx-ai-mcp plugin auto-install failed — install it from jadx-gui (Plugins -> Install plugin -> ${PLUGIN_REF}).`,
        );
      }
    });

    // 2) Install the Python MCP server globally with uv. This drops a
    //    `jadx_mcp_server` executable into uv's bin dir (~/.local/bin) on PATH.
    await ctx.logger.task("Install jadx_mcp_server (uv tool)", async () => {
      const res = await ctx.run("uv", ["tool", "install", SERVER_PKG], {
        allowFailure: true,
      });
      if (!res.ok) {
        const why = res.stderr.trim() || res.stdout.trim() || "unknown error";
        ctx.logger.warn(
          `uv tool install failed (${why}). Retry manually: uv tool install ${SERVER_PKG}`,
        );
        notes.push(
          `jadx_mcp_server install failed — retry with: uv tool install ${SERVER_PKG}`,
        );
      }
    });

    // Emit the absolute path to the installed server: uv's tool bin (e.g.
    // ~/.local/bin) is frequently not on PATH, so a bare command name fails to
    // spawn from the client. Fall back to the bare name only if unlocatable.
    const serverCommand = await resolveJadxServerCommand(ctx);
    if (serverCommand === "jadx_mcp_server") {
      notes.push(
        "Could not locate the installed jadx_mcp_server executable — config uses the bare name, so ensure uv's tool bin (e.g. ~/.local/bin) is on PATH.",
      );
    }

    return {
      servers: { jadx: { command: serverCommand } },
      placedFiles: [],
      notes,
    };
  },

  postInstallNotes: [
    "Open jadx-gui and load your APK/DEX/JAR before using the tools. The plugin serves live decompiler context on 127.0.0.1:8650, and the MCP tools return nothing while jadx-gui is closed or has no target loaded.",
    "You need BOTH halves for this to work: the jadx-ai-mcp plugin inside jadx-gui AND the jadx_mcp_server bridge registered in your client.",
    "jadx requires a JRE/JDK 11+ on PATH (JDK 21 installed by this tool satisfies it).",
    "If your client reports that `jadx_mcp_server` was not found, restart the terminal/client so uv's bin dir (e.g. ~/.local/bin) is on PATH — or point the client at `uv --directory <jadx-mcp-server> run jadx_mcp_server` instead.",
  ],

  async verify(ctx: InstallContext): Promise<boolean> {
    const server = await which("jadx_mcp_server");
    if (server) return true;
    const onPath = await which("jadx");
    if (onPath) return true;
    const managed = path.join(ctx.toolsDir, "jadx");
    return (await findLauncherIn(managed, jadxLauncherName(ctx.platform), 2)) !== undefined;
  },
};
