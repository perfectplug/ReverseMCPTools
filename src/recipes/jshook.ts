import path from "node:path";
import type {
  InstallContext,
  Recipe,
  RecipeInstallResult,
} from "../core/types.js";
import { ensureDir, exists, readJsonSafe } from "../core/fs-utils.js";
import { managedEnv, managedLayout } from "../core/layout.js";
import {
  ensureManagedNpmPackage,
  requireDependencyPath,
} from "../core/managed-packages.js";

const PACKAGE_NAME = "@jshookmcp/jshook";
const PACKAGE_VERSION = "0.3.4";

function installDir(ctx: InstallContext): string {
  return path.join(managedLayout(ctx.toolsDir).servers, "jshook");
}

function entryPath(ctx: InstallContext): string {
  return path.join(
    installDir(ctx),
    "node_modules",
    "@jshookmcp",
    "jshook",
    "dist",
    "index.mjs",
  );
}

function plannedNodePath(ctx: InstallContext): string {
  const detected = ctx.depStatus.get("node2212")?.path;
  if (detected && path.isAbsolute(detected)) return detected;
  const layout = managedLayout(ctx.toolsDir);
  return path.join(
    layout.node22,
    "<managed-node>",
    ctx.platform === "win32" ? "node.exe" : path.join("bin", "node"),
  );
}

function jshookEnvironment(ctx: InstallContext): Record<string, string> {
  const layout = managedLayout(ctx.toolsDir);
  const cacheRoot = path.join(layout.cache, "jshook");
  const tempRoot = path.join(layout.cache, "tmp", "jshook");
  const ghidraRoot = path.join(
    layout.tools,
    "ghidra",
    "ghidra_11.3.2_PUBLIC",
  );
  const headless = path.join(
    ghidraRoot,
    "support",
    ctx.platform === "win32"
      ? "analyzeHeadless.bat"
      : "analyzeHeadless",
  );
  const adb = path.join(
    layout.tools,
    "android-platform-tools",
    "platform-tools",
    ctx.platform === "win32" ? "adb.exe" : "adb",
  );
  return {
    ...managedEnv(ctx.toolsDir),
    JSHOOK_BASE_PROFILE: "search",
    MCP_TOOL_PROFILE: "search",
    FRIDA_TIMEOUT_MS: "15000",
    CACHE_DIR: path.join(cacheRoot, "cache"),
    MCP_SCREENSHOT_DIR: path.join(cacheRoot, "screenshots"),
    CAPTCHA_SCREENSHOT_DIR: path.join(
      cacheRoot,
      "screenshots",
      "captcha",
    ),
    MCP_DEBUGGER_SESSIONS_DIR: path.join(
      cacheRoot,
      "debugger-sessions",
    ),
    MCP_EXTENSION_REGISTRY_DIR: path.join(
      cacheRoot,
      "extension-registry",
    ),
    MCP_TLS_KEYLOG_DIR: path.join(cacheRoot, "tls-keylogs"),
    MCP_REGISTRY_CACHE_DIR: path.join(cacheRoot, "registry"),
    JSHOOK_EMBEDDING_CACHE_DIR: path.join(cacheRoot, "embeddings"),
    JSHOOK_EMBEDDING_MODEL_CACHE_DIR: path.join(cacheRoot, "models"),
    PUPPETEER_CACHE_DIR: path.join(cacheRoot, "puppeteer"),
    PLAYWRIGHT_BROWSERS_PATH: path.join(cacheRoot, "playwright"),
    CAMOUFOX_CACHE_DIR: path.join(cacheRoot, "camoufox"),
    XDG_CACHE_HOME: cacheRoot,
    npm_config_cache: path.join(layout.cache, "npm"),
    GHIDRA_HOME: ghidraRoot,
    GHIDRA_INSTALL_DIR: ghidraRoot,
    GHIDRA_HEADLESS_PATH: headless,
    ADB_PATH: adb,
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
  };
}

