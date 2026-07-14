import path from "node:path";
import fsp from "node:fs/promises";
import type {
  InstallContext,
  Recipe,
  RecipeInstallResult,
} from "../core/types.js";
import { exists, ensureDir, copyFile, readText } from "../core/fs-utils.js";
import { which } from "../core/exec.js";
import {
  downloadFile,
  extractZip,
  githubReleaseAsset,
} from "../core/download.js";

const PLUGIN_REPO = "LaurieWired/GhidraMCP";
const GHIDRA_REPO = "NationalSecurityAgency/ghidra";

// GhidraMCP v1.4 targets Ghidra 11.3.2 EXACTLY — the extension refuses to load
// into a mismatched Ghidra, so we pin both sides. We accept any locally-found
// 11.3.x (patch drift within the minor is loadable); anything else is replaced
// by the pinned download.
const GHIDRA_VERSION = "11.3.2";
const GHIDRA_MINOR = "11.3";
const GHIDRA_TAG = "Ghidra_11.3.2_build";
const GHIDRA_ASSET_RE = /ghidra_11\.3\.2_PUBLIC_.*\.zip$/i;
const GHIDRA_FOLDER = `ghidra_${GHIDRA_VERSION}_PUBLIC`;

const PORT = 8080;
const SERVER_URL = `http://127.0.0.1:${PORT}/`;

/** Read `application.version` from a Ghidra install root, if it is one. */
async function ghidraVersionAt(root: string): Promise<string | undefined> {
  const propFile = path.join(root, "Ghidra", "application.properties");
  if (!(await exists(propFile))) return undefined;
  const m = (await readText(propFile)).match(/application\.version=([\d.]+)/);
  return m?.[1];
}

/** Find a 11.3.x Ghidra root directly under `dir` (extraction may add a suffix). */
async function findGhidraRootUnder(dir: string): Promise<string | undefined> {
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const full = path.join(dir, name);
    const v = await ghidraVersionAt(full);
    if (v && v.startsWith(`${GHIDRA_MINOR}.`)) return full;
  }
  return undefined;
}

/**
 * Locate a Ghidra 11.3.x install (env GHIDRA_INSTALL_DIR, `ghidraRun` on PATH,
 * common folders, our managed copy). If none matches, download and extract the
 * pinned 11.3.2 release into the managed tools dir.
 */
async function resolveGhidraRoot(ctx: InstallContext): Promise<string> {
  const managedDir = path.join(ctx.toolsDir, "ghidra");
  const managed = path.join(managedDir, GHIDRA_FOLDER);
  const candidates: string[] = [];

  const envDir = process.env.GHIDRA_INSTALL_DIR;
  if (envDir) candidates.push(envDir);

  const runName = ctx.platform === "win32" ? "ghidraRun.bat" : "ghidraRun";
  const onPath = await which(runName);
  if (onPath) candidates.push(path.dirname(onPath));

  candidates.push(managed, path.join(ctx.home, GHIDRA_FOLDER));
  if (ctx.platform === "win32") {
    candidates.push(path.join("C:\\", GHIDRA_FOLDER));
    const pf = process.env.ProgramFiles;
    if (pf) candidates.push(path.join(pf, GHIDRA_FOLDER));
  } else if (ctx.platform === "darwin") {
    candidates.push(path.join("/Applications", GHIDRA_FOLDER));
  } else {
    candidates.push(path.join("/opt", GHIDRA_FOLDER));
  }

  for (const c of candidates) {
    const v = await ghidraVersionAt(c);
    if (v && v.startsWith(`${GHIDRA_MINOR}.`)) {
      ctx.logger.detail(`Using Ghidra ${v} at ${c}`);
      return c;
    }
  }

  ctx.logger.detail(
    `Ghidra ${GHIDRA_VERSION} not found — downloading the pinned release.`,
  );
  const asset = await ctx.logger.task("Resolve Ghidra 11.3.2", () =>
    githubReleaseAsset(GHIDRA_REPO, GHIDRA_ASSET_RE, GHIDRA_TAG),
  );
  const zip = path.join(managedDir, asset.name);
  await ctx.logger.task(`Download Ghidra (${asset.tag})`, () =>
    downloadFile(asset.url, zip),
  );
  await ctx.logger.task("Extract Ghidra", () => extractZip(zip, managedDir));
  if (await exists(managed)) return managed;
  const found = await findGhidraRootUnder(managedDir);
  if (found) return found;
  throw new Error(
    `Extracted Ghidra but could not find an install root under ${managedDir}`,
  );
}

/** Recursively collect every file path under `dir`. */
async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fsp
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}

