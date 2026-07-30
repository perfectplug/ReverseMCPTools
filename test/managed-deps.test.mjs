import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { managedLayout } from "../dist/core/layout.js";
import { DEPENDENCIES } from "../dist/deps/registry.js";

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

test("managed runtime detection requires completion markers and complete SDK trees", async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "remcp-deps-"));
  try {
    const root = path.join(scratch, "shared root");
    const layout = managedLayout(root);
    const java = path.join(layout.jdk21, "jdk", "bin", "java.exe");
    const javac = path.join(layout.jdk21, "jdk", "bin", "javac.exe");
    const uv = path.join(layout.uv, "0.12.0", "uv.exe");
    const python = path.join(
      layout.python,
      "cpython-3.13",
      "python.exe",
    );
    const node = path.join(layout.node22, "node-v22", "node.exe");
    const npmCli = path.join(
      layout.node22,
      "node-v22",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    for (const file of [java, javac, uv, python, node]) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, "");
    }

    const ctx = {
      platform: "win32",
      arch: "x64",
      toolsDir: root,
      home: scratch,
      logger: silentLogger,
      dryRun: true,
      autoInstallDeps: true,
      run: async (command) => {
        const base = path.basename(command).toLowerCase();
        const output =
          base === "java.exe"
            ? { stdout: "", stderr: 'openjdk version "21.0.12"' }
            : base === "uv.exe"
              ? { stdout: "uv 0.12.0", stderr: "" }
              : base === "python.exe"
                ? { stdout: "Python 3.13.11", stderr: "" }
                : { stdout: "v22.23.2", stderr: "" };
        return { code: 0, ok: true, ...output };
      },
      depStatus: new Map(),
    };

    for (const dep of Object.values(DEPENDENCIES)) {
      assert.equal((await dep.detect(ctx)).installed, false);
    }

    await fsp.writeFile(
      path.join(layout.jdk21, ".remcp-complete"),
      "temurin-jdk-21\njdk-21.0.12+8\n",
    );
    await fsp.writeFile(
      path.join(layout.uv, ".remcp-complete"),
      "uv@0.12.0\n",
    );
    await fsp.writeFile(
      path.join(layout.python, ".remcp-complete"),
      "python@3.13\n3.13.11\n",
    );
    await fsp.writeFile(
      path.join(layout.node22, ".remcp-complete"),
      "node@22.23.2\n",
    );

    assert.equal((await DEPENDENCIES.jdk21.detect(ctx)).installed, true);
    assert.equal((await DEPENDENCIES.uv.detect(ctx)).installed, true);
    assert.equal((await DEPENDENCIES.python.detect(ctx)).installed, true);
    assert.equal((await DEPENDENCIES.node2212.detect(ctx)).installed, false);

    await fsp.mkdir(path.dirname(npmCli), { recursive: true });
    await fsp.writeFile(npmCli, "");
    const nodeStatus = await DEPENDENCIES.node2212.detect(ctx);
    assert.equal(nodeStatus.installed, true);
    assert.equal(nodeStatus.path, node);
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }
});
