import fsp from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import extractZipPackage from "extract-zip";
import { x as extractTar } from "tar";
import { ensureDir, exists } from "./fs-utils.js";
import { exec } from "./exec.js";

export interface DownloadOptions {
  /** Download even when a valid destination file is already present. */
  force?: boolean;
  /** Expected SHA-256 digest (hex, optionally prefixed with `sha256:`). */
  sha256?: string;
  /** Number of retries after the initial attempt. Defaults to 2. */
  retries?: number;
  /** Whole-request timeout per attempt. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Base retry delay, primarily useful for deterministic tests. */
  retryDelayMs?: number;
}

class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

function normalizedSha256(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digest = value.trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`Invalid SHA-256 digest: ${value}`);
  }
  return digest;
}

/** Calculate a file's SHA-256 digest without loading it all into memory. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Rename a fully-written sibling file over `dest`. Node normally performs a
 * replacing rename on supported filesystems. The backup fallback handles
 * Windows filesystems that reject a direct replace while preserving the old
 * file if the second rename fails.
 */
async function replaceFile(source: string, dest: string): Promise<void> {
  try {
    await fsp.rename(source, dest);
    return;
  } catch (err) {
    if (
      !["EACCES", "EEXIST", "EPERM"].includes(errorCode(err) ?? "") ||
      !(await isRegularFile(dest))
    ) {
      throw err;
    }
  }

  const backup = `${dest}.replace-${process.pid}-${randomUUID()}`;
  await fsp.rename(dest, backup);
  try {
    await fsp.rename(source, dest);
  } catch (err) {
    await fsp.rename(backup, dest).catch(() => undefined);
    throw err;
  }
  await fsp.rm(backup, { force: true }).catch(() => undefined);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Download a URL to a local file, following redirects (GitHub release assets
 * redirect to a CDN). Uses global fetch (Node 18+). A checksum-valid cached file
 * is reused. Each attempt writes a uniquely named sibling part file and only
 * replaces the destination after the stream and optional checksum have passed.
 */
export async function downloadFile(
  url: string,
  dest: string,
  opts: DownloadOptions = {},
): Promise<string> {
  const expectedSha256 = normalizedSha256(opts.sha256);
  const resolvedDest = path.resolve(dest);
  const destinationExists = await exists(resolvedDest);
  if (destinationExists && !(await isRegularFile(resolvedDest))) {
    throw new Error(
      `Download destination exists and is not a regular file: ${resolvedDest}`,
    );
  }

  if (!opts.force && destinationExists) {
    if (!expectedSha256 || (await sha256File(resolvedDest)) === expectedSha256) {
      return resolvedDest;
    }
  }

  await ensureDir(path.dirname(resolvedDest));
  const retries = Math.max(0, opts.retries ?? 2);
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 10 * 60 * 1000);
  const retryDelayMs = Math.max(0, opts.retryDelayMs ?? 500);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const part = `${resolvedDest}.part-${process.pid}-${randomUUID()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new Error(`Download timed out after ${timeoutMs}ms: ${url}`),
      );
    }, timeoutMs);

    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "reverse-mcp-tools",
          ...opts.headers,
        },
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new HttpStatusError(
          `Download failed (${res.status} ${res.statusText}) for ${url}`,
          retryableStatus(res.status),
        );
      }

      const hash = createHash("sha256");
      const hashingStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as import("stream/web").ReadableStream),
        hashingStream,
        createWriteStream(part, { flags: "wx" }),
      );

      const actualSha256 = hash.digest("hex");
      if (expectedSha256 && actualSha256 !== expectedSha256) {
        throw new Error(
          `SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actualSha256}`,
        );
      }

      await replaceFile(part, resolvedDest);
      return resolvedDest;
    } catch (err) {
      lastError = err;
      if (
        attempt >= retries ||
        (err instanceof HttpStatusError && !err.retryable)
      ) {
        throw err;
      }
    } finally {
      clearTimeout(timer);
      await fsp.rm(part, { force: true }).catch(() => undefined);
    }

    const backoff = retryDelayMs * 2 ** attempt;
    if (backoff > 0) await delay(Math.min(backoff, 5_000));
  }

  // The loop always returns or throws, but retain a defensive error for future
  // changes to retry accounting.
  throw lastError instanceof Error
    ? lastError
    : new Error(`Download failed for ${url}`);
}

export type ArchiveFormat = "zip" | "tar.gz" | "tgz" | "tar.xz";

function inferArchiveFormat(archivePath: string): ArchiveFormat | undefined {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".tar.gz")) return "tar.gz";
  if (lower.endsWith(".tar.xz")) return "tar.xz";
  if (lower.endsWith(".tgz")) return "tgz";
  if (lower.endsWith(".zip")) return "zip";
  return undefined;
}

function validateArchiveEntry(entryName: string): void {
  const normalized = entryName.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    parts.includes("..")
  ) {
    throw new Error(`Unsafe archive entry path: ${entryName}`);
  }
}

/**
 * Extract a supported archive into `destDir`. ZIP and gzip-compressed tar
 * archives use bundled JavaScript implementations, so installation does not
 * depend on a system unzip/tar utility. Legacy tar.xz input retains a clearly
 * reported system-tar fallback.
 */
export async function extractArchive(
  archivePath: string,
  destDir: string,
  opts: { format?: ArchiveFormat } = {},
): Promise<void> {
  const source = path.resolve(archivePath);
  const destination = path.resolve(destDir);
  const format = opts.format ?? inferArchiveFormat(source);
  if (!format) {
    throw new Error(
      `Unsupported archive format for ${archivePath}; expected .zip, .tar.gz, .tgz or .tar.xz`,
    );
  }
  if (!(await isRegularFile(source))) {
    throw new Error(`Archive does not exist or is not a file: ${source}`);
  }
  await ensureDir(destination);

  if (format === "zip") {
    await extractZipPackage(source, {
      dir: destination,
      onEntry: (entry) => validateArchiveEntry(entry.fileName),
    });
    return;
  }

  if (format === "tar.gz" || format === "tgz") {
    await extractTar({
      cwd: destination,
      file: source,
      preservePaths: false,
      strict: true,
      filter: (entryPath) => {
        validateArchiveEntry(entryPath);
        return true;
      },
    });
    return;
  }

  const tarAttempt = await exec("tar", ["-xJf", source, "-C", destination], {
    allowFailure: true,
  });
  if (!tarAttempt.ok) {
    const detail = tarAttempt.stderr.trim() || tarAttempt.stdout.trim();
    throw new Error(
      `Failed to extract ${source}: tar with xz support is required${detail ? ` (${detail})` : ""}`,
    );
  }
}

/** Backward-compatible zip-only wrapper used by existing recipes. */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  return extractArchive(zipPath, destDir, { format: "zip" });
}

/**
 * Resolve the browser_download_url of a GitHub release asset matching `pattern`.
 * `repo` is "owner/name"; `tag` defaults to "latest".
 */
export async function githubReleaseAsset(
  repo: string,
  pattern: RegExp,
  tag = "latest",
): Promise<{ url: string; name: string; tag: string; sha256?: string }> {
  const api =
    tag === "latest"
      ? `https://api.github.com/repos/${repo}/releases/latest`
      : `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const res = await fetch(api, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "reverse-mcp-tools",
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${repo} (${tag})`);
  }
  const data = (await res.json()) as {
    tag_name: string;
    assets: {
      name: string;
      browser_download_url: string;
      digest?: string | null;
    }[];
  };
  const asset = data.assets.find((a) => {
    pattern.lastIndex = 0;
    return pattern.test(a.name);
  });
  if (!asset) {
    const names = data.assets.map((a) => a.name).join(", ");
    throw new Error(
      `No asset matching ${pattern} in ${repo}@${data.tag_name}. Assets: ${names}`,
    );
  }
  const digest = asset.digest?.match(/^sha256:([a-f0-9]{64})$/i)?.[1];
  return {
    url: asset.browser_download_url,
    name: asset.name,
    tag: data.tag_name,
    ...(digest ? { sha256: digest.toLowerCase() } : {}),
  };
}
