// Verifies that every real external download the recipes rely on resolves live
// against GitHub — the version-locked, asset-name-pattern parts most likely to
// rot. Does NOT download anything. Run: node scripts/verify-assets.mjs
import { githubReleaseAsset } from "../dist/core/download.js";

const checks = [
  ["Ghidra 11.3.2 (pinned)", "NationalSecurityAgency/ghidra", /ghidra_11\.3\.2_PUBLIC_.*\.zip$/i, "Ghidra_11.3.2_build"],
  ["GhidraMCP plugin", "LaurieWired/GhidraMCP", /GhidraMCP.*\.zip$/i, "latest"],
  ["jadx release (win-gui)", "skylot/jadx", /jadx-gui-.*\.zip$/i, "latest"],
  ["jadx release (cross)", "skylot/jadx", /jadx-\d.*\.zip$/i, "latest"],
  ["x64dbg snapshot", "x64dbg/x64dbg", /snapshot_.*\.zip$/i, "latest"],
  ["x64dbg-mcp .dp64", "SetsunaYukiOvO/x64dbg-mcp", /x64dbg_mcp\.dp64$/i, "latest"],
  ["x64dbg-mcp .dp32", "SetsunaYukiOvO/x64dbg-mcp", /x32dbg_mcp\.dp32$/i, "latest"],
];

let ok = true;
for (const [name, repo, re, tag] of checks) {
  try {
    const a = await githubReleaseAsset(repo, re, tag);
    console.log(`PASS  ${name.padEnd(26)} → ${a.name}  (${a.tag})`);
  } catch (e) {
    console.log(`FAIL  ${name.padEnd(26)} → ${e.message}`);
    ok = false;
  }
}
process.exit(ok ? 0 : 1);
