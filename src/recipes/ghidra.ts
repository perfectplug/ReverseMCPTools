import path from "node:path";
import fsp from "node:fs/promises";
import type {
  InstallContext,
  Recipe,
  RecipeInstallResult,
} from "../core/types.js";
import { exists, ensureDir, copyFile, readText } from "../core/fs-utils.js";
import {
  downloadFile,
  extractArchive,
  githubReleaseAsset,
} from "../core/download.js";
import { managedEnv, managedLayout } from "../core/layout.js";
import {
  ensurePythonVenv,
  executableHome,
  requireDependencyPath,
  venvPythonPath,
  writeManagedLauncher,
} from "../core/managed-packages.js";

const PLUGIN_REPO = "LaurieWired/GhidraMCP";
const PLUGIN_TAG = "1.4";
const GHIDRA_REPO = "NationalSecurityAgency/ghidra";
const GHIDRA_VERSION = "11.3.2";
const GHIDRA_MINOR = "11.3";
const GHIDRA_TAG = "Ghidra_11.3.2_build";
const GHIDRA_ASSET_RE = /ghidra_11\.3\.2_PUBLIC_.*\.zip$/i;
const GHIDRA_SHA256 =
  "99d45035bdcc3d6627e7b1232b7b379905a9fad76c772c920602e2b5d8b2dac2";
const GHIDRA_FOLDER = `ghidra_${GHIDRA_VERSION}_PUBLIC`;
const PORT = 8080;
const SERVER_URL = `http://127.0.0.1:${PORT}/`;

async function ghidraVersionAt(root: string): Promise<string | undefined> {
  const propFile = path.join(root, "Ghidra", "application.properties");
  if (!(await exists(propFile))) return undefined;
  const match = (await readText(propFile)).match(
    /application\.version=([\d.]+)/,
  );
  return match?.[1];
}

async function findGhidraRootUnder(
  dir: string,
): Promise<string | undefined> {
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const full = path.join(dir, name);
    const version = await ghidraVersionAt(full);
    if (version?.startsWith(`${GHIDRA_MINOR}.`)) return full;
  }
  return undefined;
}

/** Resolve only the copy owned by the shared managed root. */
async function resolveGhidraRoot(ctx: InstallContext): Promise<string> {
  const layout = managedLayout(ctx.toolsDir);
  const managedDir = path.join(layout.tools, "ghidra");
  const expected = path.join(managedDir, GHIDRA_FOLDER);
  const completionMarker = path.join(managedDir, ".remcp-complete");

  const expectedVersion = await ghidraVersionAt(expected);
  if (
    expectedVersion?.startsWith(`${GHIDRA_MINOR}.`) &&
    (await exists(completionMarker))
  ) {
    return expected;
  }
  if (await exists(completionMarker)) {
    const cached = await findGhidraRootUnder(managedDir);
    if (cached) return cached;
  }

  ctx.logger.detail(
    `Managed Ghidra ${GHIDRA_VERSION} is missing; downloading the pinned release.`,
  );
  const asset = await ctx.logger.task("Resolve Ghidra 11.3.2", () =>
    githubReleaseAsset(GHIDRA_REPO, GHIDRA_ASSET_RE, GHIDRA_TAG),
  );
  const archive = path.join(layout.downloads, "ghidra", asset.name);
  await ctx.logger.task(`Download Ghidra (${asset.tag})`, () =>
    downloadFile(asset.url, archive, {
      sha256: asset.sha256 ?? GHIDRA_SHA256,
    }),
  );
  await fsp.rm(completionMarker, { force: true });
  await ctx.logger.task("Extract Ghidra", () =>
    extractArchive(archive, managedDir),
  );
  if (await ghidraVersionAt(expected)) {
    await fsp.writeFile(completionMarker, `${GHIDRA_VERSION}\n`, "utf8");
    return expected;
  }
  const found = await findGhidraRootUnder(managedDir);
  if (found) {
    await fsp.writeFile(completionMarker, `${GHIDRA_VERSION}\n`, "utf8");
    return found;
  }
  throw new Error(
    `Extracted Ghidra but could not find an install root under ${managedDir}`,
  );
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fsp
    .readdir(dir, { withFileTypes: true })
    .catch(() => [] as import("node:fs").Dirent[]);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}

