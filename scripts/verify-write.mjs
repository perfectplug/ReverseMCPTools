// Verifies real config write + merge + backup against a throwaway HOME so no
// real client config is touched. Run: node scripts/verify-write.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), "remcp-verify-" + process.pid);
fs.mkdirSync(tmp, { recursive: true });
// os.homedir() reads USERPROFILE (Windows) / HOME (posix) — set before import.
process.env.USERPROFILE = tmp;
process.env.HOME = tmp;

const { getClient } = await import("../dist/clients/registry.js");
const { ConsoleLogger } = await import("../dist/core/logger.js");

const ctx = {
  platform: process.platform === "win32" ? "win32" : "linux",
  arch: "x64",
  toolsDir: tmp,
  home: tmp,
  logger: new ConsoleLogger(true),
  dryRun: false,
  autoInstallDeps: false,
  run: async () => ({ code: 0, stdout: "", stderr: "", ok: true }),
  depStatus: new Map(),
};

const cursor = getClient("cursor");

const r1 = await cursor.applyServers(ctx, {
  jshook: { command: "npx", args: ["-y", "@jshookmcp/jshook@latest"] },
});
const cfgPath = r1.configPath;
const after1 = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

// Simulate a pre-existing unrelated server to prove we merge, not clobber.
after1.mcpServers.existing = { command: "foo" };
fs.writeFileSync(cfgPath, JSON.stringify(after1, null, 2));

const r2 = await cursor.applyServers(ctx, {
  x64dbg: { type: "http", url: "http://127.0.0.1:3000/mcp" },
});
const after2 = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const checks = {
  "write1 created file": fs.existsSync(cfgPath),
  "write1 has jshook": !!after1.mcpServers?.jshook,
  "write2 kept jshook (merge)": !!after2.mcpServers?.jshook,
  "write2 kept unrelated 'existing'": !!after2.mcpServers?.existing,
  "write2 added x64dbg": !!after2.mcpServers?.x64dbg,
  "write2 made a backup": !!r2.backupPath && fs.existsSync(r2.backupPath),
};

let ok = true;
for (const [name, pass] of Object.entries(checks)) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) ok = false;
}
console.log("\nFinal config:\n" + JSON.stringify(after2, null, 2));

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
