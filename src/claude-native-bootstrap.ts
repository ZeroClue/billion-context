// #964 claude native bootstrap — the SessionStart hook command written into
// ~/.claude/settings.json by `bili plugin install claude`. Claude Code has no
// in-process extension point (hooks and MCP servers are child processes), so
// the native posture is a documented hybrid:
//
//   1. the installer pins env.ANTHROPIC_BASE_URL to a STABLE loopback port
//      (resolveClaudeNativePort: BILI_CLAUDE_NATIVE_PORT > config
//      claude.nativePort > 48787) with a /bili/-wrapped upstream — full
//      traffic visibility without MITM;
//   2. THIS hook (fired before the first model request) makes sure a proxy
//      is listening there: attach to a healthy compatible one, else spawn one
//      detached whose parent-pid watchdog watches CLAUDE's pid (resolved by
//      walking past the transient `/bin/sh -c` hook wrapper — the hook itself
//      exits immediately) so the proxy lives and dies with the session;
//   3. the MCP shim (dist/mcp.js, registered user-scope, pinned to the same
//      stable port) provides the native compress/decompress/acp_status tools
//      and identity-registers the conversation (CLAUDE_CODE_SESSION_ID =
//      x-claude-code-session-id on every request — the proxy's existing
//      plugin-mode gating, #162/#268; zero new protocol surface).
//
// Opt-out BILI_NATIVE_CLAUDE=0 (or the global BILLION_CONTEXT_PLUGIN=0):
// the hook still answers the now-static URL — by spawning a PASSTHROUGH-mode
// proxy on the same port (verbatim forward, compression off) so claude stays
// fully functional (#964 Q2). A launch that already owns routing
// (BILLION_CONTEXT_PROXY set — `bili claude` overrides the static URL with
// its own ephemeral proxy) needs nothing: exit 0 immediately.
//
// The hook must NEVER fail claude: every error prints to stderr and exits 0.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "./launcher.js";
import { resolveClaudeNativePort } from "./config.js";
import { nativeBootstrapGate, proxyEnvOrigin } from "./agent/native-bootstrap.js";

/** dist/claude-native-bootstrap.js → sibling dist/index.js (the package
 *  bin). ensureProxyRunning's default (process.argv[1]) would re-invoke THIS
 *  hook script as the proxy — infinite self-spawn. */
function proxyScriptPath(): string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
}

function log(msg: string): void {
    process.stderr.write(`[bili-claude-bootstrap] ${msg}\n`);
}

/** Pure decision (#964): what this hook does under the given environment.
 *  Exported for tests.
 *   - "exit": someone else owns routing (BILLION_CONTEXT_PROXY /
 *     BILI_PROVIDER_REWRITES) — spawn nothing.
 *   - "passthrough": opted out (BILI_NATIVE_CLAUDE=0 /
 *     BILLION_CONTEXT_PLUGIN=0) — serve the static URL verbatim-forward.
 *   - "start": bring up (or attach to) the compression proxy. */
export function planClaudeNativeBootstrap(env: NodeJS.ProcessEnv): { action: "exit" | "passthrough" | "start"; port: number } {
    const port = resolveClaudeNativePort(env);
    if (proxyEnvOrigin(env) !== undefined) return { action: "exit", port };
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_CLAUDE === "0") return { action: "passthrough", port };
    if (!nativeBootstrapGate(env, "BILI_NATIVE_CLAUDE")) return { action: "exit", port };
    return { action: "start", port };
}

// — claude host pid resolution ———————————————————————————————
// claude (2.x) runs SessionStart hooks as `/bin/sh -c <command>`: the hook's
// DIRECT parent is a transient sh that dies the moment the hook exits. A
// proxy watchdog pointed at that parent self-kills ~2s into every session
// (live "parent-gone (pid N)" failures) while claude itself lives on.

const CLAUDE_HOST_MAX_WALK = 8;

/** One /proc/<pid> snapshot. argv is null when cmdline is empty (zombies,
 *  kernel threads) — the ppid chain still walks through those. null return
 *  means the pid is gone (or /proc does not exist — non-linux callers fall
 *  back to the legacy direct parent). */
type ProcInfo = { argv: string[] | null; ppid: number | null };

type ProcReader = (pid: number) => ProcInfo | null;

