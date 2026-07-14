// Spawns the exact command the jshook recipe emits and performs a real MCP
// initialize handshake over stdio, proving the emitted config yields a working
// MCP server. Best-effort: booting jshook pulls its deps on first run.
import { spawn } from "node:child_process";

const isWin = process.platform === "win32";
const cmd = isWin ? "cmd" : "npx";
const args = isWin
  ? ["/c", "npx", "-y", "@jshookmcp/jshook@latest"]
  : ["-y", "@jshookmcp/jshook@latest"];

const child = spawn(cmd, args, {
  env: {
    ...process.env,
    JSHOOK_BASE_PROFILE: "search",
    MCP_TOOL_PROFILE: "search",
    FRIDA_TIMEOUT_MS: "15000",
    PUPPETEER_SKIP_DOWNLOAD: "true",
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let out = "";
let err = "";
let done = false;
const finish = (code, msg) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  console.log(msg);
  try { child.kill(); } catch {}
  process.exit(code);
};

const timer = setTimeout(
  () => finish(1, `TIMEOUT — no initialize response in 90s.\nstderr tail: ${err.slice(-300)}`),
  90_000,
);

child.stdout.on("data", (d) => {
  out += d.toString();
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const m = JSON.parse(t);
      if (m.id === 1 && m.result) {
        const info = m.result.serverInfo ?? { protocolVersion: m.result.protocolVersion };
        finish(0, `PASS  MCP initialize responded: ${JSON.stringify(info)}`);
      }
    } catch {}
  }
});
child.stderr.on("data", (d) => (err += d.toString()));
child.on("error", (e) => finish(1, `SPAWN ERROR: ${e.message}`));
child.on("exit", (code) =>
  finish(1, `Server exited early (code ${code}).\nstderr tail: ${err.slice(-300)}`),
);

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "remcp-verify", version: "0.1.0" },
  },
};
child.stdin.write(JSON.stringify(init) + "\n");
