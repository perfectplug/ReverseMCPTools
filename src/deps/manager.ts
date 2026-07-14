import type { DepStatus, InstallContext } from "../core/types.js";
import { getDependency } from "./registry.js";

export interface DepResolution {
  id: string;
  name: string;
  status: DepStatus;
  /** true if it was installed (or is now installed) and usable. */
  satisfied: boolean;
  /** true if we ran an install for it during this call. */
  installed: boolean;
  /** Manual steps to show when not satisfied and not auto-installed. */
  manualSteps: string[];
}

/**
 * Ensure a set of dependencies are present. With `autoInstallDeps` on, missing
 * ones are installed (winget/scripts); otherwise we detect and return manual
 * guidance. Results are cached on the context so recipes sharing a dep (e.g.
 * JDK 21 for both Ghidra and jadx) don't re-detect or re-install.
 */
export async function ensureDependencies(
  ctx: InstallContext,
  ids: string[],
): Promise<DepResolution[]> {
  const results: DepResolution[] = [];

  for (const id of ids) {
    const dep = getDependency(id);

    let status = ctx.depStatus.get(id);
    if (!status) {
      status = await ctx.logger.task(`Check ${dep.name}`, () => dep.detect(ctx));
      ctx.depStatus.set(id, status);
    }

    if (status.installed) {
      ctx.logger.detail(
        `${dep.name} present${status.version ? ` (${status.version})` : ""}`,
      );
      results.push({
        id,
        name: dep.name,
        status,
        satisfied: true,
        installed: false,
        manualSteps: dep.manualSteps,
      });
      continue;
    }

    if (status.detail) ctx.logger.warn(status.detail);

    if (!ctx.autoInstallDeps || ctx.dryRun) {
      ctx.logger.warn(
        `${dep.name} is missing. ${ctx.dryRun ? "(dry-run) " : ""}Auto-install is off — install it manually:`,
      );
      for (const s of dep.manualSteps) ctx.logger.detail(`- ${s}`);
      results.push({
        id,
        name: dep.name,
        status,
        satisfied: false,
        installed: false,
        manualSteps: dep.manualSteps,
      });
      continue;
    }

    // Auto-install, then re-detect to confirm.
    try {
      await dep.install(ctx);
      const after = await dep.detect(ctx);
      ctx.depStatus.set(id, after);
      if (after.installed) {
        ctx.logger.success(
          `Installed ${dep.name}${after.version ? ` (${after.version})` : ""}`,
        );
      } else {
        ctx.logger.warn(
          `${dep.name} still not detected after install — you may need to restart your terminal so PATH updates take effect.`,
        );
      }
      results.push({
        id,
        name: dep.name,
        status: after,
        satisfied: after.installed,
        installed: true,
        manualSteps: dep.manualSteps,
      });
    } catch (err) {
      ctx.logger.error(
        `Auto-install of ${dep.name} failed: ${(err as Error).message}`,
      );
      for (const s of dep.manualSteps) ctx.logger.detail(`- ${s}`);
      results.push({
        id,
        name: dep.name,
        status,
        satisfied: false,
        installed: false,
        manualSteps: dep.manualSteps,
      });
    }
  }

  return results;
}
