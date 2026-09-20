# OpenCode v2 Version Compatibility

This document describes the billion-context plugin's compatibility with different OpenCode v2 versions. The plugin uses **structural typing only** (no `@opencode/plugin` import) to remain loadable across all observed host generations.

## Version Matrix

| OpenCode Version | Plugin Entry Point | `ctx.tool` | `ctx.session` | `ctx.command` | `ctx.catalog` | `ctx.event` | Notes |
|------------------|-------------------|------------|---------------|---------------|---------------|-------------|-------|
| **next-17444** (pre-release) | `server()` only | ❌ | ❌ | list/get/update/remove only (no ADD) | ✅ | ❌ | `model.request` registers but NEVER FIRES; `http.request` fires |
| **2.0.x stable** (2.0.1, 2.0.3) | `setup()` chosen | ✅ `{reload, transform, hook}` | ✅ | ✅ `transform(editor.add)` works | ✅ | ✅ | Full plugin mode verified; `reload` exists |
| **dev builds** (2026-09-13) | `server()` only | ❌ | ❌ | ❌ | ❌ | ❌ | Loads plugins via V1 only |
| **dev builds** (2026-09-14) | `setup()` exposed | ❌ | ❌ | ❌ | ❌ | ❌ | `setup()` exists but no `ctx.session` / `ctx.tool` |

## Plugin Behavior by Version

### next-17444 (pre-release)
- **Entry point**: `server()` (V1 API)
- **Tool registration**: NOT available via `ctx.tool.transform` — tools registered via bundled schemas only
- **Commands**: Cannot add slash commands (`editor.add` not available) — `/acp` unavailable in V2
- **Hooks**: `http.request` fires per outgoing request; `e.request.headers` mutation reaches wire
- **Workaround**: `acp_status` tool is the in-host equivalent of `/acp`

### 2.0.x Stable (2.0.1, 2.0.3) — **Recommended**
- **Entry point**: `setup()` (V2 API) — chosen over `server()`
- **Tool registration**: Full `ctx.tool.transform(editor.add)` works — native ACP tools registered
- **Commands**: `ctx.command.transform(editor.add)` CAN add commands (TUI needs Tab+Enter completion accept)
- **Hooks**: Both `model.request` and `http.request` fire; `e.request` mutation reaches wire
- **Reload**: `ctx.tool.reload()` EXISTS — can refresh tools dynamically
- **Plugin installation**: Must be a **directory** (file paths rejected with WARN)
- **Launcher handling**: `src/launcher.ts` wraps the single file as a directory via `opencodeMajorVersion`

### Dev Builds (unstable)
- Inconsistent between adjacent builds
- Plugin may load but be non-functional (missing `ctx.session`, `ctx.tool`)
- **Not supported** — use stable releases

## Design Principles

### 1. Inert-Safe by Default
Every registration uses optional chaining (`?.`) so the plugin is **inert-safe** on any surface:
```typescript
const toolReg = await ctx.tool?.transform?.((editor) => { ... });
const hookReg = await ctx.session?.hook?.("http.request", ...);
```
When no seam fires, sessions **transparently run in proxy mode** (wire-level tool injection) instead of failing.

### 2. Synchronous Tool Registration
Tools stay registered **synchronously from bundled schemas** (exact parity with proxy's OpenAI tool list in `src/compress-tool.ts`) because `reload`-based refresh is not available on all observed surfaces.

### 3. Dual Export for V1/V2
The plugin exports both entry points for maximum compatibility:
```typescript
export default { 
    id: "billion-context-opencode", 
    setup,    // V2 API
    server    // V1 API (OpenCode >= 1.18.29)
};
```

## Verification Commands

```bash
# Check which entry point is being used (run in OpenCode with plugin installed)
# V2: setup() fires, tools registered via ctx.tool.transform
# V1: server() fires, tools registered via command.execute.before

# Verify tool registration
grep -A3 "ctx.tool.transform" src/agent/opencode.ts

# Verify V2 entry point
grep -A5 "const setup = async" src/agent/opencode.ts

# Verify V1 entry point
grep -A5 "const server = async" src/agent/opencode.ts
```

## Version Detection (Launcher)

The launcher (`src/launcher.ts`) detects the OpenCode major version and wraps the plugin accordingly:

```typescript
// opencodeMajorVersion() returns "1" or "2"
// V2: wraps plugin file in a directory with index.js
// V1: uses file path directly
```

## Known Limitations

1. **No dynamic tool reload** on pre-2.0.x versions — tools registered once at startup from bundled schemas
2. **Slash commands unavailable** on next-17444 — use `acp_status` tool instead
3. **Dev builds unstable** — adjacent builds disagree on API surface; not supported
4. **Plugin must be directory** for 2.0.x — launcher handles this automatically

## Recommendation

**Use OpenCode 2.0.x stable** (2.0.1+) for full plugin functionality:
- Native ACP tool registration
- Dynamic tool reload capability
- Slash command support
- Full hook coverage (`model.request` + `http.request`)

The launcher (`bili opencode`) automatically handles version-specific wrapping.

## Source References

- Plugin implementation: `src/agent/opencode.ts` (lines 141-177 for version notes)
- Launcher version detection: `src/launcher.ts` (search for `opencodeMajorVersion`)
- Bundled tool schemas: `src/compress-tool.ts`