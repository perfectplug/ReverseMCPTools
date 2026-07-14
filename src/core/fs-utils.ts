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
