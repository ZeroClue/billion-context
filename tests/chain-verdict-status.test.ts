import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer, BILI_HOP_HEADER, _resetChainWarningsForTest } from "../src/server.ts";
import { CHAIN_VERDICT_CAP, _chainVerdictsForTest, _resetChainVerdictsForTest, _resetPluginStateForTest, recordChainVerdict } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { peekSession, _resetSessionsForTest } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { chainPassthroughNotice, chainPassthroughReason } from "../src/agent/shared.ts";

/** #1218: chain/content-fallback passthroughs create no local session, so /acp
 *  used to render the armed-idle "no model request yet" text — indistinguishable
 *  from a genuinely idle conversation (#1197 blind spot). The guard sites now
 *  record a verdict; the status endpoint reports it so clients can say WHY
 *  compression is not active. Layers under test:
 *   T1 unit: verdict store semantics (keys, latest scan, cap eviction)
 *   T2 unit: client notice rendering (reason → message)
 *   T3 http: foreign x-bili-hop → passthrough + verdict visible via status
 *   T4 http: self-loop marker → hop-self-loop verdict
 *   T5 http: ACP-artifact content fallback → content-fallback verdict
 *   T6 http: precedence — verdict beats pre-first-request runtime info; a live
 *            session beats its own stale verdict */

const MODEL = "gpt-test";

