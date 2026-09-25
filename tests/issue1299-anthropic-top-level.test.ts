import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { ABSORB_TOOL, BILI_ACP_TOOLS_ANTHROPIC, IMAGE_FULL_TOOL, RULE_TOOL, retrieveToolsFor } from "../src/compress-tool.ts";

// Regression gate for #1299: acp-kernel 0.0.87/0.0.88 shipped compress's
// parameters schema with a top-level anyOf (kernel #374's content-vs-flat-
// range relax). Generic JSON Schema allows it, but api.anthropic.com hard-
// rejects oneOf/allOf/anyOf at the TOP LEVEL of input_schema (400), so every
// Claude request through bili 0.1.148 died on turn one. Root fix: acp-kernel
// #405 (v0.0.89) restores a plain {type, properties} top level. This test pins
// the invariant on bili's SERVED surface — what wire injection forwards and
// what the plugin manifest / MCP bridge expose — so a future kernel pin bump
// that re-introduces a top-level combinator fails here instead of bricking
// Claude users again. Nested combinators (e.g. items.anyOf) stay legal.

const COMBINATORS = ["oneOf", "allOf", "anyOf"] as const;

type ServedTool = { name?: string; input_schema?: unknown };

function assertPlainTopLevel(schema: unknown, label: string): void {
    assert.ok(schema && typeof schema === "object" && !Array.isArray(schema), `${label}: input_schema must be an object`);
    const s = schema as Record<string, unknown>;
    assert.equal(s.type, "object", `${label}: top level must be type:"object"`);
    for (const kw of COMBINATORS) {
        assert.ok(!(kw in s), `${label}: top-level "${kw}" is rejected by Anthropic (#1299)`);
    }
}

function walkServed(tools: ServedTool[], source: string): void {
    for (const t of tools) assertPlainTopLevel(t.input_schema, `${source}:${t.name}`);
}

const COMPRESS_FORM_PROPS = ["topic", "content", "startId", "endId", "startRef", "endRef", "summary"];

function assertCompressFormsKept(tool: ServedTool | undefined, source: string): void {
    assert.ok(tool, `${source}: compress tool present`);
    const props = (tool.input_schema as Record<string, unknown>)?.properties as Record<string, unknown> | undefined;
    assert.ok(props, `${source}:compress: properties kept`);
    for (const p of COMPRESS_FORM_PROPS) {
        assert.ok(p in props, `${source}:compress: advertised form property "${p}" kept`);
    }
}

// The full anthropic surface bili can serve: base ACP tools plus every opt-in
// tool the wire extras / plugin manifest append (absorb, acp_rule, acp_retrieve,
// image_full).
function servedSurface(): ServedTool[] {
    return [
        ...BILI_ACP_TOOLS_ANTHROPIC,
        ABSORB_TOOL,
        RULE_TOOL,
        retrieveToolsFor("acp_retrieve").anthropic,
        IMAGE_FULL_TOOL,
    ] as ServedTool[];
}

test("#1299: every Anthropic tool bili serves has a combinator-free top level", () => {
    walkServed(servedSurface(), "served");
    assertCompressFormsKept(servedSurface().find((t) => t.name === "compress"), "served");
});

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicStream(): string {
    return (
        anthropicSse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 42 } } }) +
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        anthropicSse("message_stop", { type: "message_stop" })
    );
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    upstreamBodies: string[];
    close(): Promise<void>;
}

async function startRig(): Promise<Rig> {
    const upstreamBodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            upstreamBodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(anthropicStream());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const closeOne = (s: http.Server): Promise<void> =>
        new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
    return {
        proxyPort,
        upstreamPort,
        upstreamBodies,
        close: async () => {
            await closeOne(proxy);
            await closeOne(upstream);
        },
    };
}

test("#1299: plugin manifest (the MCP bridge's schema source) serves only plain-top anthropic tools", async () => {
    const rig = await startRig();
    try {
        const res = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/manifest`);
        assert.equal(res.status, 200, "manifest reachable");
        const data = (await res.json()) as { ok: boolean; tools: { anthropic: ServedTool[] } };
        assert.equal(data.ok, true);
        walkServed(data.tools.anthropic, "manifest");
        assertCompressFormsKept(data.tools.anthropic.find((t) => t.name === "compress"), "manifest");
    } finally {
        await rig.close();
    }
});

test("#1299: proxied Anthropic request forwards only plain-top tools to upstream", async () => {
    const rig = await startRig();
    try {
        const res = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "test" },
            body: JSON.stringify({
                model: "claude-test",
                max_tokens: 1024,
                messages: [{ role: "user", content: "hello" }],
                tools: [{ name: "client_tool", description: "client-owned", input_schema: { type: "object", properties: {} } }],
            }),
        });
        assert.equal(res.status, 200, "turn completed");
        await res.text();
        assert.ok(rig.upstreamBodies.length >= 1, "request reached upstream");
        const fwd = JSON.parse(rig.upstreamBodies[0]) as { tools?: ServedTool[] };
        assert.ok(Array.isArray(fwd.tools) && fwd.tools.length > 0, "forwarded body carries tools");
        walkServed(fwd.tools as ServedTool[], "forwarded");
        const names = new Set((fwd.tools as ServedTool[]).map((t) => t.name));
        assert.ok(names.has("compress"), "bili injected its compress tool");
        assert.ok(names.has("client_tool"), "client-owned tool preserved");
        assertCompressFormsKept((fwd.tools as ServedTool[]).find((t) => t.name === "compress"), "forwarded");
    } finally {
        await rig.close();
    }
});
