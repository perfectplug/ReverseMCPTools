import fsp from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { ensureDir, exists } from "./fs-utils.js";
import { exec } from "./exec.js";

/**
 * Download a URL to a local file, following redirects (GitHub release assets
 * redirect to a CDN). Uses global fetch (Node 18+). Skips if the target already
 * exists and `force` is not set.
 */
export async function downloadFile(
  url: string,
  dest: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  if (!opts.force && (await exists(dest))) return dest;
  await ensureDir(path.dirname(dest));

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}) for ${url}`);
  }

  const tmp = `${dest}.download`;
  await pipeline(
    Readable.fromWeb(res.body as import("stream/web").ReadableStream),
    createWriteStream(tmp),
  );
  await fsp.rename(tmp, dest);
  return dest;
}

/**
 * Extract a .zip archive into `destDir`. Prefers bundled `tar` (present on
 * Windows 10+, macOS and most Linux) which handles zip; falls back to
 * PowerShell Expand-Archive on Windows.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await ensureDir(destDir);

  const tarAttempt = await exec("tar", ["-xf", zipPath, "-C", destDir], {
    allowFailure: true,
  });
  if (tarAttempt.ok) return;

  if (process.platform === "win32") {
    const ps = await exec(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
      { allowFailure: true },
    );
    if (ps.ok) return;
    throw new Error(
      `Failed to extract ${zipPath} (tried tar and Expand-Archive): ${ps.stderr}`,
    );
  }

  const unzip = await exec("unzip", ["-o", zipPath, "-d", destDir], {
    allowFailure: true,
  });
  if (unzip.ok) return;
  throw new Error(`Failed to extract ${zipPath}: no working extractor found`);
}

/**
 * Resolve the browser_download_url of a GitHub release asset matching `pattern`.
 * `repo` is "owner/name"; `tag` defaults to "latest".
 */
export async function githubReleaseAsset(
  repo: string,
  pattern: RegExp,
  tag = "latest",
): Promise<{ url: string; name: string; tag: string }> {
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
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${repo} (${tag})`);
  }
  const data = (await res.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  };
  const asset = data.assets.find((a) => pattern.test(a.name));
  if (!asset) {
    const names = data.assets.map((a) => a.name).join(", ");
    throw new Error(
      `No asset matching ${pattern} in ${repo}@${data.tag_name}. Assets: ${names}`,
    );
  }
  return {
    url: asset.browser_download_url,
    name: asset.name,
    tag: data.tag_name,
  };
}
