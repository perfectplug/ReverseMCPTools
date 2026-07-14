import type {
  InstallContext,
  Recipe,
  RecipeInstallResult,
} from "../core/types.js";
import { winCmd } from "../core/exec.js";

// npm: @jshookmcp/jshook (repo vmoranv/jshookmcp). Launched on demand by the
// client via npx — nothing to place on disk, so install() only emits config.
const PACKAGE = "@jshookmcp/jshook@latest";

export const jshookRecipe: Recipe = {
  id: "jshook",
  name: "jshook MCP",
  description:
    "JS reverse-engineering / hooking toolkit with a Frida bridge, run on demand via npx (vmoranv/jshookmcp).",
  platforms: ["win32", "darwin", "linux"],
  dependencies: ["node2212"], // Node >= 22.12 is a hard requirement
  approxDownloadMb: 0, // npx fetches the package on first run

  async install(ctx: InstallContext): Promise<RecipeInstallResult> {
    // Optional, non-fatal: pre-warm the npm cache so the first client launch is
    // fast. Never mutate anything on dryRun.
    if (!ctx.dryRun) {
      await ctx.logger.task("Pre-warm jshook (npx cache)", async () => {
        try {
          const res = await winCmd("npx", ["-y", PACKAGE, "--help"], {
            allowFailure: true,
            timeoutMs: 120_000,
          });
          if (!res.ok) {
            ctx.logger.warn(
              "Could not pre-warm jshook via npx; it will download on first client launch.",
            );
          }
        } catch {
          ctx.logger.warn(
            "Could not pre-warm jshook via npx; it will download on first client launch.",
          );
        }
      });
    }

    return {
      servers: {
        jshook: {
          command: "npx",
          args: ["-y", PACKAGE],
          env: {
            JSHOOK_BASE_PROFILE: "search",
            MCP_TOOL_PROFILE: "search",
            FRIDA_TIMEOUT_MS: "15000",
          },
        },
      },
      placedFiles: [],
    };
  },

  postInstallNotes: [
    "Node >= 22.12 is a HARD requirement — on older Node the server silently fails to start. Verify with `node --version`.",
    "The default 'search' tool profile (~3K tokens) is enabled to avoid the 623-tool context bomb. Switch MCP_TOOL_PROFILE (and JSHOOK_BASE_PROFILE) to 'workflow' or 'full' only when you actually need the extra tools.",
    "For REAL mobile/device hooking you must separately run a matching frida-server on a rooted Android / jailbroken iOS / emulator, plus frida-tools on the host — jshook does not bundle these.",
    "jshook is licensed AGPL-3.0. Only instrument software you are authorized to test.",
  ],

  async verify(): Promise<boolean> {
    // Nothing is placed on disk; npx resolves the package at launch time.
    return true;
  },
};
