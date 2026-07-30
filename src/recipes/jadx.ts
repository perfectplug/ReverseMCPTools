import path from "node:path";
import fsp from "node:fs/promises";
import type {
  InstallContext,
  Platform,
  Recipe,
  RecipeInstallResult,
} from "../core/types.js";
import { exists, ensureDir, writeText } from "../core/fs-utils.js";
import { winCmd } from "../core/exec.js";
import {
  downloadFile,
  extractArchive,
  githubReleaseAsset,
} from "../core/download.js";
import { managedEnv, managedLayout } from "../core/layout.js";
import {
  assertPythonAtLeast,
  ensureGitHubSnapshot,
  executableHome,
  requireDependencyPath,
  uvManagedEnv,
  venvPythonPath,
  writeManagedLauncher,
} from "../core/managed-packages.js";

const JADX_REPO = "skylot/jadx";
const JADX_TAG = "v1.5.6";
const PLUGIN_REF = "github:zinja-coder:jadx-ai-mcp";
const SERVER_REPO = "zinja-coder/jadx-mcp-server";
const PLUGIN_PORT = 8650;

function jadxLauncherName(platform: Platform): string {
  return platform === "win32" ? "jadx.bat" : "jadx";
}

function jadxGuiLauncherName(platform: Platform): string {
  return platform === "win32" ? "jadx-gui.bat" : "jadx-gui";
}

async function findLauncherIn(
  root: string,
  name: string,
  depth: number,
): Promise<string | undefined> {
  const direct = path.join(root, "bin", name);
  if (await exists(direct)) return direct;
  if (depth <= 0) return undefined;
  const entries = await fsp
    .readdir(root, { withFileTypes: true })
    .catch(() => [] as import("node:fs").Dirent[]);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findLauncherIn(
      path.join(root, entry.name),
      name,
      depth - 1,
    );
    if (found) return found;
  }
  return undefined;
}