export const jshookRecipe: Recipe = {
  id: "jshook",
  name: "jshook MCP",
  description:
    "Pinned JS reverse-engineering toolkit installed under the shared managed runtime.",
  platforms: ["win32", "darwin", "linux"],
  dependencies: ["node2212"],
  approxDownloadMb: 250,

  async install(ctx: InstallContext): Promise<RecipeInstallResult> {
    const nodePath = plannedNodePath(ctx);
    const entry = entryPath(ctx);
    const target = installDir(ctx);
    const env = jshookEnvironment(ctx);

    if (ctx.dryRun) {
      ctx.logger.detail(
        `(dry-run) would install ${PACKAGE_NAME}@${PACKAGE_VERSION} into ${target} and configure clients to run it with ${nodePath}.`,
      );
      return {
        servers: {
          jshook: {
            command: nodePath,
            args: [entry],
            env,
          },
        },
        placedFiles: [
          entry,
          path.join(
            target,
            "node_modules",
            "@jshookmcp",
            "jshook",
            "package.json",
          ),
        ],
      };
    }

    const managedNode = requireDependencyPath(ctx, "node2212");
    await Promise.all(
      [
        "CACHE_DIR",
        "MCP_SCREENSHOT_DIR",
        "CAPTCHA_SCREENSHOT_DIR",
        "MCP_DEBUGGER_SESSIONS_DIR",
        "MCP_EXTENSION_REGISTRY_DIR",
        "MCP_TLS_KEYLOG_DIR",
        "MCP_REGISTRY_CACHE_DIR",
        "JSHOOK_EMBEDDING_CACHE_DIR",
        "JSHOOK_EMBEDDING_MODEL_CACHE_DIR",
        "PUPPETEER_CACHE_DIR",
        "PLAYWRIGHT_BROWSERS_PATH",
        "CAMOUFOX_CACHE_DIR",
        "TEMP",
      ].map((key) => ensureDir(env[key] ?? target)),
    );
    const installed = await ctx.logger.task(
      `Install ${PACKAGE_NAME}@${PACKAGE_VERSION}`,
      () =>
        ensureManagedNpmPackage(ctx, {
          nodePath: managedNode,
          packageName: PACKAGE_NAME,
          version: PACKAGE_VERSION,
          installDir: target,
          entryRelativePath: path.join("dist", "index.mjs"),
        }),
    );

    return {
      servers: {
        jshook: {
          command: managedNode,
          args: [installed.entryPath],
          env,
        },
      },
      placedFiles: [installed.entryPath, installed.packageJsonPath],
      notes: [
        `Pinned ${PACKAGE_NAME}@${PACKAGE_VERSION}; client startup no longer invokes npx or downloads latest.`,
        "Runtime caches, screenshots, debugger sessions and temporary files are redirected into the shared root.",
      ],
    };
  },

  postInstallNotes: [
    "The default search profile keeps the initial MCP schema compact. Set MCP_TOOL_PROFILE and JSHOOK_BASE_PROFILE to workflow/full only when needed.",
    "Frida, ADB, Ghidra headless, Unidbg and browser engines are optional feature runtimes. jshook resolves managed copies through the generated environment when present.",
    "A matching frida-server must still run on the target device for mobile instrumentation.",
    "jshook is licensed AGPL-3.0; instrument only software you are authorized to test.",
  ],

  async verify(ctx: InstallContext): Promise<boolean> {
    const packageJson = path.join(
      installDir(ctx),
      "node_modules",
      "@jshookmcp",
      "jshook",
      "package.json",
    );
    const manifest = await readJsonSafe<{ version?: string }>(packageJson);
    return (
      manifest?.version === PACKAGE_VERSION &&
      (await exists(entryPath(ctx))) &&
      (await exists(path.join(installDir(ctx), ".remcp-complete")))
    );
  },
};
