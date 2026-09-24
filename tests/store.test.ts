import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    buildStoredPlaceholder,
    createContentStore,
    createCore,
    createInitialState,
    DEFAULT_CCR_CONFIG,
    defaultConfig,
    retrieveByRef,
    STORED_PLACEHOLDER_MARKER,
    storeOriginal,
    type CoreMessage,
    type MessageContentStore,
} from "acp-kernel";
import { parseCompressSettings } from "../src/config.ts";
import { applyCompressSettings, mergeCompress } from "../src/compress-settings.ts";
import { adoptContentStore, drainPendingRetrievals, executeRetrieve, retrieveToolName, storeEffectiveCcr, contentStoreOf, DEFAULT_MAX_STORE_BYTES, enforceStoreCap } from "../src/store.ts";
import { RETRIEVE_TOOL_NAME } from "../src/compress-tool.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

// Unit tests never touch the real data/state trees: persistence off by
// default; the envelope round-trip builds its own throwaway SessionStore.
process.env.BILI_PERSIST = "0";
const PERSIST_TMP = mkdtempSync(path.join(tmpdir(), "bili-ccr-persist-"));

const BIG_TEXT = "line of build output ".repeat(700);

function toolResult(): CoreMessage[] {
    return [
        { id: "u1", role: "user", contentType: "text", text: "run a big build" },
        { id: "a-tc", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_1", text: JSON.stringify({ command: "npm run build" }) },
        { id: "t-res", role: "tool", contentType: "tool-result", toolCallId: "call_1", toolName: "bash", text: BIG_TEXT },
    ];
}

function ccrConfig() {
    return applyCompressSettings(defaultConfig(200000), 200_000, {
        absorb: { enabled: true, minToolTokens: 50 },
        ccr: { enabled: true, minToolTokens: 50 },
    });
}

function turnWith(cfg: ReturnType<typeof applyCompressSettings>, store?: MessageContentStore) {
    const core = createCore();
    return core.processTurn({ messages: toolResult(), state: createInitialState(), config: cfg, tokenCount: 0, renderTags: "text-only", ...(store ? { contentStore: store } : {}) });
}

test("parseCompressSettings: ccr key validates shape and types", () => {
    const okFull = parseCompressSettings({
        ccr: { enabled: true, minToolTokens: 500, excludeTools: ["webfetch"], toolName: "fetch_original", maxHeadChars: 64 },
    });
    assert.ok(okFull);
    assert.deepEqual(okFull.ccr, { enabled: true, minToolTokens: 500, excludeTools: ["webfetch"], toolName: "fetch_original", maxHeadChars: 64 });

    // toolName is trimmed; empty after trim is invalid
    assert.equal(parseCompressSettings({ ccr: { toolName: "  lookup  " } }).ccr?.toolName, "lookup");
    assert.equal(parseCompressSettings({ ccr: { toolName: "   " } }), undefined);
    // wrong types reject the whole settings block (fail loudly, #155)
    assert.equal(parseCompressSettings({ ccr: { enabled: "yes" } }), undefined);
    assert.equal(parseCompressSettings({ ccr: { minToolTokens: "500" } }), undefined);
    assert.equal(parseCompressSettings({ ccr: { maxHeadChars: NaN } }), undefined);
    assert.equal(parseCompressSettings({ ccr: { excludeTools: [42] } }), undefined);
    assert.equal(parseCompressSettings({ ccr: { excludeTools: "webfetch" } }), undefined);
    assert.equal(parseCompressSettings({ ccr: "on" }), undefined);
});

test("mergeCompress: ccr merges sub-field-wise across the three levels", () => {
    const global = parseCompressSettings({ ccr: { enabled: true, excludeTools: ["webfetch"] } })!;
    const model = parseCompressSettings({ ccr: { minToolTokens: 200 } })!;
    const merged = mergeCompress(global, undefined, model);
    assert.deepEqual(merged.ccr, { enabled: true, minToolTokens: 200, excludeTools: ["webfetch"] });

    // a deeper level can override a scalar without clobbering siblings
    const provider = parseCompressSettings({ ccr: { toolName: "lookup" } })!;
    const merged2 = mergeCompress(global, provider, model);
    assert.deepEqual(merged2.ccr, { enabled: true, minToolTokens: 200, excludeTools: ["webfetch"], toolName: "lookup" });

    assert.equal(mergeCompress(undefined, undefined, undefined).ccr, undefined);
});

test("applyCompressSettings: maps ccr onto kernel CcrConfig with DEFAULT_CCR_CONFIG defaults", () => {
    const base = defaultConfig(200000);
    const out = applyCompressSettings(base, 200_000, { ccr: { enabled: true, minToolTokens: 200 } });
    assert.deepEqual(out.ccr, { ...DEFAULT_CCR_CONFIG, minToolTokens: 200, enabled: true });
    // absent block leaves base.ccr untouched (kernel default = feature off)
    const untouched = applyCompressSettings(base, 200_000, {});
    assert.equal(untouched.ccr, base.ccr);
});

test("integration: kernel processTurn ID-references the oversized tool result (ccr+absorb enabled)", () => {
    const cfg = ccrConfig();
    const turn = turnWith(cfg);
    const res = turn.messages.find((m) => m.role === "tool" && m.toolCallId === "call_1")!;
    assert.ok(res, "tool-result message survived the turn");
    assert.notEqual(res.text, BIG_TEXT);
    assert.ok(res.text!.includes(STORED_PLACEHOLDER_MARKER), `placeholder expected: ${res.text!.slice(0, 160)}`);
    const ref = Object.keys(turn.contentStore.byRef)[0]!;
    assert.ok(res.text!.includes(ref), "placeholder cites the stored ref");
    assert.ok(res.text!.includes(RETRIEVE_TOOL_NAME), "placeholder names the retrieve tool");
    assert.equal(turn.contentStore.byRef[ref]!.rawId, "t-res");
    assert.equal(Object.keys(turn.contentStore.byHash).length, 1);
    // tool-call pairing survives substitution
    assert.equal(turn.messages.find((m) => m.id === "a-tc")!.text, JSON.stringify({ command: "npm run build" }));
});

test("integration: ccr off → byte-identical pass-through", () => {
    const cfg = applyCompressSettings(defaultConfig(200000), 200_000, {});
    assert.notEqual(cfg.ccr?.enabled, true);
    const turn = turnWith(cfg);
    const res = turn.messages.find((m) => m.role === "tool" && m.toolCallId === "call_1")!;
    assert.equal(res.text, BIG_TEXT);
    assert.equal(Object.keys(turn.contentStore.byRef).length, 0);
});

test("executeRetrieve: hit queues injection + ack, miss self-corrects, tool name follows config", () => {
    const session = getSession(`t-ccr-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, toolName: "lookup", minToolTokens: 50 });
    assert.equal(retrieveToolName(session), "lookup");
    adoptContentStore(session, turnWith(ccrConfig()).contentStore);
    const ref = Object.keys(session.contentStore!.byRef)[0]!;

    const ack = executeRetrieve({ ref }, session);
    assert.match(ack, new RegExp(`retrieved ${ref}: [\\d,]+ tok`));
    assert.equal(session.stats.retrieveCalls, 1);
    assert.equal(session.stats.retrieveHits, 1);
    const injections = drainPendingRetrievals(session);
    assert.equal(injections.length, 1);
    assert.equal(injections[0]!.id, `acp_retrieved_${ref}`);
    assert.ok(injections[0]!.text.includes(BIG_TEXT.slice(0, 80)), "injection carries the full original");
    assert.equal(drainPendingRetrievals(session).length, 0);

    const miss = executeRetrieve({ ref: "m99999" }, session);
    assert.match(miss, /not found/);
    assert.equal(session.stats.retrieveMisses, 1);
    assert.equal(session.stats.retrieveCalls, 2);
    assert.equal(drainPendingRetrievals(session).length, 0, "a miss queues nothing");
    // malformed arg is a miss, not a crash
    assert.match(executeRetrieve({}, session), /ref/);
    assert.equal(session.stats.retrieveMisses, 2);
});

test("buildStoredPlaceholder renders the kernel wire format the gates assert on", () => {
    const text = buildStoredPlaceholder({ ref: "m00423", kind: "shell output", tokens: 4213, head: "npm run build", command: "npm run build", retrieveToolName: RETRIEVE_TOOL_NAME });
    assert.ok(text.includes("[acp-stored #m00423"));
    assert.ok(text.includes("shell output"));
    assert.ok(text.includes("4,213 tok"));
    assert.ok(text.includes(`${RETRIEVE_TOOL_NAME}("m00423")`), "placeholder tells the model how to retrieve");
    assert.ok(text.includes("npm run build"));
});

test("envelope round-trip: dirty flag gates the write; reload restores the store", () => {
    const store = new SessionStore({ dir: PERSIST_TMP, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        const session = getSession(`ccr-rt-${Math.random().toString(36).slice(2)}`);
        storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
        adoptContentStore(session, turnWith(ccrConfig()).contentStore);
        const ref = Object.keys(session.contentStore!.byRef)[0]!;

        // clean store → no envelope write
        session.contentStoreDirty = false;
        store.flushSync(session);
        assert.equal(findEnvelope(PERSIST_TMP), null, "clean store must not write the envelope");

        // dirty → written; round-trip restores it verbatim
        session.contentStoreDirty = true;
        assert.ok(store.flushSync(session));
        const file = findEnvelope(PERSIST_TMP);
        assert.ok(file, "content-store.json written under the session dir");
        const fresh = getSession(session.id);
        const loaded = contentStoreOf(fresh);
        assert.equal(loaded.byRef[ref]!.rawId, "t-res");
        assert.equal(loaded.byHash[loaded.byRef[ref]!.hash], BIG_TEXT);

        // rebase reset: store cleared + dirty → file deleted
        session.contentStore = undefined;
        session.contentStoreDirty = true;
        store.flushSync(session);
        assert.equal(findEnvelope(PERSIST_TMP), null, "emptied store deletes the envelope");
    } finally {
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmSync(PERSIST_TMP, { recursive: true, force: true });
    }
});

// ---- #1282: content-store byte cap + oldest-first eviction ----

function multiStore(entries: Array<{ ref: string; rawId: string; text: string }>): MessageContentStore {
    let store = createContentStore();
    for (const e of entries) {
        store = storeOriginal(store, {
            ref: e.ref,
            rawId: e.rawId,
            text: e.text,
            kind: "shell output",
            tokens: Math.ceil(e.text.length / 4),
            head: e.text.slice(0, 32),
        });
    }
    return store;
}

function storeBytes(s: MessageContentStore): number {
    let n = 0;
    for (const t of Object.values(s.byHash)) n += Buffer.byteLength(t, "utf8");
    return n;
}

test("parseCompressSettings: ccr.maxStoreBytes (0=unbounded, >0=cap, <0 invalid)", () => {
    assert.equal(parseCompressSettings({ ccr: { enabled: true, maxStoreBytes: 0 } }).ccr?.maxStoreBytes, 0);
    assert.equal(parseCompressSettings({ ccr: { enabled: true, maxStoreBytes: 4096 } }).ccr?.maxStoreBytes, 4096);
    assert.equal(parseCompressSettings({ ccr: { enabled: true } }).ccr?.maxStoreBytes, undefined);
    // invalid values reject the whole settings block (fail loudly, #155)
    assert.equal(parseCompressSettings({ ccr: { enabled: true, maxStoreBytes: -1 } }), undefined);
    assert.equal(parseCompressSettings({ ccr: { enabled: true, maxStoreBytes: Number.NaN } }), undefined);
    assert.equal(parseCompressSettings({ ccr: { enabled: true, maxStoreBytes: "32" } }), undefined);
});

test("enforceStoreCap evicts oldest refs first until under the byte cap", () => {
    const session = getSession(`ccr-cap-${Math.random().toString(36).slice(2)}`);
    const store = multiStore([
        { ref: "m00001", rawId: "r1", text: "x".repeat(1000) + "1" },
        { ref: "m00002", rawId: "r2", text: "x".repeat(1000) + "2" },
        { ref: "m00003", rawId: "r3", text: "x".repeat(1000) + "3" },
        { ref: "m00004", rawId: "r4", text: "x".repeat(1000) + "4" },
    ]);
    const CAP = 2560;
    assert.ok(storeBytes(store) > CAP, "precondition: store exceeds the cap");
    storeEffectiveCcr(session, { enabled: true, minToolTokens: 50, maxStoreBytes: CAP });
    session.contentStore = store;
    const evicted = enforceStoreCap(session);
    assert.equal(evicted, 2);
    assert.deepEqual(Object.keys(session.contentStore!.byRef).sort(), ["m00003", "m00004"]);
    assert.equal(Object.keys(session.contentStore!.byHash).length, 2, "freed hashes drop from byHash");
    assert.ok(storeBytes(session.contentStore!) <= CAP);
    // honest miss for evicted refs, hit for survivors
    assert.equal(retrieveByRef(session.contentStore!, "m00001").ok, false);
    assert.equal(retrieveByRef(session.contentStore!, "m00004").ok, true);
});

test("enforceStoreCap is dedup-aware: shared content frees only on its last ref", () => {
    const session = getSession(`ccr-dedup-${Math.random().toString(36).slice(2)}`);
    const shared = "s".repeat(1500);
    const store = multiStore([
        { ref: "m00001", rawId: "r1", text: shared },
        { ref: "m00002", rawId: "r2", text: shared },
        { ref: "m00003", rawId: "r3", text: "u".repeat(1500) },
    ]);
    assert.equal(Object.keys(store.byHash).length, 2, "two unique contents despite three refs");
    storeEffectiveCcr(session, { enabled: true, minToolTokens: 50, maxStoreBytes: 1500 });
    session.contentStore = store;
    enforceStoreCap(session);
    // evicting m00001 frees nothing (m00002 still shares the hash); m00002 frees it.
    assert.deepEqual(Object.keys(session.contentStore!.byRef).sort(), ["m00003"]);
    assert.equal(Object.keys(session.contentStore!.byHash).length, 1);
    assert.equal(retrieveByRef(session.contentStore!, "m00001").ok, false);
    assert.equal(retrieveByRef(session.contentStore!, "m00003").ok, true);
});

test("maxStoreBytes 0 disables the cap (unbounded lossless retention)", () => {
    const session = getSession(`ccr-unb-${Math.random().toString(36).slice(2)}`);
    const store = multiStore(Array.from({ length: 5 }, (_, i) => ({
        ref: `m0000${i + 1}`,
        rawId: `r${i + 1}`,
        text: "z".repeat(1000) + String(i),
    })));
    storeEffectiveCcr(session, { enabled: true, minToolTokens: 50, maxStoreBytes: 0 });
    session.contentStore = store;
    assert.equal(enforceStoreCap(session), 0);
    assert.equal(Object.keys(session.contentStore!.byRef).length, 5);
});

test("default cap (unset) leaves a modest store intact; constant is 32 MiB", () => {
    assert.equal(DEFAULT_MAX_STORE_BYTES, 32 * 1024 * 1024);
    const session = getSession(`ccr-def-${Math.random().toString(36).slice(2)}`);
    const store = multiStore([{ ref: "m00001", rawId: "r1", text: "a".repeat(100_000) }]);
    storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
    session.contentStore = store;
    assert.equal(enforceStoreCap(session), 0);
    assert.equal(retrieveByRef(session.contentStore!, "m00001").ok, true);
});

test("adoptContentStore enforces the cap on growth (over-cap arrival is evicted)", () => {
    const session = getSession(`ccr-grow-${Math.random().toString(36).slice(2)}`);
    storeEffectiveCcr(session, { enabled: true, minToolTokens: 50, maxStoreBytes: 5000 });
    const turn = turnWith(ccrConfig());
    assert.ok(storeBytes(turn.contentStore) > 5000, "precondition: arrival exceeds the cap");
    adoptContentStore(session, turn.contentStore);
    assert.equal(Object.keys(session.contentStore!.byRef).length, 0, "single over-cap entry is evicted");
    assert.equal(session.stats.storedBytes, 0);
});

test("legacy oversized envelope is trimmed to the cap on first touch (load path)", () => {
    const store = new SessionStore({ dir: PERSIST_TMP, debounceMs: 0 });
    _setStoreForTest(store);
    const id = `ccr-capload-${Math.random().toString(36).slice(2)}`;
    try {
        const s = getSession(id);
        // Phase 1: persist an oversized envelope under an unbounded cap — a file
        // written before the cap existed / by a larger-cap config.
        storeEffectiveCcr(s, { enabled: true, minToolTokens: 50, maxStoreBytes: 0 });
        s.contentStore = multiStore([
            { ref: "m00001", rawId: "r1", text: "a".repeat(1000) + "1" },
            { ref: "m00002", rawId: "r2", text: "b".repeat(1000) + "2" },
            { ref: "m00003", rawId: "r3", text: "c".repeat(1000) + "3" },
            { ref: "m00004", rawId: "r4", text: "d".repeat(1000) + "4" },
        ]);
        s.contentStoreDirty = true;
        assert.ok(store.flushSync(s));
        // Phase 2: reload the same id with a tight cap → first touch trims it.
        s.contentStore = undefined;
        s.contentStoreDirty = false;
        s.stats.storedBytes = storeBytes(multiStore([
            { ref: "m00001", rawId: "r1", text: "a".repeat(1000) + "1" },
            { ref: "m00002", rawId: "r2", text: "b".repeat(1000) + "2" },
            { ref: "m00003", rawId: "r3", text: "c".repeat(1000) + "3" },
            { ref: "m00004", rawId: "r4", text: "d".repeat(1000) + "4" },
        ]));
        storeEffectiveCcr(s, { enabled: true, minToolTokens: 50, maxStoreBytes: 2560 });
        const loaded = contentStoreOf(s);
        assert.deepEqual(Object.keys(loaded.byRef).sort(), ["m00003", "m00004"], "oldest refs trimmed on load");
        assert.ok(storeBytes(loaded) <= 2560);
        assert.equal(s.stats.storedBytes, storeBytes(loaded), "storedBytes stat refreshed after load-path trim");
        // the persisted file converges too
        assert.ok(store.flushSync(s));
        s.contentStore = undefined;
        const reloaded = contentStoreOf(getSession(id));
        assert.deepEqual(Object.keys(reloaded.byRef).sort(), ["m00003", "m00004"]);
    } finally {
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmSync(PERSIST_TMP, { recursive: true, force: true });
    }
});

function findEnvelope(root: string): string | null {
    for (const d of readdirSync(root)) {
        const p = path.join(root, d);
        if (!statSync(p).isDirectory()) continue;
        for (const f of readdirSync(p)) {
            if (f.endsWith(".content-store.json")) return path.join(p, f);
        }
    }
    return null;
}
