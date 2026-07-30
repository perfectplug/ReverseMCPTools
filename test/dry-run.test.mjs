import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runInstall } from "../dist/engine.js";
import { RECIPES } from "../dist/recipes/registry.js";

const silentLogger = {
  info() {},
  success() {},
  warn() {},
  error() {},
  step() {},
  detail() {},
  async task(_label, fn) {
    return fn();
  },
};

test("all-recipe dry run emits only managed absolute commands and creates nothing", async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "remcp-dry-run-"));
  const root = path.join(scratch, "shared managed root");
  try {
    const ctx = {
      platform: "win32",
      arch: "x64",
      toolsDir: root,
      home: path.join(scratch, "home"),
      logger: silentLogger,
      dryRun: true,
      autoInstallDeps: true,
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "",
        ok: false,
      }),
      depStatus: new Map(),
    };

    const report = await runInstall(ctx, RECIPES, []);
    assert.equal(report.recipes.length, RECIPES.length);
    assert.equal(report.recipes.every((outcome) => outcome.ok), true);

    for (const outcome of report.recipes) {
      for (const server of Object.values(outcome.servers)) {
        if (!("command" in server)) continue;
        assert.equal(path.isAbsolute(server.command), true);
        const relative = path.relative(root, server.command);
        assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false);
      }
    }

    await assert.rejects(fsp.access(root));
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
});
