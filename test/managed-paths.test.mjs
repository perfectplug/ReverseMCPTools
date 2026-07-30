import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { toolsDir } from "../dist/core/platform.js";
import { managedEnv, managedLayout } from "../dist/core/layout.js";

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function collectStrings(value, prefix = "") {
  if (typeof value === "string") return [[prefix, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    collectStrings(child, prefix ? `${prefix}.${key}` : key),
  );
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("toolsDir uses explicit, primary env, legacy env, then platform default", () => {
  const primaryBefore = process.env.REMCP_TOOLS_DIR;
  const legacyBefore = process.env.REVERSE_MCP_TOOLS_DIR;

  const base = path.join(os.tmpdir(), `remcp-root-priority-${process.pid}`);
  const explicit = path.join(base, "explicit");
  const primary = path.join(base, "primary");
  const legacy = path.join(base, "legacy");

  try {
    process.env.REMCP_TOOLS_DIR = primary;
    process.env.REVERSE_MCP_TOOLS_DIR = legacy;
    assert.equal(toolsDir(explicit), path.resolve(explicit));

    assert.equal(toolsDir(), path.resolve(primary));

    delete process.env.REMCP_TOOLS_DIR;
    assert.equal(toolsDir(), path.resolve(legacy));

    delete process.env.REVERSE_MCP_TOOLS_DIR;
    const fallback = toolsDir();
    const userId =
      typeof process.getuid === "function"
        ? String(process.getuid())
        : os.userInfo().username.replace(/[^a-z0-9_.-]/gi, "_");
    const expected =
      process.platform === "win32"
        ? path.resolve(os.tmpdir(), "ReverseMCPTools")
        : path.resolve(os.tmpdir(), `reverse-mcp-tools-${userId}`);
    assert.equal(fallback, expected);
  } finally {
    restoreEnv("REMCP_TOOLS_DIR", primaryBefore);
    restoreEnv("REVERSE_MCP_TOOLS_DIR", legacyBefore);
  }
});

test("toolsDir converts a relative explicit root to an absolute path", () => {
  const relative = path.join(
    "test-relative-roots",
    `remcp-${process.pid}`,
    "shared",
  );
  assert.equal(toolsDir(relative), path.resolve(relative));
  assert.equal(path.isAbsolute(toolsDir(relative)), true);
});

test("managedLayout normalizes the root and keeps every managed path inside it", () => {
  const relativeRoot = path.join(
    "test-relative-roots",
    `layout-${process.pid}`,
  );
  const root = path.resolve(relativeRoot);
  const layout = managedLayout(relativeRoot);

  assert.equal(layout.root, root);

  for (const field of [
    "downloads",
    "runtimes",
    "tools",
    "servers",
    "cache",
    "state",
    "bin",
  ]) {
    assert.equal(
      typeof layout[field],
      "string",
      `managedLayout must expose ${field}`,
    );
    assert.equal(layout[field], path.join(root, field));
  }

  const paths = collectStrings(layout);
  assert.ok(paths.length >= 8, "layout should expose the managed root and its areas");
  for (const [name, candidate] of paths) {
    assert.equal(
      path.isAbsolute(candidate),
      true,
      `${name} must be an absolute path: ${candidate}`,
    );
    assert.equal(
      isWithin(root, candidate),
      true,
      `${name} escapes the managed root: ${candidate}`,
    );
  }
});

test("managedEnv directs package-manager caches and install locations into root", () => {
  const root = path.resolve(
    os.tmpdir(),
    `remcp-managed-env-${process.pid}`,
    "root with spaces",
  );
  const layout = managedLayout(root);
  const env = managedEnv(root);

  assert.equal(typeof env, "object");
  assert.ok(env);

  const entries = Object.entries(env);
  const findKey = (name) =>
    entries.find(([key]) => key.toUpperCase() === name.toUpperCase());

  const rootEntry = findKey("REMCP_TOOLS_DIR");
  assert.ok(rootEntry, "managedEnv must publish REMCP_TOOLS_DIR");
  assert.equal(path.resolve(rootEntry[1]), root);

  for (const [label, key] of [
    ["uv cache", "UV_CACHE_DIR"],
    ["uv-managed Python", "UV_PYTHON_INSTALL_DIR"],
    ["uv-managed Python binaries", "UV_PYTHON_BIN_DIR"],
    ["uv tools", "UV_TOOL_DIR"],
    ["uv tool binaries", "UV_TOOL_BIN_DIR"],
    ["pip cache", "PIP_CACHE_DIR"],
    ["npm cache", "NPM_CONFIG_CACHE"],
  ]) {
    const entry = findKey(key);
    assert.ok(entry, `managedEnv must expose ${label} via ${key}`);
    assert.equal(
      path.isAbsolute(entry[1]),
      true,
      `${entry[0]} must be absolute`,
    );
    assert.equal(
      isWithin(root, entry[1]),
      true,
      `${entry[0]} escapes the managed root: ${entry[1]}`,
    );
  }

  for (const [key, value] of entries) {
    if (key.toUpperCase() === "PATH") {
      const first = value.split(path.delimiter)[0];
      assert.equal(
        path.resolve(first),
        path.resolve(layout.bin),
        "managed bin must be first on PATH",
      );
      continue;
    }

    if (/(?:CACHE|DIR|HOME|ROOT|PREFIX|TEMP|TMP)$/i.test(key)) {
      assert.equal(
        path.isAbsolute(value),
        true,
        `${key} must contain an absolute path`,
      );
      assert.equal(
        isWithin(root, value),
        true,
        `${key} escapes the managed root: ${value}`,
      );
    }
  }
});
