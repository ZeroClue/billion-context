import test from "node:test";
import assert from "node:assert/strict";
import {
    createCore,
    createInitialState,
    defaultConfig,
    DEFAULT_ABSORB_CONFIG,
    DEFAULT_CRUSH_CONFIG,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { mergeCompress, applyCompressSettings } from "../src/compress-settings.ts";
import { parseCompressSettings } from "../src/config.ts";

function crushableMsgs(): CoreMessage[] {
    // Repetitive JSON: 120 rows sharing one constant field — a textbook
    // json-fold payload (lossless crush, far beyond the 0.1 floor).
    const rows = Array.from({ length: 120 }, (_, i) => ({ repo: "acp-kernel", status: "ok", idx: i }));
    const payload = JSON.stringify({ rows }, null, 1);
    return [
        { id: "u1", role: "user", contentType: "text", text: "list repos" },
        { id: "a-tc", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_1", text: JSON.stringify({ command: "list" }) },
        { id: "t-res", role: "tool", contentType: "tool-result", toolCallId: "call_1", text: payload },
    ];
}

function turnWith(settings: ReturnType<typeof applyCompressSettings>) {
    const core = createCore();
    return core.processTurn({
        messages: crushableMsgs(),
        state: createInitialState(),
        config: settings,
        tokenCount: 0,
        renderTags: "text-only",
    });
}

test("parseCompressSettings: crush key validates shape, ratio and percent", () => {
    const okFull = parseCompressSettings({
        crush: {
            enabled: true,
            minReduction: "15%",
            strategies: { "json-fold": { enabled: false }, "log-select": { excludeTools: ["bash"] } },
        },
    });
    assert.ok(okFull);
    assert.deepEqual(okFull.crush, { enabled: true, minReduction: "15%", strategies: { "json-fold": { enabled: false }, "log-select": { excludeTools: ["bash"] } } });

    assert.equal(parseCompressSettings({ crush: { minReduction: 0.25 } }).crush?.minReduction, 0.25);
    // ratio must be in (0,1]; percent string must parse
    assert.equal(parseCompressSettings({ crush: { minReduction: 1.5 } }), undefined);
    assert.equal(parseCompressSettings({ crush: { minReduction: 0 } }), undefined);
    assert.equal(parseCompressSettings({ crush: { minReduction: "abc" } }), undefined);
    assert.equal(parseCompressSettings({ crush: { enabled: "yes" } }), undefined);
    assert.equal(parseCompressSettings({ crush: { strategies: { "json-fold": { enabled: "no" } } } }), undefined);
    assert.equal(parseCompressSettings({ crush: { strategies: { "json-fold": { excludeTools: [42] } } } }), undefined);
});

test("mergeCompress: crush scalar fields merge sub-field-wise, strategies id-wise", () => {
    const global = parseCompressSettings({ crush: { enabled: true, strategies: { "json-fold": { enabled: false }, "log-select": { excludeTools: ["bash"] } } } })!;
    const model = parseCompressSettings({ crush: { minReduction: "20%" } })!;
    const merged = mergeCompress(global, undefined, model);
    assert.deepEqual(merged.crush, { enabled: true, minReduction: "20%", strategies: { "json-fold": { enabled: false }, "log-select": { excludeTools: ["bash"] } } });

    // deeper strategy entry replaces the id wholesale, shallower ids survive
    const model2 = parseCompressSettings({ crush: { strategies: { "json-fold": { enabled: true } } } })!;
    const merged2 = mergeCompress(global, undefined, model2);
    assert.deepEqual(merged2.crush?.strategies, { "json-fold": { enabled: true }, "log-select": { excludeTools: ["bash"] } });

    assert.equal(mergeCompress(undefined, undefined, undefined).crush, undefined);
});

test("applyCompressSettings: maps crush onto kernel CrushConfig with defaults + percent parse", () => {
    const base = defaultConfig(200000);
    const out = applyCompressSettings(base, 200_000, { crush: { enabled: true, minReduction: "10%" } });
    assert.deepEqual(out.crush, { enabled: true, minReduction: 0.1 });
    // absent block leaves base.crush untouched (kernel default = feature off)
    const untouched = applyCompressSettings(base, 200_000, {});
    assert.equal(untouched.crush?.enabled, false);
    // strategies pass through
    const withStrats = applyCompressSettings(base, 200_000, { crush: { enabled: true, strategies: { "log-select": { enabled: false } } } });
    assert.deepEqual(withStrats.crush, { ...DEFAULT_CRUSH_CONFIG, enabled: true, strategies: { "log-select": { enabled: false } } });
});

test("integration: kernel processTurn crushes oversized JSON via bili config plumbing", () => {
    // absorb on with a tiny gate so the payload is eligible; crush enabled via
    // the same three-level plumbing the proxy uses.
    const cfg = applyCompressSettings(defaultConfig(200000), 200_000, {
        absorb: { enabled: true, minToolTokens: 50 },
        crush: { enabled: true },
    });
    assert.equal(cfg.absorb?.enabled, true);
    assert.equal(cfg.crush?.enabled, true);

    const turn = turnWith(cfg);
    const tool = turn.messages.find((m) => m.role === "tool" && m.toolCallId === "call_1");
    assert.ok(tool);
    const original = crushableMsgs().find((m) => m.role === "tool")!.text;
    assert.ok(tool.text && tool.text.length < original.length, "crushed payload must be smaller");
    assert.ok(tool.text.includes("__acp_crush"), "kernel crush envelope marker expected");

    // same messages WITHOUT crush: payload intact, only the absorb prompt appended
    const offCfg: Config = { ...defaultConfig(200000), absorb: { ...DEFAULT_ABSORB_CONFIG, enabled: true, minToolTokens: 50 } };
    const offTurn = turnWith(offCfg);
    const offTool = offTurn.messages.find((m) => m.role === "tool" && m.toolCallId === "call_1");
    assert.ok(offTool?.text?.startsWith(original));
    assert.ok(offTool.text.includes("[ACP absorb]"));
    assert.ok(!offTool.text.includes("__acp_crush"));
});
