// #1271: CCR enablement on host lanes (plugin mode). Covers the two NEW decision
// surfaces plus the round-trip:
//   1. the manifest advertises acp_retrieve ONLY while CCR is enabled (#1192
//      conservative rule) and only on the wires whose prepare* can ride the full
//      original back (anthropic/openai) — never responses;
//   2. the plugin-mode arming gate scopes CCR to exactly those wires, so a
//      placeholder is never emitted on a wire that cannot round-trip it
//      (silent loss, #1097);
//   3. a plugin-lane e2e proving an oversized tool result is stored + placeholdered
//      on the wire, then acp_retrieve rides the full original back on the next
//      forward (request-only, never persisted).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { ccrEnabled, ccrPluginWireOk, contentStoreOf, executeRetrieve, PLUGIN_CCR_WIRES, retrieveToolName } from "../src/store.ts";
import { handlePluginManifest } from "../src/plugin.ts";

const MODEL = "test-model";
const BIG_TEXT = "line of build output ".repeat(400);

// — manifest advertising (acceptance: "advertises only while enabled", #1192) —

function readManifest(config: Parameters<typeof handlePluginManifest>[1]): { toolNames: string[]; tools: Record<string, unknown[]> } {
    let body = "";
    const res = { writeHead: () => {}, end: (b: string) => { body = b; } } as unknown as Parameters<typeof handlePluginManifest>[0];
    handlePluginManifest(res, config);
    return JSON.parse(body) as { toolNames: string[]; tools: Record<string, unknown[]> };
}

function namesOnWire(wire: unknown[]): string[] {
    return wire.map((t) => {
        const o = t as Record<string, unknown>;
        return typeof o.name === "string" ? o.name : String((o.function as { name?: unknown } | undefined)?.name ?? "");
    });
}

test("handlePluginManifest: acp_retrieve NOT advertised by default (CCR off)", () => {
    const m = readManifest(defaultConfig(200_000));
    assert.ok(!m.toolNames.includes("acp_retrieve"), "default config must not advertise acp_retrieve");
    for (const wire of ["anthropic", "openai", "responses"]) {
        assert.ok(!namesOnWire(m.tools[wire] ?? []).includes("acp_retrieve"), `${wire} must not carry acp_retrieve when CCR off`);
    }
});

test("handlePluginManifest: acp_retrieve advertised on anthropic+openai only when CCR enabled", () => {
    const m = readManifest({ ...defaultConfig(200_000), ccr: { enabled: true } });
    assert.ok(m.toolNames.includes("acp_retrieve"), "enabled CCR advertises acp_retrieve");
    assert.ok(namesOnWire(m.tools.anthropic).includes("acp_retrieve"), "anthropic wire carries acp_retrieve");
    assert.ok(namesOnWire(m.tools.openai).includes("acp_retrieve"), "openai wire carries acp_retrieve");
    // #1192: the proxy disarms CCR on the responses wire in plugin mode, so it must
    // NOT be advertised there (advertising would guarantee a rejected call).
    assert.ok(!namesOnWire(m.tools.responses).includes("acp_retrieve"), "responses wire must NOT carry acp_retrieve");
});

test("handlePluginManifest: custom ccr.toolName is honored", () => {
    const m = readManifest({ ...defaultConfig(200_000), ccr: { enabled: true, toolName: "fetch_full" } });
    assert.ok(m.toolNames.includes("fetch_full"), "custom retrieve tool name advertised");
    assert.ok(namesOnWire(m.tools.anthropic).includes("fetch_full"));
});

// — plugin-mode arming gate: wire scoping (silent-loss boundary, #1097/#1271) —

test("plugin-mode CCR is scoped to exactly the anthropic/openai wires", () => {
    assert.deepEqual([...PLUGIN_CCR_WIRES].sort(), ["anthropic", "openai"]);
    assert.equal(ccrPluginWireOk("anthropic"), true);
    assert.equal(ccrPluginWireOk("openai"), true);
    assert.equal(ccrPluginWireOk("responses"), false, "responses cannot round-trip the retrieval");
    assert.equal(ccrPluginWireOk("google"), false, "google strict alternation cannot ride the injection");
});

// — plugin-lane e2e: store → placeholder → acp_retrieve → full text rides back —

type Rig = { proxyPort: number; upstreamPort: number; forwards: string[]; proxy: http.Server; upstream: http.Server };

function okJson(): string {
    return JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    });
}

async function startRig(): Promise<Rig> {
    const forwards: string[] = [];
    const upstream = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
            forwards.push(b);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port as number;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: false, ccr: { enabled: true, minToolTokens: 50 } },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxyPort: proxy.address().port as number, upstreamPort, forwards, proxy, upstream };
}

async function postOpenai(rig: Rig, messages: unknown[]): Promise<void> {
    const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "test-agent", "x-acp-session": "ccr-e2e-conv" },
        // max_tokens must exceed SIDE_REQUEST_MAX_TOKENS or the side-request
        // guard forwards verbatim without touching kernel state (#554).
        body: JSON.stringify({ model: MODEL, max_tokens: 64_000, messages }),
    });
    const txt = await res.text();
    if (res.status !== 200) throw new Error(`proxy returned ${res.status}: ${txt}`);
}

const BASE_MSGS = (): unknown[] => [
    { role: "user", content: "run a big build" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"npm run build"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: BIG_TEXT },
];

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

test("e2e plugin lane: CCR arms, stores+placeholderes, and acp_retrieve rides full text back", async () => {
    const rig = await startRig();
    try {
        // Turn 1: agent sends history with an oversized tool result.
        await postOpenai(rig, BASE_MSGS());
        assert.equal(rig.forwards.length, 1, "one outbound forward after turn 1");
        const f1 = rig.forwards[0]!;
        assert.ok(f1.includes("[acp-stored"), "turn-1 wire carries the stored placeholder, got: " + f1.slice(0, 200));
        assert.ok(!f1.includes(BIG_TEXT), "full original must NOT leak onto the turn-1 wire");

        // Discover the armed session (only our plugin-mode session has CCR stamped).
        const armed = listSessions().filter((s) => ccrEnabled(s));
        assert.equal(armed.length, 1, "exactly one CCR-armed session exists");
        const sess = armed[0]!;
        assert.equal(retrieveToolName(sess), "acp_retrieve");
        const ref = Object.keys(contentStoreOf(sess).byRef)[0];
        assert.ok(ref, "oversized tool result was stored under a ref");

        // The agent calls acp_retrieve (via the tool endpoint in reality); here we
        // drive the same executeRetrieve the endpoint dispatches to.
        const ack = executeRetrieve({ ref }, sess);
        assert.match(ack, new RegExp(`retrieved ${ref}: [\\d,]+ tok`), "retrieve returns the ack receipt");

        // Turn 2: agent re-sends history plus the acp_retrieve call + ack. The
        // drained injection rides the full original back on this forward.
        const msgs2 = [
            ...BASE_MSGS(),
            { role: "assistant", content: null, tool_calls: [{ id: "call_r", type: "function", function: { name: "acp_retrieve", arguments: JSON.stringify({ ref }) } }] },
            { role: "tool", tool_call_id: "call_r", content: ack },
        ];
        await postOpenai(rig, msgs2);
        assert.equal(rig.forwards.length, 2, "second outbound forward after turn 2");
        const f2 = rig.forwards[1]!;
        assert.ok(f2.includes(BIG_TEXT.slice(0, 120)), "full original rides back onto the turn-2 wire");
    } finally {
        await closeRig(rig);
    }
});