export const ghidraRecipe: Recipe = {
  id: "ghidra",
  name: "Ghidra MCP",
  description:
    "Python MCP bridge to the GhidraMCP Ghidra extension over HTTP (LaurieWired/GhidraMCP), pinned to Ghidra 11.3.2 + JDK 21.",
  hostApp: "Ghidra",
  platforms: ["win32", "darwin", "linux"],
  dependencies: ["jdk21", "python"],
  approxDownloadMb: 400, // Ghidra itself is the bulk of this.

  async install(ctx: InstallContext): Promise<RecipeInstallResult> {
    const pythonCmd = ctx.depStatus.get("python")?.path ?? "python";
    const bridgePath = path.join(
      ctx.toolsDir,
      "GhidraMCP",
      "bridge_mcp_ghidra.py",
    );

    if (ctx.dryRun) {
      ctx.logger.detail(
        "(dry-run) would ensure Ghidra 11.3.2, place the GhidraMCP extension, save the bridge, and pip install mcp+requests.",
      );
      return {
        servers: {
          ghidra: {
            command: pythonCmd,
            args: [bridgePath, "--ghidra-server", SERVER_URL],
          },
        },
        placedFiles: [],
      };
    }

    const placed: string[] = [];

    // 1. Host app: a Ghidra 11.3.x install (download the pinned one if missing).
    const ghidraRoot = await resolveGhidraRoot(ctx);

    // 2. Download the GhidraMCP release. v1.4 ships a single uploaded asset
    //    (GhidraMCP-release-1-4.zip) that BUNDLES the Ghidra extension zip and
    //    bridge_mcp_ghidra.py; the permissive regex tolerates future renames.
    const asset = await ctx.logger.task("Resolve GhidraMCP release", () =>
      githubReleaseAsset(PLUGIN_REPO, /GhidraMCP.*\.zip$/i),
    );
    const download = path.join(ctx.toolsDir, "GhidraMCP", asset.name);
    await ctx.logger.task(`Download GhidraMCP (${asset.tag})`, () =>
      downloadFile(asset.url, download),
    );
    const extractDir = path.join(
      ctx.toolsDir,
      "GhidraMCP",
      `extract-${asset.tag}`,
    );
    await ctx.logger.task("Extract GhidraMCP release", () =>
      extractZip(download, extractDir),
    );

    // 3. Locate the inner extension zip + the bridge inside the extraction.
    //    Layout A (v1.4): outer zip contains GhidraMCP-<ver>.zip + bridge.
    //    Layout B: the downloaded asset IS the extension zip (bridge separate).
    const files = await walkFiles(extractDir);
    let extensionZip =
      files.find(
        (f) =>
          /GhidraMCP.*\.zip$/i.test(path.basename(f)) &&
          !/release/i.test(path.basename(f)),
      ) ?? files.find((f) => /\.zip$/i.test(path.basename(f)));
    if (!extensionZip) extensionZip = download; // Layout B fallback.

    let bridgeSrc = files.find(
      (f) => path.basename(f).toLowerCase() === "bridge_mcp_ghidra.py",
    );
    if (!bridgeSrc) {
      // Not bundled — try a standalone release asset.
      const bridgeAsset = await githubReleaseAsset(
        PLUGIN_REPO,
        /bridge_mcp_ghidra\.py$/i,
      );
      const dest = path.join(ctx.toolsDir, "GhidraMCP", bridgeAsset.name);
      await ctx.logger.task("Download GhidraMCP bridge", () =>
        downloadFile(bridgeAsset.url, dest),
      );
      bridgeSrc = dest;
    }

    // 4. Place the extension where Ghidra auto-discovers it (the user still
    //    enables it in the GUI). Host-app mutation only when not a dry run.
    const extensionsDir = path.join(ghidraRoot, "Ghidra", "Extensions");
    await ensureDir(extensionsDir);
    const dest = path.join(extensionsDir, path.basename(extensionZip));
    await copyFile(extensionZip, dest);
    placed.push(dest);

    // 5. Keep the bridge in our managed dir; that's the path the client spawns.
    if (path.resolve(bridgeSrc) !== path.resolve(bridgePath)) {
      await copyFile(bridgeSrc, bridgePath);
    }
    placed.push(bridgePath);

    // 6. Bridge runtime deps. Best-effort — warn rather than fail the recipe.
    await ctx.logger.task("pip install mcp requests (bridge deps)", async () => {
      const res = await ctx.run(
        pythonCmd,
        ["-m", "pip", "install", "--user", "mcp", "requests"],
        { allowFailure: true },
      );
      if (!res.ok) {
        ctx.logger.warn(
          `Could not install the bridge's Python deps. Install them manually: ${pythonCmd} -m pip install --user mcp requests`,
        );
      }
    });

    return {
      servers: {
        ghidra: {
          command: pythonCmd,
          args: [bridgePath, "--ghidra-server", SERVER_URL],
        },
      },
      placedFiles: placed,
      notes: [`Ghidra 11.3.x in use: ${ghidraRoot}`],
    };
  },

  postInstallNotes: [
    "Install the extension in Ghidra: File -> Install Extensions, tick 'GhidraMCP', then restart Ghidra.",
    "Enable the plugin: open a program (CodeBrowser), then File -> Configure -> Developer -> check 'GhidraMCPPlugin'. This starts the HTTP server on 127.0.0.1:8080.",
    "Ghidra must stay OPEN with a program loaded for the MCP tools to respond.",
    "JDK 21 is required — Ghidra 11.3.2 will not launch without it.",
    "Version lock: GhidraMCP v1.4 only loads into Ghidra 11.3.2; mismatched versions are refused.",
    "Default server is http://127.0.0.1:8080/ (port 8080). If you change the port in the plugin options, pass a matching --ghidra-server to the bridge.",
  ],

  async verify(ctx: InstallContext): Promise<boolean> {
    return exists(path.join(ctx.toolsDir, "GhidraMCP", "bridge_mcp_ghidra.py"));
  },
};