function readProcInfo(pid: number): ProcInfo | null {
    let argv: string[] | null = null;
    let ppid: number | null = null;
    try {
        const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((p) => p.length > 0);
        if (parts.length > 0) argv = parts;
    } catch {
        return null;
    }
    try {
        // comm can contain spaces and parens — only the text after the LAST
        // ')' is positional; field 2 of the remainder is ppid.
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (tail.length > 1) ppid = Number(tail[1]);
    } catch {
        // stat unreadable: stop the walk after this hop
    }
    return { argv, ppid };
}

/** Is this argv the claude-code session binary? Matches `claude`/`claude.exe`
 *  and `node .../claude...` installs (`@anthropic-ai/claude-code` paths or a
 *  bare `claude` argument). Must NOT match this hook's own script
 *  (claude-native-bootstrap.js) or wrappers like `timeout 40 claude` /
 *  `sh -c ...` (their argv[0] is not claude). Exported for tests. */
export function isClaudeHostArgv(argv: string[]): boolean {
    const base = (p: string): string => {
        const parts = p.split(/[\\/]/).filter((seg) => seg.length > 0);
        return parts[parts.length - 1] ?? "";
    };
    if (/^claude(\.exe)?$/i.test(base(argv[0] ?? ""))) return true;
    if (/^(node|bun|deno)(\.exe)?$/i.test(base(argv[0] ?? ""))) {
        return argv.slice(1).some((arg) => /^claude(\.exe)?$/i.test(base(arg)) || /@anthropic-ai[\\/]claude-code/.test(arg));
    }
    return false;
}

/** The claude session process that transitively owns this hook, found by
 *  walking up from `startPid` (default: this hook) through /proc. undefined
 *  when no claude host sits within CLAUDE_HOST_MAX_WALK hops — callers then
 *  fall back to the legacy direct parent (strictly no worse than before).
 *  Exported for tests (inject `read` to stub /proc). */
export function resolveClaudeHostPid(opts: { read?: ProcReader; startPid?: number } = {}): number | undefined {
    const read = opts.read ?? readProcInfo;
    let pid = opts.startPid ?? process.pid;
    for (let hop = 0; hop < CLAUDE_HOST_MAX_WALK; hop++) {
        const info = read(pid);
        if (info === null) return undefined;
        if (info.argv !== null && isClaudeHostArgv(info.argv)) return pid;
        if (info.ppid === null || info.ppid <= 1) return undefined;
        pid = info.ppid;
    }
    return undefined;
}

async function run(): Promise<void> {
    const plan = planClaudeNativeBootstrap(process.env);
    if (plan.action === "exit") return;
    try {
        // The direct parent is the transient `/bin/sh -c` wrapper claude used
        // to launch this hook — it exits with the hook, and a watchdog on it
        // killed a healthy proxy ~2s into every session. Watch the claude
        // host itself; fall back to the direct parent only when the walk
        // above cannot find it.
        const handle = await ensureProxyRunning(
            {
                host: LAUNCHER_DEFAULT_HOST,
                port: plan.port,
                passthrough: plan.action === "passthrough",
                debug: false,
                parentPid: resolveClaudeHostPid() ?? process.ppid,
                strictPort: true,
            },
            { scriptPath: proxyScriptPath() },
        );
        log(`proxy ${handle.attached ? "attached" : "started"} at ${handle.origin}${plan.action === "passthrough" ? " (passthrough — compression off)" : ""}`);
    } catch (err) {
        log(
            `proxy bring-up failed on port ${plan.port} — ${err instanceof Error ? err.message : String(err)}` +
                (plan.action === "start" ? ` — claude will fail its model calls until this is fixed (free the port or set BILI_CLAUDE_NATIVE_PORT, then reinstall: bili plugin install claude)` : ""),
        );
    }
}

function hookMain(): void {
    // Drain the hook's stdin payload (session_id etc.) — claude waits for
    // this process to exit; we never read the payload, but draining avoids a
    // blocked writer if the payload ever exceeds the socket buffer.
    process.stdin.resume();
    void run().finally(() => {
        process.stdin.destroy();
        process.exit(0);
    });
}

// Direct entry (dist/claude-native-bootstrap.js spawned by claude's hook, or
// the ts source under tsx in tests): run only when invoked as the script
// itself, never when imported for planClaudeNativeBootstrap.
if (process.argv[1] && /claude-native-bootstrap\.(?:ts|js)$/.test(process.argv[1])) {
    hookMain();
}