function makeOpts(upstream: string): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream,
        routes: { [upstream]: { models: { [MODEL]: { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        logFile: "off",
        mitm: { enabled: false, domains: [] },
    };
}

type Captured = { url: string; headers: http.IncomingHttpHeaders; body: string };

function makeUpstream(captured: Captured[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push({ url: req.url ?? "", headers: req.headers, body });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                model: MODEL,
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
}

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

type StatusJson = { ok?: boolean; phase?: string; panel?: string | null; error?: string; conversationId?: string; fallback?: boolean; chainVerdict?: { reason?: string; at?: number } };

async function status(port: number, conversationId: string, fallbackLatest = false): Promise<{ res: Response; json: StatusJson }> {
    const url = `http://127.0.0.1:${port}/__bili/plugin/status?conversationId=${encodeURIComponent(conversationId)}${fallbackLatest ? "&fallback=latest" : ""}`;
    const res = await fetch(url);
    return { res, json: (await res.json()) as StatusJson };
}

async function boot(enabledStore: boolean): Promise<{ proxy: Awaited<ReturnType<typeof startServer>>; upstream: http.Server; port: number; upPort: number }> {
    if (enabledStore) {
        const dir = mkdtempSync(join(tmpdir(), "bili-chain-verdict-"));
        _setStoreForTest(new SessionStore({ dir, debounceMs: 5, enabled: true }));
    } else {
        _setStoreForTest(new SessionStore({ enabled: false }));
    }
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    _resetChainVerdictsForTest();
    _resetPluginStateForTest();
    setRegistryForTest({});
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${upPort}`));
    await listen(proxy);
    const port = (proxy.address() as { port: number }).port;
    return { proxy, upstream, port, upPort };
}

test("#1218 T1: verdict store — key hygiene, latest scan, cap eviction", () => {
    _resetChainVerdictsForTest();
    recordChainVerdict(undefined, "hop-chain");
    recordChainVerdict("", "hop-chain");
    recordChainVerdict("   ", "hop-chain");
    assert.equal(_chainVerdictsForTest().size, 0, "empty keys must be dropped");

    recordChainVerdict("  cv-a ", "hop-chain");
    assert.ok(_chainVerdictsForTest().has("cv-a"), "whitespace-trimmed key stored");
    assert.equal(_chainVerdictsForTest().get("cv-a")?.reason, "hop-chain");

    recordChainVerdict("cv-b", "content-fallback");
    assert.equal(_chainVerdictsForTest().size, 2);

    for (let i = 0; i < CHAIN_VERDICT_CAP - 1; i++) recordChainVerdict(`filler-${i}`, "hop-chain");
    assert.equal(_chainVerdictsForTest().size, CHAIN_VERDICT_CAP, "map must stay bounded at the cap");
    assert.ok(_chainVerdictsForTest().has("cv-b"), "newest entries survive eviction");
});

test("#1218 T2: client notice rendering per reason", () => {
    assert.equal(chainPassthroughReason(undefined), undefined);
    assert.equal(chainPassthroughReason({ phase: "pre-first-request" }), undefined);
    assert.equal(chainPassthroughReason({ phase: "chain-passthrough" }), undefined, "missing chainVerdict.reason → no notice");
    assert.equal(chainPassthroughReason({ phase: "chain-passthrough", chainVerdict: { reason: "hop-chain" } }), "hop-chain");

    const selfLoop = chainPassthroughNotice("0.1.139", "hop-self-loop");
    assert.match(selfLoop, /billion-context@0\.1\.139/);
    assert.match(selfLoop, /compression NOT active/);
    assert.match(selfLoop, /self-loop/);
    assert.match(selfLoop, /\[chain\] warning/);

    const hopChain = chainPassthroughNotice(undefined, "hop-chain");
    assert.match(hopChain, /another bili instance/);
    assert.match(hopChain, /keep only one bili instance in the chain/);

    const content = chainPassthroughNotice("0.1.139", "content-fallback");
    assert.match(content, /ACP compression artifacts/);

    const unknown = chainPassthroughNotice("0.1.139", "something-new");
    assert.match(unknown, /chain guard/);
});

test("#1218 T3: foreign x-bili-hop → passthrough + verdict visible via status", async () => {
    const logs: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const b = await boot(false);
    try {
        const bodyJson = JSON.stringify({
            model: MODEL,
            stream: false,
            messages: [{ role: "user", content: "hello world" }],
        });
        const resp = await fetch(`http://127.0.0.1:${b.port}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-bili-plugin": "pi-plugin/0.0.1",
                "x-bili-plugin-conversation": "cv-hop",
                [BILI_HOP_HEADER]: "other-instance",
            },
            body: bodyJson,
        });
        assert.equal(resp.status, 200);
        await resp.text();

        // The request passed through verbatim and left no local session…
        assert.equal(peekSession("cv-hop"), undefined, "hop-marked requests must not create sessions");
        const warns = logs.filter((l) => l.level === "warn" && l.msg.includes("[chain]"));
        assert.equal(warns.length, 1, "exactly one [chain] warn");

        // …but the verdict IS reported by the status endpoint.
        const hit = await status(b.port, "cv-hop");
        assert.equal(hit.res.status, 200);
        assert.equal(hit.json.ok, true);
        assert.equal(hit.json.phase, "chain-passthrough");
        assert.equal(hit.json.panel, null);
        assert.equal(hit.json.conversationId, "cv-hop");
        assert.equal(hit.json.chainVerdict?.reason, "hop-chain");
        assert.equal(typeof hit.json.chainVerdict?.at, "number");
        assert.equal(hit.json.fallback, undefined, "chain-passthrough must not set the MCP adoption flag");

        // Unknown conversation without fallback stays a 404 (no cross-talk)…
        const miss = await status(b.port, "never-seen");
        assert.equal(miss.res.status, 404);
        // …and with fallback=latest resolves to the most recent verdict.
        const fb = await status(b.port, "never-seen", true);
        assert.equal(fb.res.status, 200);
        assert.equal(fb.json.phase, "chain-passthrough");
        assert.equal(fb.json.conversationId, "cv-hop");
        assert.equal(fb.json.chainVerdict?.reason, "hop-chain");
        assert.equal(fb.json.fallback, undefined);
    } finally {
        setLogCapture(null);
        b.proxy.closeAllConnections?.();
        await close(b.proxy);
        b.upstream.closeAllConnections?.();
        await close(b.upstream);
    }
});

