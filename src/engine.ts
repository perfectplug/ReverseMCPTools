import {
  type ClientTarget,
  type InstallContext,
  type McpServerConfig,
  type Recipe,
} from "./core/types.js";
import { color } from "./core/logger.js";
import { ensureDependencies } from "./deps/manager.js";

export interface RecipeOutcome {
  recipe: Recipe;
  ok: boolean;
  servers: Record<string, McpServerConfig>;
  placedFiles: string[];
  error?: string;
  /** Dependencies that could not be satisfied. */
  unmetDeps: string[];
}

export interface ClientOutcome {
  client: ClientTarget;
  ok: boolean;
  configPath?: string;
  backupPath?: string;
  written: string[];
  error?: string;
}

export interface InstallReport {
  recipes: RecipeOutcome[];
  clients: ClientOutcome[];
}

/**
 * Orchestrate an install: for each recipe, ensure its dependencies, run its
 * placement, and collect the MCP server block(s); then merge all servers and
 * write them into each selected client. Failures are isolated per recipe/client
 * so one broken tool doesn't abort the rest.
 */
export async function runInstall(
  ctx: InstallContext,
  recipes: Recipe[],
  clients: ClientTarget[],
): Promise<InstallReport> {
  const recipeOutcomes: RecipeOutcome[] = [];
  const merged: Record<string, McpServerConfig> = {};

  for (const recipe of recipes) {
    ctx.logger.step(`${recipe.name} — ${recipe.description}`);

    if (!(recipe.platforms as string[]).includes(ctx.platform)) {
      ctx.logger.warn(
        `${recipe.name} is not supported on ${ctx.platform} — skipping.`,
      );
      recipeOutcomes.push({
        recipe,
        ok: false,
        servers: {},
        placedFiles: [],
        unmetDeps: [],
        error: `unsupported platform ${ctx.platform}`,
      });
      continue;
    }

    // 1. Dependencies.
    const deps = await ensureDependencies(ctx, recipe.dependencies);
    const unmet = deps.filter((d) => !d.satisfied).map((d) => d.name);
    if (unmet.length > 0) {
      ctx.logger.warn(
        `${recipe.name}: unmet dependencies (${unmet.join(", ")}). Continuing to place files, but the server may not run until they are installed.`,
      );
    }

    // 2. Placement.
    try {
      const result = await recipe.install(ctx);
      Object.assign(merged, result.servers);
      for (const note of result.notes ?? []) ctx.logger.detail(note);
      recipeOutcomes.push({
        recipe,
        ok: true,
        servers: result.servers,
        placedFiles: result.placedFiles ?? [],
        unmetDeps: unmet,
      });
      const files = result.placedFiles ?? [];
      if (files.length) {
        ctx.logger.detail(`Placed: ${files.length} file(s).`);
      }
      ctx.logger.success(`${recipe.name} ready.`);
    } catch (err) {
      const msg = (err as Error).message;
      ctx.logger.error(`${recipe.name} failed: ${msg}`);
      recipeOutcomes.push({
        recipe,
        ok: false,
        servers: {},
        placedFiles: [],
        unmetDeps: unmet,
        error: msg,
      });
    }
  }

  // 3. Write merged servers into each client.
  const clientOutcomes: ClientOutcome[] = [];
  if (Object.keys(merged).length === 0) {
    ctx.logger.warn("No MCP servers were produced; skipping client config.");
    return { recipes: recipeOutcomes, clients: clientOutcomes };
  }

  ctx.logger.step("Writing MCP client configuration");
  for (const client of clients) {
    try {
      const res = await client.applyServers(ctx, merged);
      clientOutcomes.push({
        client,
        ok: true,
        configPath: res.configPath,
        backupPath: res.backupPath,
        written: res.written,
      });
      ctx.logger.success(
        `${client.name}: wrote ${res.written.join(", ")} → ${res.configPath}`,
      );
      if (res.backupPath) {
        ctx.logger.detail(`Backed up previous config to ${res.backupPath}`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      ctx.logger.error(`${client.name}: ${msg}`);
      clientOutcomes.push({ client, ok: false, written: [], error: msg });
    }
  }

  return { recipes: recipeOutcomes, clients: clientOutcomes };
}

/** Print a human-readable summary + the post-install checklist. */
export function printReport(ctx: InstallContext, report: InstallReport): void {
  const log = ctx.logger;
  log.info("");
  log.info(color.bold("── Summary ──"));

  for (const r of report.recipes) {
    const mark = r.ok ? color.green("✔") : color.red("✖");
    const extra = r.unmetDeps.length
      ? color.yellow(` (missing: ${r.unmetDeps.join(", ")})`)
      : "";
    log.info(`${mark} ${r.recipe.name}${extra}${r.error ? color.red(` — ${r.error}`) : ""}`);
  }

  for (const c of report.clients) {
    const mark = c.ok ? color.green("✔") : color.red("✖");
    log.info(`${mark} ${c.client.name}${c.configPath ? color.dim(` → ${c.configPath}`) : ""}`);
  }

  // Next steps grouped by recipe that succeeded.
  const succeeded = report.recipes.filter((r) => r.ok);
  if (succeeded.length) {
    log.info("");
    log.info(color.bold("── Next steps ──"));
    for (const r of succeeded) {
      log.info(color.cyan(`\n${r.recipe.name}`));
      if (r.recipe.hostApp) {
        log.info(`  • Open ${color.bold(r.recipe.hostApp)} and load your target.`);
      }
      for (const note of r.recipe.postInstallNotes) log.info(`  • ${note}`);
    }
  }

  // Restart hints, deduped by client.
  const okClients = report.clients.filter((c) => c.ok);
  if (okClients.length) {
    log.info("");
    log.info(color.bold("── Restart your client(s) ──"));
    for (const c of okClients) {
      log.info(`  • ${c.client.name}: ${c.client.restartHint}`);
    }
  }
}
