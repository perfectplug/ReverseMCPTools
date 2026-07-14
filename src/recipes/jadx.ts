import path from "node:path";
import fsp from "node:fs/promises";
import type {
  InstallContext,
  Platform,
  Recipe,
  RecipeInstallResult,
} from "../core/types.js";
import { exists, ensureDir } from "../core/fs-utils.js";
import { which, winCmd } from "../core/exec.js";
import {
  downloadFile,
  extractZip,
  githubReleaseAsset,
} from "../core/download.js";

const JADX_REPO = "skylot/jadx";
// Plugin ref understood by the jadx CLI plugin installer.
const PLUGIN_REF = "github:zinja-coder:jadx-ai-mcp";
// The MCP bridge server. It is deliberately NOT installed as a wheel/uv-tool:
// its pyproject only packages the top-level `jadx_mcp_server.py`
// (`py-modules = ["jadx_mcp_server"]`), yet that module imports the sibling
// `src/` package (`from src.banner import ...`). A wheel install therefore
// crashes at startup with `ModuleNotFoundError: No module named 'src'`. We clone
// the repo and run it in place with `uv run`, where the repo root is on
// sys.path[0] so `src` resolves.
const SERVER_REPO = "https://github.com/zinja-coder/jadx-mcp-server";
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
 * Resolve an absolute path to the `uv` executable. uv's install dir is often
 * not on the client's PATH, so we emit the absolute path in the client config
 * and only fall back to the bare name (relying on PATH) if it cannot be found.
 */
async function resolveUvCommand(): Promise<string> {
  return (await which("uv")) ?? "uv";
}

/**
 * Clone (or fast-forward) the jadx-mcp-server repo into our managed tools dir
 * and return its root. The bridge is run from this checkout via `uv run` rather
 * than installed as a package (see SERVER_REPO note).
 */
async function ensureJadxServerRepo(ctx: InstallContext): Promise<string> {
  const repoDir = path.join(ctx.toolsDir, "jadx-mcp-server");
  if (await exists(path.join(repoDir, ".git"))) {
    // Best-effort update; ignore failures (offline / local edits present).
    await ctx.run("git", ["-C", repoDir, "pull", "--ff-only"], {
      allowFailure: true,
    });
    return repoDir;
  }
  await ensureDir(ctx.toolsDir);
  await ctx.logger.task("Clone jadx-mcp-server", async () => {
    const res = await ctx.run(
      "git",
      ["clone", "--depth", "1", SERVER_REPO, repoDir],
      { allowFailure: true },
    );
    if (!res.ok) {
      throw new Error(
        `git clone failed: ${res.stderr.trim() || res.stdout.trim() || "unknown error"}`,
      );
    }
  });
  return repoDir;
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
        "(dry-run) would ensure jadx-gui + the jadx-ai-mcp plugin, clone jadx-mcp-server, `uv sync` it, and register `uv --directory <repo> run jadx_mcp_server.py`.",
      );
      return {
        servers: {
          jadx: {
            type: "stdio",
            command: "uv",
            args: [
              "--directory",
              path.join(ctx.toolsDir, "jadx-mcp-server"),
              "run",
              "jadx_mcp_server.py",
            ],
          },
        },
        placedFiles: [],
      };
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

    // 2) Clone the MCP bridge server and pre-sync its venv, so the client's
    //    first spawn is fast. A cold `uv run` downloads the whole dependency
    //    set (fastmcp, uvicorn, pywin32, ...) on first launch and can blow the
    //    client's connect timeout, showing the server as "failed".
    const repoDir = await ensureJadxServerRepo(ctx);
    await ctx.logger.task("Prepare jadx_mcp_server env (uv sync)", async () => {
      const res = await ctx.run("uv", ["--directory", repoDir, "sync"], {
        allowFailure: true,
        timeoutMs: 300_000,
      });
      if (!res.ok) {
        const why = res.stderr.trim() || res.stdout.trim() || "unknown error";
        ctx.logger.warn(
          `uv sync failed (${why}). The server will sync on first launch, which may delay the client's first connection.`,
        );
        notes.push(
          `jadx_mcp_server env not pre-synced — retry once with: uv --directory ${repoDir} sync`,
        );
      }
    });

    // Emit `uv --directory <repo> run jadx_mcp_server.py`: running the entry
    // script in place puts the repo root on sys.path so the `src` package
    // resolves, and uv provisions/updates the venv transparently.
    const uvCmd = await resolveUvCommand();
    if (uvCmd === "uv") {
      notes.push(
        "Could not resolve an absolute path to uv — config uses the bare name, so ensure uv is on PATH for your client.",
      );
    }

    return {
      servers: {
        jadx: {
          type: "stdio",
          command: uvCmd,
          args: ["--directory", repoDir, "run", "jadx_mcp_server.py"],
        },
      },
      placedFiles: [],
      notes,
    };
  },

  postInstallNotes: [
    "Open jadx-gui and load your APK/DEX/JAR before using the tools. The plugin serves live decompiler context on 127.0.0.1:8650, and the MCP tools return nothing while jadx-gui is closed or has no target loaded.",
    "You need BOTH halves for this to work: the jadx-ai-mcp plugin inside jadx-gui AND the jadx_mcp_server bridge registered in your client.",
    "jadx requires a JRE/JDK 11+ on PATH (JDK 21 installed by this tool satisfies it).",
    "The bridge runs from a cloned checkout via `uv run`, which provisions its own venv. If the client's first connection times out, pre-build the env once: `uv --directory <toolsDir>/jadx-mcp-server sync`.",
  ],

  async verify(ctx: InstallContext): Promise<boolean> {
    // The bridge is placed as a cloned repo we launch with `uv run`.
    if (
      await exists(
        path.join(ctx.toolsDir, "jadx-mcp-server", "jadx_mcp_server.py"),
      )
    ) {
      return true;
    }
    const onPath = await which("jadx");
    if (onPath) return true;
    const managed = path.join(ctx.toolsDir, "jadx");
    return (await findLauncherIn(managed, jadxLauncherName(ctx.platform), 2)) !== undefined;
  },
};
