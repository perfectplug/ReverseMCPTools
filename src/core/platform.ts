import os from "node:os";
import path from "node:path";
import type { Arch, Platform } from "./types.js";

export function currentPlatform(): Platform {
  const p = process.platform;
  if (p === "win32" || p === "darwin" || p === "linux") return p;
  throw new Error(`Unsupported platform: ${p}`);
}

export function currentArch(): Arch {
  const a = process.arch;
  if (a === "x64") return "x64";
  if (a === "ia32") return "x86";
  if (a === "arm64") return "arm64";
  // Treat anything else as x64 for tooling purposes; RE tools are x64/x86 centric.
  return "x64";
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

/** Managed directory where we download tools, plugins and bridges. */
export function toolsDir(): string {
  if (isWindows()) {
    const base =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "ReverseMCPTools");
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, "reverse-mcp-tools");
  return path.join(os.homedir(), ".reverse-mcp-tools");
}
