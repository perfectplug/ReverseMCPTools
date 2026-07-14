# ReverseMCPTools

One-click installer that sets up **reverse-engineering MCP servers** into your MCP
clients. Point it at your machine and it installs the tools, wires up the runtime
dependencies, and writes the client config for you.

Supported tools:

| Tool | MCP project | Host app | Runtime deps |
|------|-------------|----------|--------------|
| **Ghidra** | [LaurieWired/GhidraMCP](https://github.com/LaurieWired/GhidraMCP) | Ghidra 11.3.2 | JDK 21, Python |
| **JADX** | [zinja-coder/jadx-ai-mcp](https://github.com/zinja-coder/jadx-ai-mcp) + jadx-mcp-server | jadx-gui | JDK 21, Python, uv, Git |
| **x64dbg** | [SetsunaYukiOvO/x64dbg-mcp](https://github.com/SetsunaYukiOvO/x64dbg-mcp) | x64dbg / x32dbg | none (native plugin) |
| **jshook** | [vmoranv/jshookmcp](https://github.com/vmoranv/jshookmcp) | none | Node 22.12+ |

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

# Detect only — print manual dependency steps instead of auto-installing
reverse-mcp-tools install --tools ghidra --no-auto-deps

# See exactly what would change, touching nothing
reverse-mcp-tools install --all --dry-run
```

### Other commands

```bash
reverse-mcp-tools list      # show available tools and clients
reverse-mcp-tools doctor    # report detected clients, runtime deps, recipe support
```

## How it works

The installer is a **registry of recipes** — one per RE tool. Each recipe
(`src/recipes/*.ts`) declares its dependencies, performs its own tool-specific
placement (dropping a plugin, installing a bridge/server), and returns the MCP
server block(s) to register. The engine wires it together:

```
select tools → ensure deps (winget / downloads) → recipe.install() → merge servers
             → write each client config (with backup) → print next steps
```

Adding a new tool (IDA, radare2, Binary Ninja, …) is a matter of writing one
recipe file and adding it to `src/recipes/registry.ts` — no engine changes.

### Dependencies

By default missing runtime dependencies are **auto-installed** (via `winget` on
Windows; JDK 21, Python, Node 22.12+, uv, Git). Pass `--no-auto-deps` to switch to
**detect-and-guide**: the tool checks what's present and prints exact manual steps
for anything missing. Heavy, version-locked host apps (Ghidra, x64dbg, jadx-gui)
are downloaded to a managed folder (`%LOCALAPPDATA%\ReverseMCPTools`) at the
version each MCP plugin expects.

### Windows-specific handling

- **Claude Desktop MSIX/Store installs** are detected and the config is written to
  the virtualized `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\...` path, not just
  `%APPDATA%\Claude\`.
- **`npx` servers** are wrapped as `cmd /c npx -y …` for Claude Code / Claude
  Desktop, because Node cannot spawn the `npx.cmd` shim directly.
- **HTTP/SSE servers** (x64dbg) are bridged through `npx mcp-remote` for
  stdio-only clients (Claude Desktop) and passed as a plain URL to clients that
  speak remote transports.
- Existing configs are **backed up** (`*.remcp.bak`) before every write.

## Important notes

- Three of the four tools are **GUI-plugin hosted** (Ghidra, jadx-gui, x64dbg):
  the host app must be running **with a target loaded** or the MCP tools return
  nothing.
- These are offensive-security / dual-use tools. Only analyze software you own or
  are authorized to test, and run debuggers/instrumentation in a VM or sandbox.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # compile to dist/
npm run dev         # watch build
```

## License

MIT
