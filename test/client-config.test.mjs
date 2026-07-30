import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getClient } from "../dist/clients/registry.js";
import { managedEnv, managedLayout } from "../dist/core/layout.js";

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

test("different AI clients reuse the same managed commands", async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "remcp-clients-"));
  try {
    const root = path.join(scratch, "共享 environment");
    const home = path.join(scratch, "home");
    const layout = managedLayout(root);
    const nodePath = path.join(layout.node22, "v22", "node.exe");
    const jshookEntry = path.join(
      layout.servers,
      "jshook",
      "node_modules",
      "@jshookmcp",
      "jshook",
      "dist",
      "index.mjs",
    );
    const ctx = {
      platform: "win32",
      arch: "x64",
      toolsDir: root,
      home,
      logger: silentLogger,
      dryRun: false,
      autoInstallDeps: true,
      run: async () => ({
        code: 0,
        stdout: "",
        stderr: "",
        ok: true,
      }),
      depStatus: new Map([
        [
          "node2212",
          {
            installed: true,
            version: "22.23.2",
            path: nodePath,
          },
        ],
      ]),
    };
    const servers = {
      jshook: {
        command: nodePath,
        args: [jshookEntry],
        env: managedEnv(root),
      },
      x64dbg: {
        type: "http",
        url: "http://127.0.0.1:3000/mcp",
      },
    };

    const cursorWrite = await getClient("cursor").applyServers(ctx, servers);
    const claudeWrite = await getClient("claude-desktop").applyServers(
      ctx,
      servers,
    );
    const cursor = JSON.parse(
      await fsp.readFile(cursorWrite.configPath, "utf8"),
    ).mcpServers;
    const claude = JSON.parse(
      await fsp.readFile(claudeWrite.configPath, "utf8"),
    ).mcpServers;

    assert.equal(cursor.jshook.command, nodePath);
    assert.equal(claude.jshook.command, nodePath);
    assert.deepEqual(cursor.jshook.args, [jshookEntry]);
    assert.deepEqual(claude.jshook.args, [jshookEntry]);
    assert.equal(cursor.x64dbg.url, "http://127.0.0.1:3000/mcp");
    assert.equal(claude.x64dbg.command, nodePath);
    assert.equal(
      claude.x64dbg.args[0],
      path.join(
        layout.servers,
        "mcp-remote",
        "node_modules",
        "mcp-remote",
        "dist",
        "proxy.js",
      ),
    );
    assert.equal(claude.x64dbg.args[1], "http://127.0.0.1:3000/mcp");

    const emitted = JSON.stringify({ cursor, claude });
    assert.equal(emitted.includes('"npx"'), false);
    assert.equal(emitted.includes("@latest"), false);
    for (const key of [
      "UV_CACHE_DIR",
      "UV_PYTHON_INSTALL_DIR",
      "NPM_CONFIG_CACHE",
      "PIP_CACHE_DIR",
    ]) {
      assert.ok(path.resolve(claude.jshook.env[key]).startsWith(path.resolve(root)));
      assert.ok(path.resolve(claude.x64dbg.env[key]).startsWith(path.resolve(root)));
    }
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
});
