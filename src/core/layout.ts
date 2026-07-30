import path from "node:path";
import fsp from "node:fs/promises";
import { toolsDir } from "./platform.js";

/**
 * Stable, per-user managed layout. Download/cache directories are deliberately
 * separate from executable/runtime directories so a cache clean cannot break
 * MCP client configurations that point at managed binaries.
 */
export interface ManagedLayout {
  root: string;
  downloads: string;
  staging: string;
  locks: string;
  runtimes: string;
  tools: string;
  servers: string;
  envs: string;
  cache: string;
  npmCache: string;
  uvCache: string;
  pipCache: string;
  state: string;
  bin: string;
  python: string;
  jdk21: string;
  node22: string;
  uv: string;
}

/** Resolve every managed path from one absolute root. Does not touch disk. */
export function managedLayout(root = toolsDir()): ManagedLayout {
  const resolvedRoot = path.resolve(root);
  const cache = path.join(resolvedRoot, "cache");
  const runtimes = path.join(resolvedRoot, "runtimes");
  const tools = path.join(resolvedRoot, "tools");

  return {
    root: resolvedRoot,
    downloads: path.join(resolvedRoot, "downloads"),
    staging: path.join(resolvedRoot, "staging"),
    locks: path.join(resolvedRoot, "locks"),
    runtimes,
    tools,
    servers: path.join(resolvedRoot, "servers"),
    envs: path.join(resolvedRoot, "envs"),
    cache,
    npmCache: path.join(cache, "npm"),
    uvCache: path.join(cache, "uv"),
    pipCache: path.join(cache, "pip"),
    state: path.join(resolvedRoot, "state"),
    bin: path.join(resolvedRoot, "bin"),
    python: path.join(runtimes, "python"),
    jdk21: path.join(runtimes, "jdk-21"),
    node22: path.join(runtimes, "node-22"),
    uv: path.join(tools, "uv"),
  };
}

/**
 * Environment shared by managed installers and emitted MCP server processes.
 * These settings keep uv/npm/pip downloads and uv-managed Python installations
 * inside the same discoverable root and prevent uv from editing the user's PATH.
 */
export function managedEnv(root = toolsDir()): Record<string, string> {
  const layout = managedLayout(root);
  return {
    REMCP_TOOLS_DIR: layout.root,
    UV_CACHE_DIR: layout.uvCache,
    UV_PYTHON_INSTALL_DIR: layout.python,
    UV_PYTHON_BIN_DIR: layout.bin,
    UV_TOOL_DIR: path.join(layout.tools, "uv-tools"),
    UV_TOOL_BIN_DIR: layout.bin,
    UV_NO_MODIFY_PATH: "1",
    UV_PYTHON_INSTALL_REGISTRY: "0",
    NPM_CONFIG_CACHE: layout.npmCache,
    npm_config_cache: layout.npmCache,
    PIP_CACHE_DIR: layout.pipCache,
    XDG_CACHE_HOME: layout.cache,
    TMP: layout.staging,
    TEMP: layout.staging,
    TMPDIR: layout.staging,
  };
}

/** Create the shared directory skeleton. Never call this during a dry run. */
export async function ensureManagedLayout(root = toolsDir()): Promise<ManagedLayout> {
  const layout = managedLayout(root);
  await Promise.all(
    [
      layout.downloads,
      layout.staging,
      layout.locks,
      layout.runtimes,
      layout.tools,
      layout.servers,
      layout.envs,
      layout.cache,
      layout.npmCache,
      layout.uvCache,
      layout.pipCache,
      layout.state,
      layout.bin,
    ].map((dir) => fsp.mkdir(dir, { recursive: true })),
  );
  return layout;
}
