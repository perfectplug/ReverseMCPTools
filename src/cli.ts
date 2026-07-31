import { Command } from "commander";
import { checkbox, confirm } from "@inquirer/prompts";
import type { InstallContext } from "./core/types.js";
import { ConsoleLogger, color } from "./core/logger.js";
import { exec } from "./core/exec.js";
import {
  currentArch,
  currentPlatform,
  toolsDir as resolveToolsDir,
} from "./core/platform.js";
import { managedLayout } from "./core/layout.js";
import { RECIPES, getRecipe, recipesForPlatform } from "./recipes/registry.js";
import { CLIENTS, getClient } from "./clients/registry.js";
import { runInstall, printReport } from "./engine.js";
import { DEPENDENCIES } from "./deps/registry.js";
import os from "node:os";

function createContext(opts: {
  dryRun: boolean;
  autoInstallDeps: boolean;
  toolsDir?: string;
}): InstallContext {
  return {
    platform: currentPlatform(),
    arch: currentArch(),
    toolsDir: resolveToolsDir(opts.toolsDir),
    home: os.homedir(),
    logger: new ConsoleLogger(),
    dryRun: opts.dryRun,
    autoInstallDeps: opts.autoInstallDeps,
    run: (cmd, args, o) => exec(cmd, args, o),
    depStatus: new Map(),
  };
}

