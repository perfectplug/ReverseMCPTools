import { spawn } from "node:child_process";
import type { ExecOptions, ExecResult } from "./types.js";

/**
 * Run a command and capture its output. Uses `shell: false` and an argv array
 * so user-controlled paths never go through shell interpolation.
 *
 * On Windows, `.cmd`/`.bat` shims (npx, winget wrappers, etc.) cannot be spawned
 * directly by Node, so callers should invoke those via `cmd /c <shim> ...` or use
 * the `winCmd` helper below.
 */
export async function exec(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: opts.inherit ? "inherit" : "pipe",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    if (!opts.inherit) {
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
    }

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Command timed out after ${opts.timeoutMs}ms: ${cmd}`));
      }, opts.timeoutMs);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (opts.allowFailure) {
        resolve({ code: -1, stdout, stderr: String(err), ok: false });
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const ok = code === 0;
      if (!ok && !opts.allowFailure) {
        const msg = `Command failed (${code}): ${cmd} ${args.join(" ")}\n${stderr || stdout}`;
        reject(new Error(msg));
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr, ok });
    });
  });
}

/**
 * Run a Windows `.cmd`/`.bat` shim (e.g. `npx`, `winget` when needed) via cmd.exe.
 * On non-Windows this just runs the command directly.
 */
export function winCmd(
  shim: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  if (process.platform === "win32") {
    return exec("cmd", ["/c", shim, ...args], opts);
  }
  return exec(shim, args, opts);
}

/** True if a command exists on PATH (best-effort, cross-platform). */
export async function which(cmd: string): Promise<string | undefined> {
  const finder = process.platform === "win32" ? "where" : "which";
  const res = await exec(finder, [cmd], { allowFailure: true });
  if (!res.ok) return undefined;
  const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first || undefined;
}