async function findMatchingFile(
  root: string,
  pattern: RegExp,
  depth = 5,
): Promise<string | undefined> {
  const entries = await fsp
    .readdir(root, { withFileTypes: true })
    .catch(() => [] as import("node:fs").Dirent[]);
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && pattern.test(entry.name)) return full;
    if (entry.isDirectory() && depth > 0) {
      const nested = await findMatchingFile(full, pattern, depth - 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Resolve only the JADX distribution owned by the shared managed root. */
async function resolveJadxLauncher(ctx: InstallContext): Promise<string> {
  const layout = managedLayout(ctx.toolsDir);
  const managed = path.join(layout.tools, "jadx");
  const completionMarker = path.join(managed, ".remcp-complete");
  const name = jadxLauncherName(ctx.platform);
  const cached = await findLauncherIn(managed, name, 3);
  if (cached && (await exists(completionMarker))) return cached;

  const patterns: RegExp[] =
    ctx.platform === "win32"
      ? [/jadx-\d.*\.zip$/i, /jadx-gui-.*\.zip$/i]
      : [/jadx-\d.*\.zip$/i];
  let asset:
    | {
        url: string;
        name: string;
        tag: string;
        sha256?: string;
      }
    | undefined;
  let lastError: unknown;
  for (const pattern of patterns) {
    try {
      asset = await githubReleaseAsset(JADX_REPO, pattern, JADX_TAG);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!asset) {
    throw new Error(
      `Could not resolve a JADX release asset: ${String(lastError)}`,
    );
  }

  const archive = path.join(layout.downloads, "jadx", asset.name);
  await ctx.logger.task(`Download JADX (${asset.tag})`, () =>
    downloadFile(asset.url, archive, { sha256: asset.sha256 }),
  );
  await fsp.rm(completionMarker, { force: true });
  await ctx.logger.task("Extract JADX", () =>
    extractArchive(archive, managed),
  );
  const found = await findLauncherIn(managed, name, 3);
  if (!found) {
    throw new Error(
      `Extracted JADX into ${managed} but could not find bin/${name}.`,
    );
  }
  await fsp.writeFile(completionMarker, `${asset.tag}\n`, "utf8");
  return found;
}

function managedJadxLauncher(ctx: InstallContext): string {
  const layout = managedLayout(ctx.toolsDir);
  return path.join(
    layout.tools,
    "jadx",
    ctx.platform === "win32" ? "jadx-gui-managed.cmd" : "jadx-gui-managed",
  );
}

function plannedExecutable(
  ctx: InstallContext,
  id: string,
  name: string,
): string {
  const detected = ctx.depStatus.get(id)?.path;
  if (detected && path.isAbsolute(detected)) return detected;
  const layout = managedLayout(ctx.toolsDir);
  if (id === "uv") {
    return path.join(
      layout.uv,
      "<managed-uv>",
      ctx.platform === "win32" ? "uv.exe" : "uv",
    );
  }
  if (id === "python") {
    return path.join(
      layout.python,
      "<managed-python>",
      ctx.platform === "win32" ? "python.exe" : path.join("bin", "python"),
    );
  }
  return path.join(
    layout.tools,
    id,
    ctx.platform === "win32" ? `${name}.exe` : name,
  );
}

interface JadxEnvironment extends Record<string, string> {
  JADX_CONFIG_DIR: string;
  JADX_CACHE_DIR: string;
  JADX_TMP_DIR: string;
}

function jadxEnvironment(
  ctx: InstallContext,
  pythonPath: string,
  javaHome?: string,
  includeHostPath = false,
): JadxEnvironment {
  const layout = managedLayout(ctx.toolsDir);
  const environmentDir = path.join(layout.envs, "jadx-mcp");
  const base = uvManagedEnv(ctx.toolsDir, pythonPath, environmentDir);
  const effectiveJavaHome =
    javaHome ?? managedEnv(ctx.toolsDir).JAVA_HOME ?? "";
  return {
    ...base,
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    JADX_CONFIG_DIR: path.join(layout.servers, "jadx-host", "config"),
    JADX_CACHE_DIR: path.join(layout.cache, "jadx"),
    JADX_TMP_DIR: path.join(layout.cache, "tmp", "jadx"),
    ...(effectiveJavaHome
      ? {
          JAVA_HOME: effectiveJavaHome,
          ...(includeHostPath
            ? {
                PATH: [
                  path.join(effectiveJavaHome, "bin"),
                  process.env.PATH ?? "",
                ]
                  .filter(Boolean)
                  .join(path.delimiter),
              }
            : {}),
        }
      : {}),
  };
}

export const jadxRecipe: Recipe = {
  id: "jadx",
  name: "JADX MCP",
  description:
    "Managed JADX GUI, isolated plugin state and a snapshot-based Python 3.13 MCP bridge.",
  hostApp: "jadx-gui",
  platforms: ["win32", "darwin", "linux"],
  dependencies: ["jdk21", "uv", "python"],
  approxDownloadMb: 80,

  async install(ctx: InstallContext): Promise<RecipeInstallResult> {
    const layout = managedLayout(ctx.toolsDir);
    const snapshotRoot = path.join(layout.servers, "jadx-mcp-server");
    const repoDir = path.join(snapshotRoot, "current");
    const serverScript = path.join(repoDir, "jadx_mcp_server.py");
    const environmentDir = path.join(layout.envs, "jadx-mcp");
    const environmentPython = venvPythonPath(environmentDir, ctx.platform);
    const pythonPath = plannedExecutable(ctx, "python", "python");
    const plannedLauncher = managedJadxLauncher(ctx);
    const plannedEnv = jadxEnvironment(ctx, pythonPath);

    if (ctx.dryRun) {
      ctx.logger.detail(
        `(dry-run) would install JADX under ${path.join(layout.tools, "jadx")}, isolate its config/cache/temp directories, download ${SERVER_REPO}@main into ${repoDir}, and sync ${environmentDir}.`,
      );
      return {
        servers: {
          jadx: {
            type: "stdio",
            command: environmentPython,
            args: [serverScript],
            env: plannedEnv,
          },
        },
        placedFiles: [
          serverScript,
          environmentPython,
          plannedLauncher,
          plannedEnv.JADX_CONFIG_DIR,
        ],
      };
    }

    const javaPath = requireDependencyPath(ctx, "jdk21");
    const managedPython = requireDependencyPath(ctx, "python");
    const managedUv = requireDependencyPath(ctx, "uv");
    await assertPythonAtLeast(ctx, managedPython, 3, 13);
    const javaHome = executableHome(javaPath);
    const serverEnv = jadxEnvironment(ctx, managedPython, javaHome);
    const hostEnv = jadxEnvironment(ctx, managedPython, javaHome, true);
    await Promise.all([
      ensureDir(serverEnv.JADX_CONFIG_DIR),
      ensureDir(serverEnv.JADX_CACHE_DIR),
      ensureDir(serverEnv.JADX_TMP_DIR),
      ensureDir(environmentDir),
    ]);

    const cliLauncher = await resolveJadxLauncher(ctx);
    const guiLauncher = await findLauncherIn(
      path.join(layout.tools, "jadx"),
      jadxGuiLauncherName(ctx.platform),
      3,
    );
    if (!guiLauncher) {
      throw new Error("Managed JADX archive does not contain jadx-gui.");
    }

    let pluginFile = await findMatchingFile(
      hostEnv.JADX_CONFIG_DIR,
      /jadx-ai-mcp.*\.jar$/i,
    );
    if (!pluginFile) {
      await ctx.logger.task("Install jadx-ai-mcp plugin", async () => {
        const args = ["plugins", "--install", PLUGIN_REF];
        const result =
          ctx.platform === "win32"
            ? await winCmd(cliLauncher, args, {
                allowFailure: true,
                env: hostEnv,
                timeoutMs: 300_000,
              })
            : await ctx.run(cliLauncher, args, {
                allowFailure: true,
                env: hostEnv,
                timeoutMs: 300_000,
              });
        if (!result.ok) {
          throw new Error(
            `jadx-ai-mcp plugin install failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`,
          );
        }
      });
      pluginFile = await findMatchingFile(
        hostEnv.JADX_CONFIG_DIR,
        /jadx-ai-mcp.*\.jar$/i,
      );
    }
    if (!pluginFile) {
      throw new Error(
        `jadx-ai-mcp reported success but no plugin JAR was found under ${hostEnv.JADX_CONFIG_DIR}`,
      );
    }

    const snapshot = await ctx.logger.task(
      "Download jadx-mcp-server main snapshot",
      () =>
        ensureGitHubSnapshot(ctx, {
          repo: SERVER_REPO,
          branch: "main",
          destination: snapshotRoot,
          marker: "jadx_mcp_server.py",
        }),
    );
    const environmentMarker = path.join(
      environmentDir,
      ".remcp-complete",
    );
    const completedCommit = await fsp
      .readFile(environmentMarker, "utf8")
      .then((value) => value.trim())
      .catch(() => "");
    if (
      !(await exists(environmentPython)) ||
      completedCommit !== snapshot.commit
    ) {
      const synced = await ctx.logger.task(
        "Prepare jadx_mcp_server Python 3.13 environment",
        () =>
          ctx.run(
            managedUv,
            [
              "--directory",
              snapshot.repoDir,
              "sync",
              "--python",
              managedPython,
            ],
            {
              allowFailure: true,
              env: serverEnv,
              timeoutMs: 600_000,
            },
          ),
      );
      if (!synced.ok || !(await exists(environmentPython))) {
        throw new Error(
          `uv sync failed for jadx-mcp-server: ${synced.stderr.trim() || synced.stdout.trim() || "managed environment was not created"}`,
        );
      }
      await writeText(environmentMarker, `${snapshot.commit}\n`);
    }

    const generatedLauncher = await writeManagedLauncher(ctx, {
      launcherPath: plannedLauncher,
      executable: guiLauncher,
      env: hostEnv,
    });

    return {
      servers: {
        jadx: {
          type: "stdio",
          command: environmentPython,
          args: [path.join(snapshot.repoDir, "jadx_mcp_server.py")],
          env: serverEnv,
        },
      },
      placedFiles: [
        path.join(snapshot.repoDir, "jadx_mcp_server.py"),
        environmentPython,
        generatedLauncher,
        pluginFile,
      ],
      notes: [
        `jadx-mcp-server snapshot: ${snapshot.commit}`,
        `Launch JADX through ${generatedLauncher} so the managed plugin config and JDK are used.`,
      ],
    };
  },

  postInstallNotes: [
    "Launch JADX through the generated jadx-gui-managed launcher, then load an APK/DEX/JAR.",
    `The managed jadx-ai-mcp plugin serves decompiler context on 127.0.0.1:${PLUGIN_PORT}.`,
    "The bridge is synced from a GitHub main-branch commit snapshot into an isolated Python 3.13 environment.",
  ],

  async verify(ctx: InstallContext): Promise<boolean> {
    const layout = managedLayout(ctx.toolsDir);
    const cli = await findLauncherIn(
      path.join(layout.tools, "jadx"),
      jadxLauncherName(ctx.platform),
      3,
    );
    const plugin = await findMatchingFile(
      path.join(layout.servers, "jadx-host", "config"),
      /jadx-ai-mcp.*\.jar$/i,
    );
    return Boolean(
      cli &&
        plugin &&
        (await exists(
          path.join(layout.tools, "jadx", ".remcp-complete"),
        )) &&
        (await exists(
          path.join(
            layout.servers,
            "jadx-mcp-server",
            "current",
            "jadx_mcp_server.py",
          ),
        )) &&
        (await exists(
          path.join(
            layout.servers,
            "jadx-mcp-server",
            "current",
            ".remcp-complete",
          ),
        )) &&
        (await exists(
          venvPythonPath(
            path.join(layout.envs, "jadx-mcp"),
            ctx.platform,
          ),
        )) &&
        (await exists(
          path.join(layout.envs, "jadx-mcp", ".remcp-complete"),
        )) &&
        (await exists(managedJadxLauncher(ctx))),
    );
  },
};
