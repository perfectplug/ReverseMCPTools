# ReverseMCPTools

One-click installer that sets up **reverse-engineering MCP servers** for several
AI clients. SDKs, host applications, MCP servers, virtual environments and
package caches are kept in one shared managed root, and client configs use
absolute paths into that root.

Supported tools:

| Tool | MCP project | Host app | Runtime deps |
|------|-------------|----------|--------------|
| **Ghidra** | [LaurieWired/GhidraMCP](https://github.com/LaurieWired/GhidraMCP) | Ghidra 11.3.2 | JDK 21, Python 3.13, uv |
| **JADX** | [zinja-coder/jadx-ai-mcp](https://github.com/zinja-coder/jadx-ai-mcp) + jadx-mcp-server | jadx-gui 1.5.6 | JDK 21, Python 3.13, uv |
| **x64dbg** | [SetsunaYukiOvO/x64dbg-mcp](https://github.com/SetsunaYukiOvO/x64dbg-mcp) | x64dbg / x32dbg snapshot 2026.05.27 | Node 22 (stdio bridge) |
| **jshook** | [vmoranv/jshookmcp](https://github.com/vmoranv/jshookmcp) | none | Node 22 |

Supported MCP clients (one canonical `mcpServers` block, with per-client
transforms): **Claude Desktop, Cursor, Cline, Windsurf, Claude Code**.

## Usage

Run it without installing (once published to npm):

```bash
npx reverse-mcp-tools
```

Or from a clone:

```bash
npm install
npm run build
node dist/index.js
```

### Interactive

Running with no arguments (in a TTY) launches a picker for tools and clients:

```bash
reverse-mcp-tools
```

### Non-interactive

```bash
# Install specific tools into specific clients
reverse-mcp-tools install --tools x64dbg,jadx --clients cursor,claude-desktop

# Install everything supported on this OS into every detected client
reverse-mcp-tools install --all
# Without --tools-dir this uses the fixed managed directory under the OS temp folder

# Detect only — print manual dependency steps instead of auto-installing
reverse-mcp-tools install --tools ghidra --no-auto-deps

# See exactly what would change, touching nothing
reverse-mcp-tools install --all --dry-run

# Put every managed runtime/tool/cache in a chosen shared directory
reverse-mcp-tools --tools-dir D:\AI\ReverseMCPTools install --all
```

`REMCP_TOOLS_DIR` provides the same override for scripts and other AI tools:

```powershell
$env:REMCP_TOOLS_DIR = "D:\AI\ReverseMCPTools"
remcp install --all
```

### Other commands

```bash
reverse-mcp-tools list      # show available tools and clients
reverse-mcp-tools doctor    # report detected clients, runtime deps, recipe support
reverse-mcp-tools env       # print every path in the shared managed layout
reverse-mcp-tools env --json
```

## How it works

The installer is a **registry of recipes** — one per RE tool. Each recipe
(`src/recipes/*.ts`) declares its dependencies, performs its own tool-specific
placement (dropping a plugin, installing a bridge/server), and returns the MCP
server block(s) to register. The engine wires it together:

```
select tools → download portable SDKs/runtimes into shared root
             → install host tools + isolated MCP servers into shared root
             → merge absolute server commands into every client config
             → verify placements and print launchers/next steps
```

Adding a new tool (IDA, radare2, Binary Ninja, …) is a matter of writing one
recipe file and adding it to `src/recipes/registry.ts` — no engine changes.

### Dependencies

By default missing dependencies are downloaded as **portable managed runtimes**:
Temurin JDK 21, Python 3.13, uv and Node.js 22. They do not require `winget`, do
not modify the system PATH and are not installed into a user-wide Python/npm
environment. Git is not required; source-only MCP projects are downloaded as
GitHub snapshots.

Archives are downloaded atomically, checked against upstream SHA-256 metadata
when available, and extracted in the managed staging directory with path
traversal checks. ZIP and `tar.gz` extraction is bundled with the CLI; completed
runtimes are verified, marked and atomically promoted to their stable paths.

Pass `--no-auto-deps` to switch to detect-and-guide mode. Without an override,
the shared root is `%TEMP%\ReverseMCPTools` on Windows and
`${TMPDIR:-/tmp}/reverse-mcp-tools-<uid>` on Linux/macOS. Use `--tools-dir` or
`REMCP_TOOLS_DIR` to put it elsewhere. AI client configs contain absolute paths;
if the OS cleans the default temporary directory, run the installer again, or
choose a persistent path such as `D:\AI\ReverseMCPTools`.

### Shared directory layout

```text
<root>/
  runtimes/    # JDK 21, Python 3.13 and Node.js 22
  tools/       # uv, Ghidra, jadx and x64dbg
  servers/     # Ghidra/JADX bridges, pinned jshook and mcp-remote
  envs/        # isolated Python environments
  downloads/   # reusable, integrity-checked archives
  cache/       # uv, pip and npm caches
  staging/     # temporary/partial work
  state/       # resolved source/version metadata
  bin/         # shared launch helpers
```

Multiple AI clients configured with the same root reuse the same binaries,
environments and caches. Only each client's own MCP JSON file remains in that
client's standard configuration directory.

### Windows-specific handling

- **Claude Desktop MSIX/Store installs** are detected and the config is written to
  the virtualized `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\...` path, not just
  `%APPDATA%\Claude\`.
- **No runtime `npx` dependency**: jshook and `mcp-remote` are pinned and
  installed under the shared root, then launched with the absolute managed Node
  executable.
- **HTTP/SSE servers** (x64dbg) use the shared `mcp-remote` copy for stdio-only
  clients and a plain URL for clients that support remote transports.
- Existing configs are **backed up** (`*.remcp.bak`) before every write.

## Important notes

- Three of the four tools are **GUI-plugin hosted** (Ghidra, jadx-gui, x64dbg):
  the host app must be running **with a target loaded** or the MCP tools return
  nothing.
- Launch Ghidra and jadx with the generated managed launchers so they inherit the
  shared JDK and managed config/cache directories.
- These are offensive-security / dual-use tools. Only analyze software you own or
  are authorized to test, and run debuggers/instrumentation in a VM or sandbox.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
npm run dev         # watch build
npm test            # build + deterministic local tests
npm run check       # typecheck + tests
```

## License

MIT
