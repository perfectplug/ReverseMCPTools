import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { downloadFile } from "../dist/core/download.js";

const PAYLOAD = Buffer.from(
  "ReverseMCPTools deterministic local download fixture\n",
  "utf8",
);
const PAYLOAD_SHA256 = createHash("sha256").update(PAYLOAD).digest("hex");

async function makeTempDir(t, label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function startServer(t) {
  const counts = new Map();
  let flakyFailuresRemaining = 1;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);

    if (url.pathname === "/asset") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": PAYLOAD.length,
      });
      res.end(PAYLOAD);
      return;
    }

    if (url.pathname === "/flaky") {
      if (flakyFailuresRemaining > 0) {
        flakyFailuresRemaining -= 1;
        res.writeHead(503);
        res.end("try again");
        return;
      }
      res.writeHead(200, { "Content-Length": PAYLOAD.length });
      res.end(PAYLOAD);
      return;
    }

    if (url.pathname === "/fail") {
      res.writeHead(503);
      res.end("unavailable");
      return;
    }

    if (url.pathname === "/abort") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": PAYLOAD.length * 4,
      });
      res.write(PAYLOAD.subarray(0, 12));
      setImmediate(() => res.destroy());
      return;
    }

    if (url.pathname === "/slow") {
      const timer = setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "Content-Length": PAYLOAD.length });
        res.end(PAYLOAD);
      }, 500);
      res.on("close", () => clearTimeout(timer));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  );

  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    count(pathname) {
      return counts.get(pathname) ?? 0;
    },
  };
}

async function assertNoDownloadTemps(dest) {
  const names = await fs.readdir(path.dirname(dest)).catch(() => []);
  const base = path.basename(dest);
  const leftovers = names.filter(
    (name) =>
      name.startsWith(base) &&
      /(?:\.download|\.part|\.tmp)(?:[-.]|$)/i.test(name),
  );
  assert.deepEqual(leftovers, [], `temporary files remain: ${leftovers.join(", ")}`);
}

test("downloadFile downloads locally, verifies SHA-256, and reuses a valid cache", async (t) => {
  const dir = await makeTempDir(t, "remcp-download");
  const server = await startServer(t);
  const dest = path.join(dir, "nested", "asset.bin");
  const url = `${server.baseUrl}/asset`;

  const first = await downloadFile(url, dest, {
    sha256: PAYLOAD_SHA256,
    retries: 0,
    timeoutMs: 2_000,
  });

  assert.equal(first, dest);
  assert.deepEqual(await fs.readFile(dest), PAYLOAD);
  assert.equal(server.count("/asset"), 1);
  await assertNoDownloadTemps(dest);

  const second = await downloadFile(url, dest, {
    sha256: PAYLOAD_SHA256,
    retries: 0,
    timeoutMs: 2_000,
  });

  assert.equal(second, dest);
  assert.equal(server.count("/asset"), 1, "valid cache should avoid the network");
  assert.deepEqual(await fs.readFile(dest), PAYLOAD);
  await assertNoDownloadTemps(dest);
});

test("downloadFile replaces a corrupt cached file when SHA-256 is provided", async (t) => {
  const dir = await makeTempDir(t, "remcp-corrupt-cache");
  const server = await startServer(t);
  const dest = path.join(dir, "asset.bin");
  const url = `${server.baseUrl}/asset`;

  await fs.writeFile(dest, "corrupt cache");
  await downloadFile(url, dest, {
    sha256: PAYLOAD_SHA256,
    retries: 0,
    timeoutMs: 2_000,
  });

  assert.equal(server.count("/asset"), 1);
  assert.deepEqual(await fs.readFile(dest), PAYLOAD);
  await assertNoDownloadTemps(dest);
});

test("downloadFile rejects a SHA-256 mismatch and never publishes the bad body", async (t) => {
  const dir = await makeTempDir(t, "remcp-bad-sha");
  const server = await startServer(t);
  const dest = path.join(dir, "asset.bin");
  const wrongSha = "0".repeat(64);

  await assert.rejects(
    downloadFile(`${server.baseUrl}/asset`, dest, {
      sha256: wrongSha,
      retries: 0,
      timeoutMs: 2_000,
    }),
    /(?:sha-?256|checksum|hash|integrity)/i,
  );

  await assert.rejects(fs.access(dest));
  await assertNoDownloadTemps(dest);
});

test("downloadFile retries a transient HTTP failure", async (t) => {
  const dir = await makeTempDir(t, "remcp-retry");
  const server = await startServer(t);
  const dest = path.join(dir, "asset.bin");

  await downloadFile(`${server.baseUrl}/flaky`, dest, {
    sha256: PAYLOAD_SHA256,
    retries: 1,
    timeoutMs: 2_000,
    retryDelayMs: 0,
  });

  assert.equal(server.count("/flaky"), 2);
  assert.deepEqual(await fs.readFile(dest), PAYLOAD);
  await assertNoDownloadTemps(dest);
});

test("downloadFile cleans partial files after a stream failure", async (t) => {
  const dir = await makeTempDir(t, "remcp-aborted-download");
  const server = await startServer(t);
  const dest = path.join(dir, "asset.bin");

  await assert.rejects(
    downloadFile(`${server.baseUrl}/abort`, dest, {
      retries: 0,
      timeoutMs: 2_000,
    }),
  );

  await assert.rejects(fs.access(dest));
  await assertNoDownloadTemps(dest);
});

test("downloadFile cleans partial files after final HTTP failure and timeout", async (t) => {
  const dir = await makeTempDir(t, "remcp-failed-download");
  const server = await startServer(t);
  const failedDest = path.join(dir, "failed.bin");
  const timeoutDest = path.join(dir, "timeout.bin");

  await assert.rejects(
    downloadFile(`${server.baseUrl}/fail`, failedDest, {
      retries: 1,
      timeoutMs: 2_000,
      retryDelayMs: 0,
    }),
  );
  assert.equal(server.count("/fail"), 2);
  await assert.rejects(fs.access(failedDest));
  await assertNoDownloadTemps(failedDest);

  await assert.rejects(
    downloadFile(`${server.baseUrl}/slow`, timeoutDest, {
      retries: 0,
      timeoutMs: 50,
    }),
    /(?:abort|timeout|timed out)/i,
  );
  await assert.rejects(fs.access(timeoutDest));
  await assertNoDownloadTemps(timeoutDest);
});
