# billion-context — architecture reference

> Split from AGENTS.md (2026-09-25, /init-agents v1.0). Lazy companion: load when
> touching `src/loop/`, wire adapters, preflight/compact paths, session/ref logic,
> or reasoning about the two compression modes. Update when the area changes.

## Tech Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript (strict, ESM) |
| Build | tsup (bundling, inlines acp-kernel) |
| Test | Node.js built-in: `node --import tsx --test tests/*.test.ts` |
| Runtime Dep | `acp-kernel` (bundled at build time) + `zod` (external, only used by `dist/agent/opencode-native.js` V1 tools; `dist/index.js` stays dependency-free) |

## Module Map (curated; full discovery via `.codegraph/` — `codegraph explore "<symbol>"`)

```
src/
├── index.ts                  # Entry: runs cli.ts main()
├── cli.ts                    # CLI dispatcher: start/update/export/test/plugin + client launchers
├── server.ts                 # HTTP proxy server, request pipeline (+ server/ submodules)
├── config.ts / config-env.ts # Config loading (file + env + CLI flags)
├── logger.ts                 # Tee logger: file (~/.local/state/) + stderr
├── paths.ts                  # XDG paths (config/cache/state dirs)
├── session.ts / session-id.ts # Session model + in-memory store + id generation
├── persist.ts                # On-disk session persistence (kernel StateStore)
├── update.ts                 # Auto-update: checks npm, auto-installs latest
├── launcher.ts               # `bili <client>` launchers (pi/codex/claude/omp/opencode/hermes/dsh/codebuddy/qoder/trae/jcode/kimi)
├── client-config.ts          # READ-only discovery of each client's upstream config
├── mitm.ts / ca.ts           # Cert-MITM proxying + lazily generated root CA
├── mcp.ts                    # Plugin-in-launcher MCP shell (spawn-time injection)
├── plugin.ts / plugin-install.ts # Cooperative plugin protocol + `bili plugin install`
├── registry.ts               # models.dev context-window registry (snapshot-first)
├── registry-snapshot.json / codex-models-snapshot.json # Bundled offline floors
├── upstream-proxy.ts         # undici ProxyAgent routing (https_proxy for registry fetch)
├── stream*.ts / sse-util.ts  # SSE utilities + per-wire processing (openai/responses/google/terminal) + tag patching
├── loop/                     # Unified compress loop (wire-agnostic core)
│   ├── core.ts               #   protocol-neutral event model + tool adjudication
│   ├── adapter-anthropic.ts / adapter-openai.ts / adapter-responses.ts / adapter-google.ts
│   ├── tag-echo-filter.ts
│   └── index.ts
├── compress-loop.ts / compress-loop-responses.ts # Compress loops (OpenAI chat / Responses API)
├── compress-settings.ts      # Three-level compress config merge
├── compress-tool.ts          # compress tool parsing (kernel parseCompressArgs)
├── decompress-shared.ts / orphan-gc.ts / preflight.ts / absorb.ts / codex-compact.ts
├── agent/                    # Thin agent-side plugins
│   # opencode-acp-command.ts = shared /acp hooks V1+V2; opencode-native.ts = self-spawn
│   # native (V1 `.server()` + V2 `setup`); opencode-v2.ts = OpenCode V2 plugin;
│   # opencode-tui.tsx = TUI [WIP — untracked, in progress]; plus pi/omp/dsh native+legacy
├── web/                      # Web UI (fork: English dashboard) — page.ts, client.ts, api.ts
├── metrics.ts / analytics.ts # Fork: metrics API + SQLite analytics
├── fetch-util.ts / util.ts  # Misc utilities
tests/                        # 235 test files; e2e/ = real-codex regression suite
```

## Key Design Decisions