test("#1218 T4: self-loop marker → hop-self-loop verdict keyed on client header", async () => {
    setLogCapture(null);
    const b = await boot(false);
    try {
        const health = (await (await fetch(`http://127.0.0.1:${b.port}/__bili/health`)).json()) as { instanceId?: string };
        assert.ok(health.instanceId, "health exposes the instance id");
        const resp = await fetch(`http://127.0.0.1:${b.port}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-session-id": "cv-selfloop",
                [BILI_HOP_HEADER]: health.instanceId!,
            },
            body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        const hit = await status(b.port, "cv-selfloop");
        assert.equal(hit.res.status, 200);
        assert.equal(hit.json.phase, "chain-passthrough");
        assert.equal(hit.json.chainVerdict?.reason, "hop-self-loop");
    } finally {
        b.proxy.closeAllConnections?.();
        await close(b.proxy);
        b.upstream.closeAllConnections?.();
        await close(b.upstream);
    }
});

test("#1218 T5: ACP-artifact content fallback → content-fallback verdict", async () => {
    setLogCapture(null);
    const b = await boot(true);
    try {
        const raw = JSON.stringify({
            model: MODEL,
            stream: false,
            tools: [
                { type: "function", function: { name: "acp_status", description: "d", parameters: {} } },
                { type: "function", function: { name: "search_context", description: "d", parameters: {} } },
            ],
            messages: [
                { role: "system", content: "You are a test assistant." },
                { role: "assistant", content: null, tool_calls: [
                    { id: "c1", type: "function", function: { name: "acp_status", arguments: "{}" } },
                    { id: "c2", type: "function", function: { name: "search_context", arguments: "{}" } },
                ] },
                { role: "tool", tool_call_id: "c1", content: "ok" },
                { role: "tool", tool_call_id: "c2", content: "ok" },
                { role: "user", content: "next question" },
            ],
        });
        const resp = await fetch(`http://127.0.0.1:${b.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "cv-cf" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();

        // Foreign artifacts + no local state ⇒ byte-identical passthrough, no session…
        assert.equal(peekSession("cv-cf"), undefined);
        // …but the verdict is reported.
        const hit = await status(b.port, "cv-cf");
        assert.equal(hit.res.status, 200);
        assert.equal(hit.json.phase, "chain-passthrough");
        assert.equal(hit.json.chainVerdict?.reason, "content-fallback");
    } finally {
        b.proxy.closeAllConnections?.();
        await close(b.proxy);
        b.upstream.closeAllConnections?.();
        await close(b.upstream);
    }
});

test("#1218 T6: precedence — verdict beats runtime info; live session beats verdict", async () => {
    setLogCapture(null);
    const b = await boot(false);
    try {
        // dsh probes with its agent name; bootstrap runtime info lands there.
        const ri = await fetch(`http://127.0.0.1:${b.port}/__bili/plugin/runtime-info`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: "dsh-t6", model: MODEL, contextWindow: 100000 }),
        });
        assert.equal(ri.status, 200);
        await ri.text();
        const pre = await status(b.port, "dsh-t6");
        assert.equal(pre.json.phase, "pre-first-request", "baseline: runtime info answers pre-first-request");

        recordChainVerdict("dsh-t6", "hop-chain");
        const after = await status(b.port, "dsh-t6");
        assert.equal(after.res.status, 200);
        assert.equal(after.json.phase, "chain-passthrough", "verdict must beat the pre-first-request view");
        assert.equal(after.json.chainVerdict?.reason, "hop-chain");

        // A real processed session beats any stale verdict recorded for it.
        const chat = await fetch(`http://127.0.0.1:${b.port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "cv-live" },
            body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(chat.status, 200);
        await chat.text();
        recordChainVerdict("cv-live", "content-fallback");
        const live = await status(b.port, "cv-live");
        assert.equal(live.res.status, 200);
        assert.equal(live.json.ok, true);
        assert.equal(live.json.phase, undefined, "live session renders the normal status, not the stale verdict");
        assert.equal(typeof live.json.panel, "string");
    } finally {
        b.proxy.closeAllConnections?.();
        await close(b.proxy);
        b.upstream.closeAllConnections?.();
        await close(b.upstream);
    }
});
