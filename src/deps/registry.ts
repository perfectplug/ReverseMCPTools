import path from "node:path";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  Arch,
  DependencySpec,
  DepStatus,
  InstallContext,
  Platform,
} from "../core/types.js";
import { downloadFile, extractArchive } from "../core/download.js";
import {
  ensureDir,
  exists,
  readText,
  writeText,
} from "../core/fs-utils.js";
import { managedEnv, managedLayout } from "../core/layout.js";

const UV_VERSION = "0.12.0";
const NODE_VERSION = "22.23.2";
const PYTHON_VERSION = "3.13";
const JDK_MARKER_PREFIX = "temurin-jdk-21\n";
const UV_MARKER = `uv@${UV_VERSION}\n`;
const PYTHON_MARKER_PREFIX = `python@${PYTHON_VERSION}\n`;
const NODE_MARKER = `node@${NODE_VERSION}\n`;

function completionMarker(root: string): string {
  return path.join(root, ".remcp-complete");
}

async function markerMatches(
  root: string,
  expected: string,
  prefix = false,
): Promise<boolean> {
  const value = await fsp
    .readFile(completionMarker(root), "utf8")
    .catch(() => "");
  const normalizedValue = value.replace(/\r\n/g, "\n");
  const normalizedExpected = expected.replace(/\r\n/g, "\n");
  return prefix
    ? normalizedValue.trimEnd() === normalizedExpected.trimEnd() ||
        normalizedValue.startsWith(normalizedExpected)
    : normalizedValue.trimEnd() === normalizedExpected.trimEnd();
}