function launcherPath(ctx: InstallContext): string {
  const layout = managedLayout(ctx.toolsDir);
  return path.join(
    layout.tools,
    "ghidra",
    ctx.platform === "win32" ? "ghidra-managed.cmd" : "ghidra-managed",
  );
}

export const ghidraRecipe: Recipe = {
  id: "ghidra",
  name: "Ghidra MCP",
  description:
    "Managed Ghidra 11.3.2 + isolated Python MCP bridge (LaurieWired/GhidraMCP).",
  hostApp: "Ghidra",
  platforms: ["win32", "darwin", "linux"],
  dependencies: ["jdk21", "uv", "python"],
  approxDownloadMb: 400,

  async install(ctx: InstallContext): Promise<RecipeInstallResult> {
    const layout = managedLayout(ctx.toolsDir);
    const serverDir = path.join(layout.servers, "ghidra-mcp");
    const bridgePath = path.join(serverDir, "bridge_mcp_ghidra.py");
    const venvDir = path.join(layout.envs, "ghidra-mcp");
    const managedPython = venvPythonPath(venvDir, ctx.platform);
    const plannedLauncher = launcherPath(ctx);
    const baseServerEnv: Record<string, string> = {
      ...managedEnv(ctx.toolsDir),
      PYTHONNOUSERSITE: "1",
      PYTHONUTF8: "1",
    };

    if (ctx.dryRun) {
      ctx.logger.detail(
        `(dry-run) would install Ghidra under ${path.join(layout.tools, "ghidra")}, create ${venvDir}, install mcp+requests there, and generate ${plannedLauncher}.`,
      );
      return {
        servers: {
          ghidra: {
            command: managedPython,
            args: [bridgePath, "--ghidra-server", SERVER_URL],
            env: baseServerEnv,
          },
        },
        placedFiles: [bridgePath, managedPython, plannedLauncher],
      };
    }

    const javaPath = requireDependencyPath(ctx, "jdk21");
    const pythonPath = requireDependencyPath(ctx, "python");
    const uvPath = requireDependencyPath(ctx, "uv");
    const javaHome = executableHome(javaPath);
    const ghidraRoot = await resolveGhidraRoot(ctx);
    const serverEnv: Record<string, string> = {
      ...baseServerEnv,
      JAVA_HOME: javaHome,
      GHIDRA_HOME: ghidraRoot,
      GHIDRA_INSTALL_DIR: ghidraRoot,
    };
    const launcherEnv: Record<string, string> = {
      ...serverEnv,
      PATH: [
        path.join(javaHome, "bin"),
        process.env.PATH ?? "",
      ]
        .filter(Boolean)
        .join(path.delimiter),
    };

    const extensionsDir = path.join(ghidraRoot, "Ghidra", "Extensions");
    await ensureDir(extensionsDir);
    const serverCompletion = path.join(serverDir, ".remcp-complete");
    const existingExtension = (await fsp.readdir(extensionsDir).catch(() => []))
      .find((name) => /GhidraMCP.*\.zip$/i.test(name));
    let extensionDest = existingExtension
      ? path.join(extensionsDir, existingExtension)
      : "";

    if (
      !extensionDest ||
      !(await exists(bridgePath)) ||
      !(await exists(serverCompletion))
    ) {
      const asset = await ctx.logger.task("Resolve GhidraMCP release", () =>
        githubReleaseAsset(
          PLUGIN_REPO,
          /GhidraMCP.*\.zip$/i,
          PLUGIN_TAG,
        ),
      );
      const download = path.join(
        layout.downloads,
        "ghidra-mcp",
        asset.name,
      );
      await ctx.logger.task(`Download GhidraMCP (${asset.tag})`, () =>
        downloadFile(asset.url, download, { sha256: asset.sha256 }),
      );
      const extractDir = path.join(serverDir, `source-${asset.tag}`);
      await ctx.logger.task("Extract GhidraMCP release", () =>
        extractArchive(download, extractDir),
      );

      const files = await walkFiles(extractDir);
      let extensionZip =
        files.find(
          (file) =>
            /GhidraMCP.*\.zip$/i.test(path.basename(file)) &&
            !/release/i.test(path.basename(file)),
        ) ?? files.find((file) => /\.zip$/i.test(path.basename(file)));
      if (!extensionZip) extensionZip = download;

      let bridgeSource = files.find(
        (file) =>
          path.basename(file).toLowerCase() === "bridge_mcp_ghidra.py",
      );
      if (!bridgeSource) {
        const bridgeAsset = await githubReleaseAsset(
          PLUGIN_REPO,
          /bridge_mcp_ghidra\.py$/i,
          PLUGIN_TAG,
        );
        const standalone = path.join(
          layout.downloads,
          "ghidra-mcp",
          bridgeAsset.name,
        );
        await ctx.logger.task("Download GhidraMCP bridge", () =>
          downloadFile(bridgeAsset.url, standalone, {
            sha256: bridgeAsset.sha256,
          }),
        );
        bridgeSource = standalone;
      }

      extensionDest = path.join(
        extensionsDir,
        path.basename(extensionZip),
      );
      await copyFile(extensionZip, extensionDest);
      if (path.resolve(bridgeSource) !== path.resolve(bridgePath)) {
        await copyFile(bridgeSource, bridgePath);
      }
      await fsp.writeFile(
        serverCompletion,
        `${PLUGIN_REPO}@${asset.tag}\n`,
        "utf8",
      );
    }

    const venvPython = await ctx.logger.task(
      "Prepare isolated Ghidra MCP environment",
      () =>
        ensurePythonVenv(ctx, {
          uvPath,
          pythonPath,
          venvDir,
          packages: ["mcp", "requests"],
          env: serverEnv,
        }),
    );

    const ghidraExecutable = path.join(
      ghidraRoot,
      ctx.platform === "win32" ? "ghidraRun.bat" : "ghidraRun",
    );
    if (!(await exists(ghidraExecutable))) {
      throw new Error(`Managed Ghidra launcher is missing: ${ghidraExecutable}`);
    }
    const generatedLauncher = await writeManagedLauncher(ctx, {
      launcherPath: plannedLauncher,
      executable: ghidraExecutable,
      env: launcherEnv,
    });

    return {
      servers: {
        ghidra: {
          command: venvPython,
          args: [bridgePath, "--ghidra-server", SERVER_URL],
          env: serverEnv,
        },
      },
      placedFiles: [
        extensionDest,
        bridgePath,
        venvPython,
        generatedLauncher,
      ],
      notes: [
        `Managed Ghidra ${await ghidraVersionAt(ghidraRoot)}: ${ghidraRoot}`,
        `Launch Ghidra through ${generatedLauncher} so it always uses the managed JDK.`,
      ],
    };
  },

  postInstallNotes: [
    "Launch Ghidra with the generated ghidra-managed launcher.",
    "Install/enable the GhidraMCP extension in File -> Install Extensions, restart Ghidra, then enable Developer -> GhidraMCPPlugin.",
    "Ghidra must stay open with a program loaded. The plugin listens on http://127.0.0.1:8080/.",
    "Ghidra and GhidraMCP are version-locked to the managed 11.3.2-compatible release.",
  ],

  async verify(ctx: InstallContext): Promise<boolean> {
    const layout = managedLayout(ctx.toolsDir);
    const ghidraRoot = await findGhidraRootUnder(
      path.join(layout.tools, "ghidra"),
    );
    if (!ghidraRoot) return false;
    const extensions = await fsp
      .readdir(path.join(ghidraRoot, "Ghidra", "Extensions"))
      .catch(() => [] as string[]);
    return (
      extensions.some((name) => /GhidraMCP.*\.zip$/i.test(name)) &&
      (await exists(
        path.join(layout.tools, "ghidra", ".remcp-complete"),
      )) &&
      (await exists(
        path.join(layout.servers, "ghidra-mcp", "bridge_mcp_ghidra.py"),
      )) &&
      (await exists(
        path.join(layout.servers, "ghidra-mcp", ".remcp-complete"),
      )) &&
      (await exists(
        venvPythonPath(
          path.join(layout.envs, "ghidra-mcp"),
          ctx.platform,
        ),
      )) &&
      (await exists(
        path.join(layout.envs, "ghidra-mcp", ".remcp-complete"),
      )) &&
      (await exists(launcherPath(ctx)))
    );
  },
};
