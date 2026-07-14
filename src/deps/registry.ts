import type { DependencySpec, DepStatus, InstallContext } from "../core/types.js";
import { which } from "../core/exec.js";
import { hasWinget, wingetInstall } from "../core/winget.js";

function parseMajor(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

async function version(
  ctx: InstallContext,
  cmd: string,
  args: string[],
): Promise<string | undefined> {
  const res = await ctx.run(cmd, args, { allowFailure: true });
  if (!res.ok && !res.stdout && !res.stderr) return undefined;
  // Many tools print their version to stderr (java) or stdout.
  const out = `${res.stdout}\n${res.stderr}`;
  const m = out.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : undefined;
}

async function guardWinget(ctx: InstallContext, id: string): Promise<void> {
  if (!(await hasWinget())) {
    throw new Error(
      `winget is not available; cannot auto-install ${id}. Install it manually (see steps above) or install winget from the Microsoft Store (App Installer).`,
    );
  }
  await ctx.logger.task(`winget install ${id}`, () => wingetInstall(id));
}

/** JDK 21 satisfies both Ghidra 11.3.x (needs 21) and jadx (needs 11+). */
const jdk21: DependencySpec = {
  id: "jdk21",
  name: "JDK 21 (Temurin)",
  purpose: "Runs Ghidra 11.3.x and jadx-gui",
  async detect(ctx): Promise<DepStatus> {
    const v = await version(ctx, "java", ["-version"]);
    const major = parseMajor(v);
    const path = await which("java");
    return {
      installed: major !== undefined && major >= 21,
      version: v,
      path,
      detail:
        major !== undefined && major < 21
          ? `Found Java ${v} but Ghidra 11.3.x needs JDK 21+`
          : undefined,
    };
  },
  async install(ctx): Promise<void> {
    await guardWinget(ctx, "EclipseAdoptium.Temurin.21.JDK");
  },
  manualSteps: [
    "Download the Temurin 21 (LTS) JDK: https://adoptium.net/temurin/releases/?version=21",
    "Install it and ensure `java` is on PATH (set JAVA_HOME to the JDK folder).",
    "Verify: `java -version` shows 21.x.",
  ],
};

const python: DependencySpec = {
  id: "python",
  name: "Python 3.10+",
  purpose: "Runs the Ghidra MCP bridge and jadx MCP server",
  async detect(ctx): Promise<DepStatus> {
    // Prefer the py launcher on Windows, else python/python3.
    for (const [cmd, args] of [
      ["py", ["-3", "--version"]],
      ["python", ["--version"]],
      ["python3", ["--version"]],
    ] as const) {
      const v = await version(ctx, cmd, [...args]);
      const major = parseMajor(v);
      if (v && major !== undefined) {
        const minor = Number(v.split(".")[1] ?? "0");
        const ok = major > 3 || (major === 3 && minor >= 10);
        return {
          installed: ok,
          version: v,
          path: await which(cmd),
          detail: ok ? undefined : `Found Python ${v}; need 3.10+`,
        };
      }
    }
    return { installed: false };
  },
  async install(ctx): Promise<void> {
    await guardWinget(ctx, "Python.Python.3.12");
  },
  manualSteps: [
    "Install Python 3.10+ from https://www.python.org/downloads/ (tick 'Add to PATH').",
    "Verify: `python --version`.",
  ],
};

const uv: DependencySpec = {
  id: "uv",
  name: "uv (Astral)",
  purpose: "Installs and runs the jadx MCP server",
  async detect(ctx): Promise<DepStatus> {
    const v = await version(ctx, "uv", ["--version"]);
    return { installed: v !== undefined, version: v, path: await which("uv") };
  },
  async install(ctx): Promise<void> {
    await guardWinget(ctx, "astral-sh.uv");
  },
  manualSteps: [
    'Windows PowerShell: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"',
    "macOS/Linux: curl -LsSf https://astral.sh/uv/install.sh | sh",
    "Verify: `uv --version`.",
  ],
};

/** jshook requires Node >= 22.12; the installer itself only needs Node >= 20. */
const node2212: DependencySpec = {
  id: "node2212",
  name: "Node.js 22.12+",
  purpose: "Runs the jshook MCP server (hard engine requirement)",
  async detect(ctx): Promise<DepStatus> {
    const v = await version(ctx, "node", ["-v"]);
    const parts = (v ?? "").split(".").map(Number);
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    const ok = major > 22 || (major === 22 && minor >= 12);
    return {
      installed: ok,
      version: v,
      path: await which("node"),
      detail: ok ? undefined : `Found Node ${v}; jshook needs 22.12+`,
    };
  },
  async install(ctx): Promise<void> {
    await guardWinget(ctx, "OpenJS.NodeJS.LTS");
  },
  manualSteps: [
    "Install Node.js 22.12+ (LTS) from https://nodejs.org/ or via nvm.",
    "Verify: `node -v` shows v22.12+ (or v24+).",
  ],
};

const git: DependencySpec = {
  id: "git",
  name: "Git",
  purpose: "Lets uv install the jadx MCP server from GitHub",
  async detect(ctx): Promise<DepStatus> {
    const v = await version(ctx, "git", ["--version"]);
    return { installed: v !== undefined, version: v, path: await which("git") };
  },
  async install(ctx): Promise<void> {
    await guardWinget(ctx, "Git.Git");
  },
  manualSteps: [
    "Install Git from https://git-scm.com/download/win (or your package manager).",
    "Verify: `git --version`.",
  ],
};

export const DEPENDENCIES: Record<string, DependencySpec> = {
  [jdk21.id]: jdk21,
  [python.id]: python,
  [uv.id]: uv,
  [node2212.id]: node2212,
  [git.id]: git,
};

export function getDependency(id: string): DependencySpec {
  const dep = DEPENDENCIES[id];
  if (!dep) throw new Error(`Unknown dependency: ${id}`);
  return dep;
}
