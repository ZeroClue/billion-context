import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer, _resetChainWarningsForTest, _chainWarnSetForTest, WARNED_CHAIN_SESSION_CAP } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { peekSession, _resetSessionsForTest, flushAllSessions } from "../src/session.ts";
import { loadOptions, type ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

// #1101: the chain-detection content fallback (#1086/#1090) shipped with three
// disk-adjacent branches that no test executed — every integration test in
// issue1086-chain-self-exemption.test.ts injects a DISABLED store, so:
//   1. hasProcessedState's store.loadSync reload (session.ts, "covers the
//      auto-update restart") never ran — the restart ownership path (#1100)
//      was untested;
//   2. BILI_CHAIN_CONTENT env parsing (config.ts) was untested;
//   3. the warnedChainSessions FIFO eviction at WARNED_CHAIN_SESSION_CAP
//      (server.ts) was untested.
// This file covers exactly those three, on the real code paths.

const MODEL = "gpt-test";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function toolDecl(name: string): Record<string, unknown> {
    return { type: "function", function: { name, description: `${name} test tool`, parameters: { type: "object", properties: {} } } };
}

function historyCall(name: string, id: string): Record<string, unknown> {
    return { id, type: "function", function: { name, arguments: "{}" } };
}

// The #1086 incident shape: a bili-managed client whose history contains real
// invocations of both ACP tools — detectAcpArtifacts classifies it "tool-history".
function incidentBody(): string {
    return JSON.stringify({
        model: MODEL,
        stream: false,
        tools: [toolDecl("acp_status"), toolDecl("search_context")],
        messages: [
            { role: "system", content: "You are a test assistant." },
            { role: "user", content: "hello world, please help me with a task" },
            { role: "assistant", content: null, tool_calls: [historyCall("acp_status", "call_1"), historyCall("search_context", "call_2")] },
            { role: "tool", tool_call_id: "call_1", content: "ok" },
            { role: "tool", tool_call_id: "call_2", content: "ok" },
        ],
    });
}

function makeOpts(upstream: string, extra?: Partial<ProxyOptions>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream,
        routes: { [upstream]: { models: { [MODEL]: { context: 400_000 } } } } as ProxyOptions["routes"],
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
        ...extra,
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

type LogRec = { level: string; msg: string };
const chainWarns = (logs: LogRec[], sessionId?: string): LogRec[] =>
    logs.filter((l) => l.level === "warn" && l.msg.includes("[chain]") && (!sessionId || l.msg.includes(sessionId)));

test("#1101 restart path: persisted state survives memory reset — store.loadSync proves ownership, request is processed not passed through", async () => {
    // The auto-update restart scenario (#1100): memory is gone, the disk
    // record survives. The chain-detection exemption must consult
    // store.loadSync inside hasProcessedState and classify the re-sent ACP
    // artifacts as self-produced.
    const dir = mkdtempSync(join(tmpdir(), "bili-chain-t-restart-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`;
    try {
        // Phase 1: plain request (no artifacts) creates the session and its
        // processed-state evidence.
        const plain = JSON.stringify({ model: MODEL, stream: false, messages: [{ role: "user", content: "hello world" }] });
        const r1 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "restart-1" }, body: plain });
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(peekSession("restart-1")?.stats.requests, 1, "phase 1 must create local processed state");

        // Persist, then simulate the restart: memory map cleared, disk intact.
        await flushAllSessions();
        _resetSessionsForTest();
        assert.equal(peekSession("restart-1"), undefined, "memory must be empty after simulated restart");
        assert.notEqual(store.loadSync("restart-1"), null, "disk record must survive (precondition)");

        // Phase 2: the SAME conversation re-sends a body carrying ACP
        // artifacts. hasProcessedState must hit the store.loadSync branch
        // (memory miss), find the persisted evidence, and process normally —
        // NOT treat it as a foreign bili→bili chain.
        const raw = incidentBody();
        const r2 = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "restart-1" }, body: raw });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(captured.length, 2);
        assert.notEqual(sha(captured[1]!.body), sha(raw), "disk-backed ownership ⇒ kernel processes, not byte-identical passthrough");
        assert.equal(chainWarns(logs, "restart-1").length, 0, "no chain warn: loadSync found the persisted evidence");
        assert.ok((peekSession("restart-1")?.stats.requests ?? 0) >= 2, "session resurrected from disk via loadSync");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#1101 env: BILI_CHAIN_CONTENT parsing — env wins, file false honored, default on", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-chain-env-"));
    const saved = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = join(dir, "missing.json");
    try {
        assert.equal(loadOptions({}).chainContentDetection, true, "default ON with no env and no file");
        assert.equal(loadOptions({ BILI_CHAIN_CONTENT: "0" }).chainContentDetection, false, "BILI_CHAIN_CONTENT=0 disables the fallback");
        assert.equal(loadOptions({ BILI_CHAIN_CONTENT: "1" }).chainContentDetection, true, "BILI_CHAIN_CONTENT=1 keeps it on");

        const cfg = join(dir, "billion-context.json");
        writeFileSync(cfg, JSON.stringify({ chainContentDetection: false }));
        process.env.BILI_CONFIG_FILE = cfg;
        assert.equal(loadOptions({}).chainContentDetection, false, "file chainContentDetection:false honored when env unset");
        assert.equal(loadOptions({ BILI_CHAIN_CONTENT: "1" }).chainContentDetection, true, "env=1 wins over file false");
        assert.equal(loadOptions({ BILI_CHAIN_CONTENT: "0" }).chainContentDetection, false, "env=0 consistent with file false");
    } finally {
        if (saved === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = saved;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#1101 warn-set FIFO: crossing WARNED_CHAIN_SESSION_CAP evicts the oldest, the triggering session still warns once", async () => {
    // Enabled store over an empty dir (same as T3 in issue1086): the content
    // fallback requires getStore().enabled (server.ts seeds artifactSeed only
    // then — without a store "no local state" cannot distinguish a foreign
    // chain from this instance's own session after a restart), and a foreign
    // verdict is what drives the warn-set.
    const dir = mkdtempSync(join(tmpdir(), "bili-chain-t-fifo-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const warnSet = _chainWarnSetForTest();
    const oldest = "fifo-oldest";
    warnSet.add(oldest);
    for (let i = 0; warnSet.size < WARNED_CHAIN_SESSION_CAP; i++) warnSet.add(`fifo-fill-${i}`);
    assert.equal(warnSet.size, WARNED_CHAIN_SESSION_CAP);
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const raw = incidentBody();
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "fifo-new" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.equal(captured[0]!.body, raw, "foreign payload still passes through byte-identical");
        assert.ok(warnSet.has("fifo-new"), "the triggering session is recorded");
        assert.ok(!warnSet.has(oldest), "oldest entry evicted once the cap is exceeded (FIFO)");
        assert.equal(warnSet.size, WARNED_CHAIN_SESSION_CAP, "set stays capped");
        assert.equal(chainWarns(logs, "fifo-new").length, 1, "the new session still gets its exactly-one warn");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
});