function parseCsv(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function banner(): void {
  console.log(
    color.bold(color.cyan("\nReverseMCPTools")) +
      color.dim(" — one-click MCP installer for reverse engineers\n"),
  );
}

async function interactiveInstall(flags: {
  dryRun: boolean;
  autoDeps: boolean;
  toolsDir?: string;
}): Promise<void> {
  banner();
  const ctx = createContext({
    dryRun: flags.dryRun,
    autoInstallDeps: flags.autoDeps,
    toolsDir: flags.toolsDir,
  });

  const available = recipesForPlatform(ctx.platform);
  if (available.length === 0) {
    ctx.logger.error(`No recipes support this platform (${ctx.platform}).`);
    return;
  }

  const chosenToolIds = await checkbox({
    message: "Which RE tools do you want to install?",
    choices: available.map((r) => ({
      name: `${r.name}${r.hostApp ? color.dim(` (needs ${r.hostApp})`) : ""} — ${r.description}`,
      value: r.id,
      checked: false,
    })),
  });
  if (chosenToolIds.length === 0) {
    ctx.logger.warn("Nothing selected. Exiting.");
    return;
  }

  // Detect clients so installed ones are pre-checked.
  const presences = await Promise.all(
    CLIENTS.map(async (c) => ({ client: c, presence: await c.detect(ctx) })),
  );
  const chosenClientIds = await checkbox({
    message: "Which MCP clients should be configured?",
    choices: presences.map(({ client, presence }) => ({
      name: `${client.name}${presence.installed ? color.green(" (detected)") : color.dim(" (not detected)")}`,
      value: client.id,
      checked: presence.installed,
    })),
  });
  if (chosenClientIds.length === 0) {
    ctx.logger.warn("No clients selected. Exiting.");
    return;
  }

  if (!flags.autoDeps) {
    ctx.logger.detail(
      "Auto-install is off: missing dependencies will be reported with manual steps.",
    );
  }

  const proceed = await confirm({
    message: `Install ${chosenToolIds.length} tool(s) and configure ${chosenClientIds.length} client(s)${flags.dryRun ? " (dry-run)" : ""}?`,
    default: true,
  });
  if (!proceed) {
    ctx.logger.warn("Cancelled.");
    return;
  }

  const recipes = chosenToolIds.map(getRecipe);
  const clients = chosenClientIds.map(getClient);
  const report = await runInstall(ctx, recipes, clients);
  printReport(ctx, report);
}

async function nonInteractiveInstall(flags: {
  tools: string[];
  clients: string[];
  all: boolean;
  dryRun: boolean;
  autoDeps: boolean;
  toolsDir?: string;
}): Promise<void> {
  banner();
  const ctx = createContext({
    dryRun: flags.dryRun,
    autoInstallDeps: flags.autoDeps,
    toolsDir: flags.toolsDir,
  });

  const available = recipesForPlatform(ctx.platform);
  const recipes = flags.all
    ? available
    : flags.tools.map((id) => {
        try {
          return getRecipe(id);
        } catch {
          ctx.logger.error(`Unknown tool "${id}". Known: ${RECIPES.map((r) => r.id).join(", ")}`);
          process.exit(2);
        }
      });

  let clientIds = flags.clients;
  if (clientIds.length === 0) {
    // Default to detected clients.
    const detected = await Promise.all(
      CLIENTS.map(async (c) => ((await c.detect(ctx)).installed ? c.id : null)),
    );
    clientIds = detected.filter((x): x is string => x !== null);
    if (clientIds.length === 0) {
      ctx.logger.error(
        "No MCP clients detected. Specify with --clients (e.g. --clients cursor,claude-desktop).",
      );
      process.exit(2);
    }
    ctx.logger.detail(`Auto-selected detected clients: ${clientIds.join(", ")}`);
  }
  const clients = clientIds.map((id) => {
    try {
      return getClient(id);
    } catch {
      ctx.logger.error(`Unknown client "${id}". Known: ${CLIENTS.map((c) => c.id).join(", ")}`);
      process.exit(2);
    }
  });

  const report = await runInstall(ctx, recipes, clients);
  printReport(ctx, report);
}

async function doctor(toolsDir?: string): Promise<void> {
  banner();
  const ctx = createContext({
    dryRun: true,
    autoInstallDeps: false,
    toolsDir,
  });
  ctx.logger.step("Managed shared environment");
  ctx.logger.info(`  ${ctx.toolsDir}`);
  ctx.logger.step("MCP clients");
  for (const c of CLIENTS) {
    const p = await c.detect(ctx);
    const mark = p.installed ? color.green("✔") : color.dim("·");
    ctx.logger.info(`  ${mark} ${c.name}${p.configPath ? color.dim(` → ${p.configPath}`) : ""}`);
  }

  ctx.logger.step("Runtime dependencies");
  for (const dep of Object.values(DEPENDENCIES)) {
    const s = await dep.detect(ctx);
    const mark = s.installed ? color.green("✔") : color.yellow("✖");
    ctx.logger.info(
      `  ${mark} ${dep.name}${s.version ? color.dim(` (${s.version})`) : ""}${s.detail ? color.yellow(` — ${s.detail}`) : ""}`,
    );
  }

  ctx.logger.step("Recipes");
  for (const r of RECIPES) {
    const ok = (r.platforms as string[]).includes(ctx.platform);
    const mark = ok ? color.green("✔") : color.dim("·");
    ctx.logger.info(
      `  ${mark} ${r.id} — ${r.name}${ok ? "" : color.dim(` (not supported on ${ctx.platform})`)}`,
    );
  }
}

function listAll(): void {
  banner();
  console.log(color.bold("Tools (recipes):"));
  for (const r of RECIPES) {
    console.log(`  ${color.cyan(r.id.padEnd(10))} ${r.name} — ${r.description}`);
    console.log(
      color.dim(
        `             host: ${r.hostApp ?? "none"} | deps: ${r.dependencies.join(", ") || "none"} | platforms: ${r.platforms.join(", ")}`,
      ),
    );
  }
  console.log("");
  console.log(color.bold("Clients:"));
  for (const c of CLIENTS) console.log(`  ${color.cyan(c.id.padEnd(16))} ${c.name}`);
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("reverse-mcp-tools")
    .description(
      "One-click installer for reverse-engineering MCP servers (Ghidra, JADX, x64dbg, jshook).",
    )
    .version("0.2.2")
    .option(
      "--tools-dir <path>",
      "shared root for all managed SDKs, binaries, MCP servers and caches (or REMCP_TOOLS_DIR)",
    );

  program
    .command("install", { isDefault: true })
    .description("Install RE tool MCP servers and configure your clients")
    .option("-t, --tools <list>", "comma-separated tool ids (e.g. ghidra,jadx). Omit for interactive.")
    .option("-c, --clients <list>", "comma-separated client ids. Omit to use detected clients.")
    .option("-a, --all", "install every tool supported on this platform", false)
    .option("--dry-run", "show what would happen without changing anything", false)
    .option("--no-auto-deps", "detect dependencies and print manual steps instead of installing")
    .action(async (opts) => {
      const tools = parseCsv(opts.tools);
      const clients = parseCsv(opts.clients);
      const flags = {
        dryRun: Boolean(opts.dryRun),
        // commander maps --no-auto-deps to opts.autoDeps === false
        autoDeps: opts.autoDeps !== false,
      };
      const toolsDir = program.opts<{ toolsDir?: string }>().toolsDir;
      const interactive = !opts.all && tools.length === 0 && process.stdout.isTTY;
      if (interactive) {
        await interactiveInstall({ ...flags, toolsDir });
      } else {
        await nonInteractiveInstall({
          tools,
          clients,
          all: Boolean(opts.all),
          toolsDir,
          ...flags,
        });
      }
    });

  program
    .command("list")
    .description("List available tools and clients")
    .action(() => listAll());

  program
    .command("doctor")
    .description("Report detected clients, dependencies and recipe support")
    .action(async () => {
      await doctor(program.opts<{ toolsDir?: string }>().toolsDir);
    });

  program
    .command("env")
    .description("Print the shared managed environment layout")
    .option("--json", "print machine-readable JSON", false)
    .action((opts) => {
      const root = resolveToolsDir(
        program.opts<{ toolsDir?: string }>().toolsDir,
      );
      const layout = managedLayout(root);
      if (opts.json) {
        console.log(JSON.stringify(layout, null, 2));
        return;
      }
      banner();
      console.log(color.bold("Managed shared environment:"));
      for (const [name, value] of Object.entries(layout)) {
        console.log(`  ${color.cyan(name.padEnd(12))} ${value}`);
      }
    });

  await program.parseAsync(argv);
}