function isManagedChild(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Promote a fully verified staging directory into its stable managed path.
 * The old directory remains recoverable until the new tree is in place.
 */
async function promoteManagedDirectory(
  managedRoot: string,
  stagingDir: string,
  destination: string,
): Promise<void> {
  if (
    !isManagedChild(managedRoot, stagingDir) ||
    !isManagedChild(managedRoot, destination)
  ) {
    throw new Error(
      `Refusing to promote a runtime outside the shared root: ${destination}`,
    );
  }
  await ensureDir(path.dirname(destination));
  const backup = `${destination}.replace-${process.pid}-${randomUUID()}`;
  const hadDestination = await exists(destination);
  if (hadDestination) await fsp.rename(destination, backup);
  try {
    await fsp.rename(stagingDir, destination);
  } catch (error) {
    if (hadDestination) {
      await fsp.rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }
  if (hadDestination) {
    await fsp.rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function newRuntimeStage(
  ctx: InstallContext,
  label: string,
): Promise<string> {
  const layout = managedLayout(ctx.toolsDir);
  await ensureDir(layout.staging);
  return fsp.mkdtemp(path.join(layout.staging, `${label}-`));
}

function parseVersion(v: string | undefined): number[] {
  const match = v?.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [];
  return [
    Number(match[1]),
    Number(match[2] ?? "0"),
    Number(match[3] ?? "0"),
  ];
}

function atLeast(v: string | undefined, wanted: [number, number?, number?]): boolean {
  const actual = parseVersion(v);
  if (actual.length === 0) return false;
  for (let i = 0; i < 3; i += 1) {
    const a = actual[i] ?? 0;
    const b = wanted[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

async function version(
  ctx: InstallContext,
  cmd: string,
  args: string[],
): Promise<string | undefined> {
  const res = await ctx.run(cmd, args, { allowFailure: true });
  const out = `${res.stdout}\n${res.stderr}`.trim();
  if (!out) return undefined;
  return out.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
}

async function findFiles(
  root: string,
  names: Set<string>,
  depth = 7,
): Promise<string[]> {
  if (depth < 0 || !(await exists(root))) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && names.has(entry.name.toLowerCase())) {
      found.push(full);
    } else if (entry.isDirectory()) {
      found.push(...(await findFiles(full, names, depth - 1)));
    }
  }
  return found;
}

async function firstUsable(
  root: string,
  names: string[],
  prefer: (file: string) => number = () => 0,
): Promise<string | undefined> {
  const files = await findFiles(
    root,
    new Set(names.map((name) => name.toLowerCase())),
  );
  files.sort((a, b) => prefer(b) - prefer(a) || a.localeCompare(b));
  return files[0];
}

function archiveExtension(platform: Platform): ".zip" | ".tar.gz" {
  return platform === "win32" ? ".zip" : ".tar.gz";
}

function adoptiumOs(platform: Platform): string {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "mac";
  return "linux";
}

function adoptiumArch(arch: Arch): string {
  if (arch === "arm64") return "aarch64";
  if (arch === "x86") return "x32";
  return "x64";
}

interface AdoptiumAsset {
  binary?: {
    package?: {
      checksum?: string;
      link?: string;
      name?: string;
    };
  };
  release_name?: string;
}

async function resolveJdkAsset(ctx: InstallContext): Promise<{
  checksum: string;
  link: string;
  name: string;
  release: string;
}> {
  const query = new URLSearchParams({
    architecture: adoptiumArch(ctx.arch),
    heap_size: "normal",
    image_type: "jdk",
    jvm_impl: "hotspot",
    os: adoptiumOs(ctx.platform),
    vendor: "eclipse",
    project: "jdk",
  });
  const url = `https://api.adoptium.net/v3/assets/latest/21/hotspot?${query}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "reverse-mcp-tools",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Adoptium API ${res.status} while resolving JDK 21`);
  }
  const assets = (await res.json()) as AdoptiumAsset[];
  const asset = assets[0];
  const pkg = asset?.binary?.package;
  if (!pkg?.link || !pkg.name || !pkg.checksum) {
    throw new Error(
      `No portable JDK 21 archive is available for ${ctx.platform}/${ctx.arch}`,
    );
  }
  return {
    checksum: pkg.checksum,
    link: pkg.link,
    name: pkg.name,
    release: asset?.release_name ?? "jdk-21",
  };
}

function uvTarget(platform: Platform, arch: Arch): string {
  const cpu =
    arch === "arm64" ? "aarch64" : arch === "x86" ? "i686" : "x86_64";
  if (platform === "win32") return `${cpu}-pc-windows-msvc`;
  if (platform === "darwin") return `${cpu}-apple-darwin`;
  return `${cpu}-unknown-linux-gnu`;
}

function nodeArchive(platform: Platform, arch: Arch): string {
  const cpu = arch === "arm64" ? "arm64" : arch === "x86" ? "x86" : "x64";
  if (platform === "win32") return `node-v${NODE_VERSION}-win-${cpu}.zip`;
  if (platform === "darwin") {
    if (arch === "x86") {
      throw new Error("Node.js 22 does not publish a macOS x86 archive");
    }
    return `node-v${NODE_VERSION}-darwin-${cpu}.tar.gz`;
  }
  if (arch === "x86") {
    throw new Error("Node.js 22 does not publish a Linux x86 archive");
  }
  return `node-v${NODE_VERSION}-linux-${cpu}.tar.gz`;
}

async function detectJdkIn(
  ctx: InstallContext,
  root: string,
): Promise<DepStatus> {
  const java = await firstUsable(
    root,
    ctx.platform === "win32" ? ["java.exe"] : ["java"],
    (file) => (file.includes(`${path.sep}bin${path.sep}`) ? 10 : 0),
  );
  const javac = await firstUsable(
    root,
    ctx.platform === "win32" ? ["javac.exe"] : ["javac"],
    (file) => (file.includes(`${path.sep}bin${path.sep}`) ? 10 : 0),
  );
  if (!java || !javac) {
    return {
      installed: false,
      detail: "Managed JDK 21 is incomplete (java/javac missing).",
    };
  }
  const v = await version(ctx, java, ["-version"]);
  return {
    installed: atLeast(v, [21]),
    version: v,
    path: java,
    detail: atLeast(v, [21])
      ? undefined
      : `Managed Java ${v ?? "unknown"} is not JDK 21+`,
  };
}

async function managedJdk(ctx: InstallContext): Promise<DepStatus> {
  const layout = managedLayout(ctx.toolsDir);
  if (!(await markerMatches(layout.jdk21, JDK_MARKER_PREFIX, true))) {
    return {
      installed: false,
      detail: "Managed JDK 21 is not downloaded or was not fully installed.",
    };
  }
  return detectJdkIn(ctx, layout.jdk21);
}

async function detectUvIn(
  ctx: InstallContext,
  root: string,
): Promise<DepStatus> {
  const uv = await firstUsable(
    root,
    ctx.platform === "win32" ? ["uv.exe"] : ["uv"],
  );
  if (!uv) {
    return { installed: false, detail: "Managed uv executable is missing." };
  }
  const v = await version(ctx, uv, ["--version"]);
  return {
    installed: v === UV_VERSION,
    version: v,
    path: uv,
    detail:
      v === UV_VERSION
        ? undefined
        : `Managed uv ${v ?? "unknown"}; need ${UV_VERSION}`,
  };
}

async function managedUv(ctx: InstallContext): Promise<DepStatus> {
  const layout = managedLayout(ctx.toolsDir);
  if (!(await markerMatches(layout.uv, UV_MARKER))) {
    return {
      installed: false,
      detail: "Managed uv is not downloaded or was not fully installed.",
    };
  }
  return detectUvIn(ctx, layout.uv);
}

async function detectPythonIn(
  ctx: InstallContext,
  root: string,
): Promise<DepStatus> {
  const python = await firstUsable(
    root,
    ctx.platform === "win32"
      ? ["python.exe"]
      : ["python3.13", "python3", "python"],
    (file) => (file.includes(`${path.sep}bin${path.sep}`) ? 10 : 0),
  );
  if (!python) {
    return {
      installed: false,
      detail: "Managed Python 3.13 executable is missing.",
    };
  }
  const v = await version(ctx, python, ["--version"]);
  const pythonParts = parseVersion(v);
  const ok =
    (pythonParts[0] ?? 0) === 3 && (pythonParts[1] ?? 0) === 13;
  return {
    installed: ok,
    version: v,
    path: python,
    detail: ok ? undefined : `Managed Python ${v ?? "unknown"}; need 3.13+`,
  };
}

async function managedPython(ctx: InstallContext): Promise<DepStatus> {
  const layout = managedLayout(ctx.toolsDir);
  if (!(await markerMatches(layout.python, PYTHON_MARKER_PREFIX, true))) {
    return {
      installed: false,
      detail:
        "Managed Python 3.13 is not downloaded or was not fully installed.",
    };
  }
  return detectPythonIn(ctx, layout.python);
}

async function detectNodeIn(
  ctx: InstallContext,
  root: string,
): Promise<DepStatus> {
  const node = await firstUsable(
    root,
    ctx.platform === "win32" ? ["node.exe"] : ["node"],
    (file) => (file.includes(`${path.sep}bin${path.sep}`) ? 10 : 0),
  );
  if (!node) {
    return {
      installed: false,
      detail: "Managed Node.js executable is missing.",
    };
  }
  const npmCli = (
    await findFiles(root, new Set(["npm-cli.js"]), 8)
  ).find((file) =>
    file
      .split(path.sep)
      .map((part) => part.toLowerCase())
      .join("/")
      .includes("npm/bin/npm-cli.js"),
  );
  if (!npmCli) {
    return {
      installed: false,
      path: node,
      detail: "Managed Node.js is incomplete (npm-cli.js missing).",
    };
  }
  const v = await version(ctx, node, ["--version"]);
  const ok = v === NODE_VERSION;
  return {
    installed: ok,
    version: v,
    path: node,
    detail: ok
      ? undefined
      : `Managed Node ${v ?? "unknown"}; need ${NODE_VERSION}`,
  };
}

async function managedNode(ctx: InstallContext): Promise<DepStatus> {
  const layout = managedLayout(ctx.toolsDir);
  if (!(await markerMatches(layout.node22, NODE_MARKER))) {
    return {
      installed: false,
      detail:
        "Managed Node.js 22 is not downloaded or was not fully installed.",
    };
  }
  return detectNodeIn(ctx, layout.node22);
}

const jdk21: DependencySpec = {
  id: "jdk21",
  name: "Managed JDK 21 (Temurin)",
  purpose: "Runs the managed Ghidra and jadx copies",
  detect: managedJdk,
  async install(ctx): Promise<void> {
    const layout = managedLayout(ctx.toolsDir);
    const asset = await resolveJdkAsset(ctx);
    const archive = path.join(layout.downloads, "jdk-21", asset.release, asset.name);
    await ctx.logger.task(`Download Temurin ${asset.release}`, () =>
      downloadFile(asset.link, archive, {
        sha256: asset.checksum,
        retries: 3,
        timeoutMs: 10 * 60_000,
      }),
    );
    const stage = await newRuntimeStage(ctx, "jdk-21");
    try {
      await ctx.logger.task("Extract managed JDK 21", () =>
        extractArchive(archive, stage),
      );
      const staged = await detectJdkIn(ctx, stage);
      if (!staged.installed) {
        throw new Error(
          `JDK archive is incomplete: ${staged.detail ?? "java/javac validation failed"}`,
        );
      }
      await writeText(
        completionMarker(stage),
        `${JDK_MARKER_PREFIX}${asset.release}\n${asset.checksum.toLowerCase()}\n`,
      );
      await promoteManagedDirectory(ctx.toolsDir, stage, layout.jdk21);
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
    const status = await managedJdk(ctx);
    if (!status.installed) {
      throw new Error(
        `JDK archive was promoted but validation failed in ${layout.jdk21}`,
      );
    }
  },
  manualSteps: [
    "Re-run without --no-auto-deps to download a portable Temurin JDK into the shared root.",
    "For an offline pre-populated JDK, add <root>/runtimes/jdk-21/.remcp-complete beginning with: temurin-jdk-21",
  ],
};

const uv: DependencySpec = {
  id: "uv",
  name: `Managed uv ${UV_VERSION}`,
  purpose: "Manages the shared Python runtime and isolated MCP environments",
  detect: managedUv,
  async install(ctx): Promise<void> {
    const layout = managedLayout(ctx.toolsDir);
    const target = uvTarget(ctx.platform, ctx.arch);
    const extension = archiveExtension(ctx.platform);
    const name = `uv-${target}${extension}`;
    const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
    const archive = path.join(layout.downloads, "uv", UV_VERSION, name);
    const checksumFile = `${archive}.sha256`;
    await downloadFile(`${base}/${name}.sha256`, checksumFile, {
      retries: 3,
      timeoutMs: 60_000,
    });
    const checksum = (await readText(checksumFile)).trim().split(/\s+/)[0];
    if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum)) {
      throw new Error(`Invalid uv checksum file: ${checksumFile}`);
    }
    await ctx.logger.task(`Download uv ${UV_VERSION}`, () =>
      downloadFile(`${base}/${name}`, archive, {
        sha256: checksum,
        retries: 3,
        timeoutMs: 5 * 60_000,
      }),
    );
    const stage = await newRuntimeStage(ctx, "uv");
    try {
      await ctx.logger.task("Extract managed uv", () =>
        extractArchive(archive, stage),
      );
      const staged = await detectUvIn(ctx, stage);
      if (!staged.installed) {
        throw new Error(
          `uv archive is incomplete: ${staged.detail ?? "version validation failed"}`,
        );
      }
      await writeText(completionMarker(stage), UV_MARKER);
      await promoteManagedDirectory(ctx.toolsDir, stage, layout.uv);
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
    const status = await managedUv(ctx);
    if (!status.installed) {
      throw new Error(`uv archive extracted but uv was not found in ${layout.uv}`);
    }
  },
  manualSteps: [
    "Re-run without --no-auto-deps to download the portable uv binary into the shared root.",
    `For an offline pre-populated uv tree, write "${UV_MARKER.trim()}" to <root>/tools/uv/.remcp-complete.`,
  ],
};

const python: DependencySpec = {
  id: "python",
  name: `Managed Python ${PYTHON_VERSION}`,
  purpose: "Runs both Python MCP bridges from the shared root",
  detect: managedPython,
  async install(ctx): Promise<void> {
    const layout = managedLayout(ctx.toolsDir);
    const uvPath =
      ctx.depStatus.get("uv")?.path ?? (await managedUv(ctx)).path;
    if (!uvPath) {
      throw new Error("Managed uv must be installed before managed Python.");
    }
    const stage = await newRuntimeStage(ctx, "python");
    const args = [
      "python",
      "install",
      "--install-dir",
      stage,
      "--no-bin",
      ...(ctx.platform === "win32" ? ["--no-registry"] : []),
      PYTHON_VERSION,
    ];
    try {
      const res = await ctx.run(uvPath, args, {
        allowFailure: true,
        env: managedEnv(ctx.toolsDir),
        timeoutMs: 10 * 60_000,
        inherit: true,
      });
      if (!res.ok) {
        throw new Error(`uv python install failed (exit ${res.code})`);
      }
      const staged = await detectPythonIn(ctx, stage);
      if (!staged.installed) {
        throw new Error(
          `Python installation is incomplete: ${staged.detail ?? "version validation failed"}`,
        );
      }
      await writeText(
        completionMarker(stage),
        `${PYTHON_MARKER_PREFIX}${staged.version ?? "unknown"}\n`,
      );
      await promoteManagedDirectory(ctx.toolsDir, stage, layout.python);
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
    const status = await managedPython(ctx);
    if (!status.installed) {
      throw new Error(
        `Python was installed but no 3.13 interpreter was found in ${layout.python}`,
      );
    }
  },
  manualSteps: [
    "Install managed uv first, then run: uv python install --install-dir <root>/runtimes/python --no-bin 3.13",
    `After verifying it, write "${PYTHON_MARKER_PREFIX.trim()}" as the first line of <root>/runtimes/python/.remcp-complete.`,
  ],
};

const node2212: DependencySpec = {
  id: "node2212",
  name: `Managed Node.js ${NODE_VERSION}`,
  purpose: "Runs the pinned jshook and mcp-remote packages",
  detect: managedNode,
  async install(ctx): Promise<void> {
    const layout = managedLayout(ctx.toolsDir);
    const name = nodeArchive(ctx.platform, ctx.arch);
    const base = `https://nodejs.org/download/release/v${NODE_VERSION}`;
    const checksums = path.join(
      layout.downloads,
      "node-22",
      NODE_VERSION,
      "SHASUMS256.txt",
    );
    await downloadFile(`${base}/SHASUMS256.txt`, checksums, {
      retries: 3,
      timeoutMs: 60_000,
    });
    const checksumLine = (await readText(checksums))
      .split(/\r?\n/)
      .find((line) => line.trim().endsWith(`  ${name}`));
    const checksum = checksumLine?.trim().split(/\s+/)[0];
    if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum)) {
      throw new Error(`Could not find ${name} in Node.js SHASUMS256.txt`);
    }
    const archive = path.join(
      layout.downloads,
      "node-22",
      NODE_VERSION,
      name,
    );
    await ctx.logger.task(`Download Node.js ${NODE_VERSION}`, () =>
      downloadFile(`${base}/${name}`, archive, {
        sha256: checksum,
        retries: 3,
        timeoutMs: 10 * 60_000,
      }),
    );
    const stage = await newRuntimeStage(ctx, "node-22");
    try {
      await ctx.logger.task("Extract managed Node.js", () =>
        extractArchive(archive, stage),
      );
      const staged = await detectNodeIn(ctx, stage);
      if (!staged.installed) {
        throw new Error(
          `Node.js archive is incomplete: ${staged.detail ?? "node/npm validation failed"}`,
        );
      }
      await writeText(completionMarker(stage), NODE_MARKER);
      await promoteManagedDirectory(ctx.toolsDir, stage, layout.node22);
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
    const status = await managedNode(ctx);
    if (!status.installed) {
      throw new Error(`Node archive extracted but node was not found in ${layout.node22}`);
    }
  },
  manualSteps: [
    `Download the official Node.js ${NODE_VERSION} archive into <root>/runtimes/node-22.`,
    `After verifying node and npm, write "${NODE_MARKER.trim()}" to <root>/runtimes/node-22/.remcp-complete.`,
  ],
};

export const DEPENDENCIES: Record<string, DependencySpec> = {
  [jdk21.id]: jdk21,
  [uv.id]: uv,
  [python.id]: python,
  [node2212.id]: node2212,
};

export function getDependency(id: string): DependencySpec {
  const dep = DEPENDENCIES[id];
  if (!dep) throw new Error(`Unknown dependency: ${id}`);
  return dep;
}