1. **acp-kernel is bundled inline** — tsup does NOT list it in `external`, so `dist/index.js` is self-contained. Exception: `zod` (exact `4.1.8`, matching the opencode host's own zod so V1 plugin-tool shapes interoperate) is a real dependency and stays external — only `dist/agent/opencode-native.js` imports it (lazily, at plugin-tool registration); `dist/index.js` and every other entry remain zod-free. When zod cannot be resolved at runtime the V1 plugin degrades to plain proxy mode instead of failing.
2. **Tags use XML format** `<acp tokens="2" type="text">m00001</acp>` — written with hex escapes (`\x3c`, `\x3e`) in source files to avoid Write/Edit tool stripping.
3. **Auto-update**: checks npm registry every 3 min (`CHECK_INTERVAL_MS = 3*60*1000`), first check per process ignores throttle.
4. **Tee logger**: all proxy logs go through `src/logger.ts` (file + stderr). Do NOT use `console.error` in server-side modules — use `loggerLog()`.
5. **acp-kernel MUST be pinned to an exact version** (e.g. `"acp-kernel": "0.0.80"`, NEVER `"^0.0.80"`). Because acp-kernel is a build-time dependency that tsup bundles inline into `dist`, a caret range makes the resolved version drift if `package-lock.json` is regenerated or absent, breaking reproducible builds. When bumping acp-kernel: set the exact version in `package.json`, run `npm install` to refresh the lockfile, then rebuild. The `package-lock.json` is committed and kept in sync.
6. **Single-writer plugin copies (#991)** — every bili presence has exactly one writer. Host-managed copies (pi's npm entry, opencode's plugin dir, dsh profile bundles in pnpm's store) are NEVER overwritten in place by bili: `src/update.ts` → `hostManagedInstall()` detects pnpm virtual-store (`.pnpm`) and host-home trees (pi/opencode/dsh/kimi/omp) and the self-updater skips them; `installViaTarball` refuses them structurally. Reference lanes (omp/claude/codex/kimi) point at the global install and update with it. `bili plugin update [agent]` drives each lane through its own owner. Mixing user commands is fine (they share channels); mixing writers is what the guard forbids.
7. **Two compression modes with different summary carriers** — `pluginMode` (the `x-bili-plugin` header / registered agent, e.g. `bili pi`) means the ACP-native agent OWNS compression: it executes `compress` locally, the call+result live in its own re-sent history, and the summary carrier on the wire is the **tool call** (the proxy suppresses tool + nudge injection; the agent's view never renders the kernel's `acp_summary`). Proxy mode (plain client, no header) means the proxy executes `compress` server-side: the tool call is ephemeral (never enters the client's history) and preflight blocks have none, so the summary carrier is the **`acp_summary` message**, which the kernel renders as role `system` but `systemToUser` (`src/util.ts`) re-voices as a **`user` message** (leaving it at its anchor) so strict backends (SGLang: exactly one system at index 0, #377) accept it and the head system message stays byte-stable for the prefix cache. The mode is decided per request and bound per session (`session.metadata.pluginAgent`, sticky, upgrade-only). See README "Two compression modes".

## Kernel Contract: Message Ids Are Never Reused

The kernel (`acp-kernel`) guarantees, and billion-context RELIES on: within a
session, a raw content-hash id and a ref number (`mNNNNN`) denote exactly one
message forever — **never reused, never duplicated**, even after the message
dies (edited/truncated/folded). The model can cite any number it has ever
seen (summaries cite tags across turns), so a re-issued number silently
misattributes on decompress. Consequences for this repo:

- Host code must NOT prune/repack `session.state.messageRefs` in ways that
  let a freed number be re-issued (kernel `assignRefsNode` computes its
  cursor as `highestUsedIndex(map)+1`, so shrinking the map can drop the
  cursor and re-issue numbers).
- Known residual: `applyCompactionArchive` (#421, `src/session.ts`) prunes
  `byRaw/byRef` to live raw ids on native-compaction boundaries. In practice
  the highest-numbered (newest) messages stay resident so the cursor does not
  drop, but this is a theoretical re-issue window — drop the map-prune once
  the kernel's ref-space widening (post-#191 direction) makes it unnecessary.
- Historical note: kernel 0.0.48/0.0.49 briefly contained ref-slot reclamation
  (reverted in kernel #191, see `persist/store.ts`). The old "do not bump
  past 0.0.47" guard is obsolete — master pins `0.0.80`.

## Before Making Changes (contributing)

1. `npm run typecheck` — no type errors
2. `npm test` — all tests pass
3. Understand the module dependency graph
4. **Consider BOTH compression modes** — any change touching the wire (message
   rebuild, system/developer handling, tool injection, `acp_summary` stripping,
   preflight, nudge) must be reasoned about in BOTH plugin mode (carrier = the
   agent's `compress` tool call; proxy suppresses injection) and proxy mode
   (carrier = the `acp_summary` message re-voiced as `user` by `systemToUser`;
   proxy executes `compress` server-side). A change correct in one mode can
   break the other (#377 only manifested in proxy mode). See README "Two
   compression modes" and the `pluginMode` comment in `src/server.ts`.
