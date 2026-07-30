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

/**
 * Managed directory where runtimes, tools, plugins and download caches live.
 * With no override, use one fixed directory under the OS temporary directory.
 *
 * Callers may pass an explicit root (for example from a CLI flag). Environment
 * variables make the same store discoverable by other AI clients/processes
 * without requiring a global PATH mutation.
 */
export function toolsDir(explicit?: string): string {
  const configured =
    explicit?.trim() ||
    process.env.REMCP_TOOLS_DIR?.trim() ||
    process.env.REVERSE_MCP_TOOLS_DIR?.trim();
  if (configured) return path.resolve(configured);

  if (isWindows()) {
    return path.resolve(os.tmpdir(), "ReverseMCPTools");
  }
  const userId =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : os.userInfo().username.replace(/[^a-z0-9_.-]/gi, "_");
  return path.resolve(os.tmpdir(), `reverse-mcp-tools-${userId}`);
}
