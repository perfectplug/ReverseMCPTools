import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renameWithRetry } from "../dist/core/fs-utils.js";

test("renameWithRetry renames a managed directory", async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "remcp-rename-"));
  const source = path.join(scratch, "source");
  const destination = path.join(scratch, "destination");
  try {
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "marker.txt"), "complete");
    await renameWithRetry(source, destination);
    assert.equal(
      await fsp.readFile(path.join(destination, "marker.txt"), "utf8"),
      "complete",
    );
    await assert.rejects(fsp.access(source));
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
});

test(
  "renameWithRetry survives a transient Windows executable lock",
  { skip: process.platform !== "win32" },
  async () => {
    const scratch = await fsp.mkdtemp(
      path.join(os.tmpdir(), "remcp-rename-lock-"),
    );
    const source = path.join(scratch, "source");
    const destination = path.join(scratch, "destination");
    const pingSource = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "PING.EXE",
    );
    const pingCopy = path.join(source, "probe.exe");
    try {
      await fsp.mkdir(source);
      await fsp.copyFile(pingSource, pingCopy);
      const child = spawn(pingCopy, ["-n", "2", "127.0.0.1"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const closed = once(child, "close");
      await once(child, "spawn");

      await renameWithRetry(source, destination, {
        attempts: 20,
        baseDelayMs: 50,
        maxDelayMs: 250,
      });
      await closed;
      assert.equal(
        await fsp.stat(path.join(destination, "probe.exe")).then((s) =>
          s.isFile(),
        ),
        true,
      );
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  },
);
