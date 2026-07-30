import fsp from "node:fs/promises";
import path from "node:path";
import type { InstallContext, Platform } from "./types.js";
import { downloadFile, extractArchive } from "./download.js";
import { ensureDir, exists, readJsonSafe, writeText } from "./fs-utils.js";
import { managedEnv, managedLayout } from "./layout.js";

export function requireDependencyPath(
  ctx: InstallContext,
  id: string,
): string {
  const resolved = ctx.depStatus.get(id)?.path;
  if (!resolved || !path.isAbsolute(resolved)) {
    throw new Error(
      `Managed dependency "${id}" has no absolute executable path. Re-run with dependency auto-install enabled.`,
    );
  }
  const relative = path.relative(
    path.resolve(ctx.toolsDir),
    path.resolve(resolved),
  );
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Managed dependency "${id}" resolved outside the shared root: ${resolved}`,
    );
  }
  return resolved;
}

export function executableHome(executable: string): string {
  return path.dirname(path.dirname(executable));
}

export function venvPythonPath(
  venvDir: string,
  platform: Platform,
): string {
  return platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

export function uvManagedEnv(
  root: string,
  pythonPath: string,
  projectEnvironment?: string,
): Record<string, string> {
  const layout = managedLayout(root);
  return {
    ...managedEnv(root),
    UV_CACHE_DIR: layout.uvCache,
    UV_PYTHON_INSTALL_DIR: layout.python,
    UV_TOOL_DIR: path.join(layout.tools, "uv-tools"),
    UV_TOOL_BIN_DIR: layout.bin,
    UV_PYTHON: pythonPath,
    UV_NO_MANAGED_PYTHON: "1",
    UV_NO_MODIFY_PATH: "1",
    ...(projectEnvironment
      ? { UV_PROJECT_ENVIRONMENT: projectEnvironment }
      : {}),
  };
}

export async function assertPythonAtLeast(
  ctx: InstallContext,
  pythonPath: string,
  major: number,
  minor: number,
): Promise<void> {
  const res = await ctx.run(pythonPath, ["--version"], {
    allowFailure: true,
  });
  const match = `${res.stdout}\n${res.stderr}`.match(
    /Python\s+(\d+)\.(\d+)(?:\.\d+)?/i,
  );
  const foundMajor = Number(match?.[1] ?? -1);
  const foundMinor = Number(match?.[2] ?? -1);
  if (
    !res.ok ||
    foundMajor < major ||
    (foundMajor === major && foundMinor < minor)
  ) {
    throw new Error(
      `Python ${major}.${minor}+ is required, but managed interpreter ${pythonPath} reported ${match?.[0] ?? "an unknown version"}.`,
    );
  }
}

export async function ensurePythonVenv(
  ctx: InstallContext,
  opts: {
    uvPath: string;
    pythonPath: string;
    venvDir: string;
    packages: string[];
    env?: Record<string, string>;
  },
): Promise<string> {
  const python = venvPythonPath(opts.venvDir, ctx.platform);
  const env = {
    ...uvManagedEnv(ctx.toolsDir, opts.pythonPath, opts.venvDir),
    ...opts.env,
  };
  const completionMarker = path.join(opts.venvDir, ".remcp-complete");
  const expectedMarker = `${opts.packages.join("\n")}\n`;

  await ensureDir(path.dirname(opts.venvDir));
  const completed = await fsp
    .readFile(completionMarker, "utf8")
    .then((value) => value === expectedMarker)
    .catch(() => false);
  if ((await exists(python)) && completed) return python;

  if (!(await exists(python))) {
    const created = await ctx.run(
      opts.uvPath,
      [
        "venv",
        opts.venvDir,
        "--python",
        opts.pythonPath,
        "--allow-existing",
      ],
      { allowFailure: true, env, timeoutMs: 300_000 },
    );
    if (!created.ok || !(await exists(python))) {
      throw new Error(
        `Could not create managed Python environment at ${opts.venvDir}: ${created.stderr.trim() || created.stdout.trim() || "uv venv failed"}`,
      );
    }
  }

  const installed = await ctx.run(
    opts.uvPath,
    ["pip", "install", "--python", python, ...opts.packages],
    { allowFailure: true, env, timeoutMs: 300_000 },
  );
  if (!installed.ok) {
    throw new Error(
      `Could not install managed Python packages (${opts.packages.join(", ")}): ${installed.stderr.trim() || installed.stdout.trim() || "uv pip install failed"}`,
    );
  }
  await writeText(completionMarker, expectedMarker);
  return python;
}

async function findNpmCli(nodePath: string): Promise<string | undefined> {
  let cursor = path.dirname(nodePath);
  for (let depth = 0; depth < 5; depth += 1) {
    const candidates = [
      path.join(cursor, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(cursor, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
    for (const candidate of candidates) {
      if (await exists(candidate)) return candidate;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

export async function ensureManagedNpmPackage(
  ctx: InstallContext,
  opts: {
    nodePath: string;
    packageName: string;
    version: string;
    installDir: string;
    entryRelativePath: string;
  },
): Promise<{ entryPath: string; packageJsonPath: string }> {
  const layout = managedLayout(ctx.toolsDir);
  const relativeInstall = path.relative(
    path.resolve(layout.servers),
    path.resolve(opts.installDir),
  );
  if (relativeInstall.startsWith("..") || path.isAbsolute(relativeInstall)) {
    throw new Error(
      `Managed npm package destination is outside ${layout.servers}: ${opts.installDir}`,
    );
  }
  const packageDir = path.join(
    opts.installDir,
    "node_modules",
    ...opts.packageName.split("/"),
  );
  const packageJsonPath = path.join(packageDir, "package.json");
  const entryPath = path.join(packageDir, opts.entryRelativePath);
  const completionMarker = path.join(opts.installDir, ".remcp-complete");
  const installed = await readJsonSafe<{ version?: string }>(packageJsonPath);
  if (
    installed?.version === opts.version &&
    (await exists(entryPath)) &&
    (await exists(completionMarker))
  ) {
    return { entryPath, packageJsonPath };
  }

  const npmCli = await findNpmCli(opts.nodePath);
  if (!npmCli) {
    throw new Error(
      `Managed Node.js at ${opts.nodePath} does not include node_modules/npm/bin/npm-cli.js.`,
    );
  }

  const npmCache = path.join(layout.cache, "npm");
  await ensureDir(opts.installDir);
  await ensureDir(npmCache);
  await fsp.rm(completionMarker, { force: true });
  const env = {
    ...managedEnv(ctx.toolsDir),
    PATH: [
      path.dirname(opts.nodePath),
      layout.bin,
      process.env.PATH ?? "",
    ]
      .filter(Boolean)
      .join(path.delimiter),
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_prefix: opts.installDir,
    NPM_CONFIG_PREFIX: opts.installDir,
  };
  const spec = `${opts.packageName}@${opts.version}`;
  const result = await ctx.run(
    opts.nodePath,
    [
      npmCli,
      "install",
      "--prefix",
      opts.installDir,
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--save-exact",
      spec,
    ],
    {
      allowFailure: true,
      cwd: opts.installDir,
      env,
      timeoutMs: 600_000,
    },
  );
  if (!result.ok || !(await exists(entryPath))) {
    throw new Error(
      `Could not install ${spec} into ${opts.installDir}: ${result.stderr.trim() || result.stdout.trim() || "npm install failed"}`,
    );
  }
  await writeText(
    completionMarker,
    `${opts.packageName}@${opts.version}\n`,
  );
  return { entryPath, packageJsonPath };
}

async function findFileRoot(
  dir: string,
  marker: string,
  depth = 3,
): Promise<string | undefined> {
  if (await exists(path.join(dir, marker))) return dir;
  if (depth <= 0) return undefined;
  const entries = await fsp
    .readdir(dir, { withFileTypes: true })
    .catch(() => [] as import("node:fs").Dirent[]);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFileRoot(
      path.join(dir, entry.name),
      marker,
      depth - 1,
    );
    if (found) return found;
  }
  return undefined;
}

/**
 * Resolve a branch head, download its immutable GitHub archive and expose it at
 * a stable managed `current/` path. This intentionally avoids a Git runtime.
 */
export async function ensureGitHubSnapshot(
  ctx: InstallContext,
  opts: {
    repo: string;
    branch?: string;
    destination: string;
    marker: string;
    refresh?: boolean;
  },
): Promise<{ repoDir: string; archivePath: string; commit: string }> {
  const branch = opts.branch ?? "main";
  const layout = managedLayout(ctx.toolsDir);
  const resolvedDestination = path.resolve(opts.destination);
  const relativeDestination = path.relative(
    path.resolve(layout.servers),
    resolvedDestination,
  );
  if (
    relativeDestination.startsWith("..") ||
    path.isAbsolute(relativeDestination)
  ) {
    throw new Error(
      `Managed GitHub snapshot destination is outside ${layout.servers}: ${opts.destination}`,
    );
  }

  const repoSlug = opts.repo.replace("/", "-");
  const repoDir = path.join(resolvedDestination, "current");
  const markerPath = path.join(repoDir, ".remcp-commit");
  const completionMarker = path.join(repoDir, ".remcp-complete");
  const installedCommit = await fsp
    .readFile(markerPath, "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  if (
    !opts.refresh &&
    /^[a-f0-9]{40}$/i.test(installedCommit) &&
    (await exists(path.join(repoDir, opts.marker))) &&
    (await exists(completionMarker))
  ) {
    return {
      repoDir,
      archivePath: path.join(
        layout.downloads,
        "github",
        `${repoSlug}-${installedCommit}.zip`,
      ),
      commit: installedCommit,
    };
  }

  const api = `https://api.github.com/repos/${opts.repo}/commits/${encodeURIComponent(branch)}`;
  const response = await fetch(api, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "reverse-mcp-tools",
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${response.status} while resolving ${opts.repo}@${branch}`,
    );
  }
  const data = (await response.json()) as { sha?: string };
  if (!data.sha) {
    throw new Error(`GitHub did not return a commit for ${opts.repo}@${branch}`);
  }
  const commit = data.sha;
  const archivePath = path.join(
    layout.downloads,
    "github",
    `${repoSlug}-${commit}.zip`,
  );
  if (
    installedCommit === commit &&
    (await exists(path.join(repoDir, opts.marker))) &&
    (await exists(completionMarker))
  ) {
    return { repoDir, archivePath, commit };
  }

  const archiveUrl = `https://github.com/${opts.repo}/archive/${commit}.zip`;
  await downloadFile(archiveUrl, archivePath);
  const extraction = path.join(resolvedDestination, `.extract-${commit}`);
  await fsp.rm(extraction, { recursive: true, force: true });
  await ensureDir(extraction);
  await extractArchive(archivePath, extraction);
  const extractedRoot = await findFileRoot(extraction, opts.marker);
  if (!extractedRoot) {
    throw new Error(
      `Downloaded ${opts.repo}@${commit} but could not find ${opts.marker} in the archive.`,
    );
  }

  await ensureDir(resolvedDestination);
  if (path.dirname(path.resolve(repoDir)) !== resolvedDestination) {
    throw new Error(`Unsafe managed snapshot destination: ${repoDir}`);
  }
  await fsp.rm(repoDir, { recursive: true, force: true });
  await fsp.rename(extractedRoot, repoDir);
  await writeText(markerPath, `${commit}\n`);
  await writeText(completionMarker, `${opts.repo}@${commit}\n`);
  await fsp.rm(extraction, { recursive: true, force: true });
  return { repoDir, archivePath, commit };
}

export async function writeManagedLauncher(
  ctx: InstallContext,
  opts: {
    launcherPath: string;
    executable: string;
    env: Record<string, string>;
  },
): Promise<string> {
  const entries = Object.entries(opts.env);
  if (ctx.platform === "win32") {
    const callPrefix = /\.(?:bat|cmd)$/i.test(opts.executable)
      ? "call "
      : "";
    const lines = [
      "@echo off",
      "setlocal",
      ...entries.map(
        ([key, value]) => `set "${key}=${value.replace(/%/g, "%%")}"`,
      ),
      `${callPrefix}"${opts.executable}" %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ];
    await writeText(opts.launcherPath, lines.join("\r\n"));
  } else {
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const lines = [
      "#!/bin/sh",
      ...entries.map(([key, value]) => `export ${key}=${quote(value)}`),
      `exec ${quote(opts.executable)} "$@"`,
      "",
    ];
    await writeText(opts.launcherPath, lines.join("\n"));
    await fsp.chmod(opts.launcherPath, 0o755);
  }
  return opts.launcherPath;
}
