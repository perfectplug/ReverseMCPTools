// Verifies that every real external download the recipes rely on resolves live
// against GitHub — the version-locked, asset-name-pattern parts most likely to
// rot. Does NOT download anything. Run: node scripts/verify-assets.mjs
import { githubReleaseAsset } from "../dist/core/download.js";

const checks = [
  ["Ghidra 11.3.2 (pinned)", "NationalSecurityAgency/ghidra", /ghidra_11\.3\.2_PUBLIC_.*\.zip$/i, "Ghidra_11.3.2_build", false],
  ["GhidraMCP plugin", "LaurieWired/GhidraMCP", /GhidraMCP.*\.zip$/i, "1.4", true],
  ["jadx release (win-gui)", "skylot/jadx", /jadx-gui-.*\.zip$/i, "v1.5.6", true],
  ["jadx release (cross)", "skylot/jadx", /jadx-\d.*\.zip$/i, "v1.5.6", true],
  ["x64dbg snapshot", "x64dbg/x64dbg", /snapshot_.*\.zip$/i, "2026.05.27", true],
  ["x64dbg-mcp .dp64", "SetsunaYukiOvO/x64dbg-mcp", /x64dbg_mcp\.dp64$/i, "v1.0.10", true],
  ["x64dbg-mcp .dp32", "SetsunaYukiOvO/x64dbg-mcp", /x32dbg_mcp\.dp32$/i, "v1.0.10", true],
  ["uv 0.12.0 (win-x64)", "astral-sh/uv", /^uv-x86_64-pc-windows-msvc\.zip$/i, "0.12.0", true],
];

let ok = true;
for (const [name, repo, re, tag, requireDigest] of checks) {
  try {
    const a = await githubReleaseAsset(repo, re, tag);
    if (requireDigest && !a.sha256) {
      throw new Error("GitHub release asset has no SHA-256 digest");
    }
    console.log(`PASS  ${name.padEnd(26)} → ${a.name}  (${a.tag})`);
  } catch (e) {
    console.log(`FAIL  ${name.padEnd(26)} → ${e.message}`);
    ok = false;
  }
}

const endpointChecks = [
  [
    "Ghidra 11.3.2 published SHA-256",
    async () => {
      const expected =
        "99d45035bdcc3d6627e7b1232b7b379905a9fad76c772c920602e2b5d8b2dac2";
      const res = await fetch(
        "https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/tags/Ghidra_11.3.2_build",
        { headers: { "User-Agent": "reverse-mcp-tools" } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const release = await res.json();
      if (!String(release.body ?? "").includes(expected)) {
        throw new Error("release notes no longer contain the pinned SHA-256");
      }
      return expected;
    },
  ],
  [
    "Node.js 22.23.2 checksums",
    async () => {
      const res = await fetch(
        "https://nodejs.org/download/release/v22.23.2/SHASUMS256.txt",
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.includes("node-v22.23.2-win-x64.zip")) {
        throw new Error("win-x64 archive missing from SHASUMS256.txt");
      }
      return "node-v22.23.2-win-x64.zip";
    },
  ],
  [
    "Temurin JDK 21 portable API",
    async () => {
      const query = new URLSearchParams({
        architecture: "x64",
        heap_size: "normal",
        image_type: "jdk",
        jvm_impl: "hotspot",
        os: "windows",
        vendor: "eclipse",
        project: "jdk",
      });
      const res = await fetch(
        `https://api.adoptium.net/v3/assets/latest/21/hotspot?${query}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const assets = await res.json();
      const pkg = assets[0]?.binary?.package;
      if (!pkg?.link || !/^[a-f0-9]{64}$/i.test(pkg.checksum ?? "")) {
        throw new Error("portable archive or SHA-256 missing");
      }
      return pkg.name;
    },
  ],
  [
    "jshook npm package (pinned)",
    async () => {
      const res = await fetch(
        "https://registry.npmjs.org/@jshookmcp%2Fjshook/0.3.4",
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.version !== "0.3.4" || !data.dist?.integrity) {
        throw new Error("version or integrity missing");
      }
      return `@jshookmcp/jshook@${data.version}`;
    },
  ],
  [
    "mcp-remote npm package (pinned)",
    async () => {
      const res = await fetch(
        "https://registry.npmjs.org/mcp-remote/0.1.38",
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.version !== "0.1.38" || !data.dist?.integrity) {
        throw new Error("version or integrity missing");
      }
      return `mcp-remote@${data.version}`;
    },
  ],
];

for (const [name, check] of endpointChecks) {
  try {
    const detail = await check();
    console.log(`PASS  ${name.padEnd(30)} → ${detail}`);
  } catch (e) {
    console.log(`FAIL  ${name.padEnd(30)} → ${e.message}`);
    ok = false;
  }
}

process.exit(ok ? 0 : 1);
