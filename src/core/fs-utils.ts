import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export function existsSync(p: string): boolean {
  return fs.existsSync(p);
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface RenameRetryOptions {
  /** Total rename attempts, including the first. */
  attempts?: number;
  /** Initial retry delay. */
  baseDelayMs?: number;
  /** Maximum delay between attempts. */
  maxDelayMs?: number;
}

const RETRYABLE_RENAME_CODES = new Set([
  "EACCES",
  "EBUSY",
  "ENOTEMPTY",
  "EPERM",
]);

/**
 * Rename with bounded backoff for transient Windows file locks. Antivirus and
 * executable-image cleanup can briefly keep a freshly validated runtime tree
 * open even after the child process has exited.
 */
export async function renameWithRetry(
  source: string,
  destination: string,
  opts: RenameRetryOptions = {},
): Promise<void> {
  const attempts = Math.max(1, opts.attempts ?? 10);
  const baseDelayMs = Math.max(1, opts.baseDelayMs ?? 150);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? 1_500);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fsp.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (
        attempt + 1 >= attempts ||
        !RETRYABLE_RENAME_CODES.has(code)
      ) {
        throw error;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Read a JSON file, tolerating BOM and comments-free JSONC-ish trailing commas. */
export async function readJsonSafe<T = unknown>(
  file: string,
): Promise<T | undefined> {
  if (!(await exists(file))) return undefined;
  const raw = await fsp.readFile(file, "utf8");
  const stripped = raw.replace(/^﻿/, "").trim();
  if (!stripped) return undefined;
  try {
    return JSON.parse(stripped) as T;
  } catch {
    // Tolerate trailing commas, a common hand-edit artifact in these configs.
    const noTrailing = stripped.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(noTrailing) as T;
  }
}

/**
 * Atomically write JSON with a timestamped backup of any prior content.
 * Returns the backup path (if a prior file existed). Never mutates on dryRun.
 */
export async function writeJsonWithBackup(
  file: string,
  data: unknown,
  opts: { dryRun?: boolean; backupStamp?: string } = {},
): Promise<{ backupPath?: string }> {
  const json = JSON.stringify(data, null, 2) + "\n";
  if (opts.dryRun) return {};

  await ensureDir(path.dirname(file));

  let backupPath: string | undefined;
  if (await exists(file)) {
    const stamp = opts.backupStamp ?? "backup";
    backupPath = `${file}.${stamp}.bak`;
    await fsp.copyFile(file, backupPath);
  }

  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, json, "utf8");
  await fsp.rename(tmp, file);
  return { backupPath };
}

export async function copyFile(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
}

export async function readText(file: string): Promise<string> {
  return fsp.readFile(file, "utf8");
}

export async function writeText(file: string, text: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, text, "utf8");
}
