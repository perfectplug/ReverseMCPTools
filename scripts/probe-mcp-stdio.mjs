// Generic MCP stdio handshake probe.
// Usage: node probe-mcp-stdio.mjs <command> [args...]
import { spawn } from "node:child_process";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.log("usage: node probe-mcp-stdio.mjs <command> [args...]");
  process.exit(2);
}

const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
let out = "";
let err = "";
child.stdout.on("data", (d) => (out += d.toString()));
child.stderr.on("data", (d) => (err += d.toString()));
child.on("error", (e) => console.log("SPAWN_ERROR:", e.message));

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

setTimeout(() => {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "probe", version: "0" },
    },
  });
}, 800);

// After initialize, ask for the tool list.
setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
}, 2500);

setTimeout(() => {
  const initOk = /"protocolVersion"/.test(out) || /"serverInfo"/.test(out);
  const toolsMatch = out.match(/"name"\s*:\s*"([^"]+)"/g);
  console.log("=== HANDSHAKE:", initOk ? "OK" : "NO INIT RESPONSE", "===");
  console.log("--- STDOUT (first 1500) ---");
  console.log(out.slice(0, 1500) || "(empty)");
  if (!initOk) {
    console.log("--- STDERR (first 1500) ---");
    console.log(err.slice(0, 1500) || "(empty)");
  } else if (toolsMatch) {
    console.log("--- tools/keys seen:", toolsMatch.length, "---");
  }
  try { child.kill(); } catch {}
  process.exit(0);
}, 9000);
