import assert from "node:assert/strict";
import test from "node:test";
import { installNativeFetchIntercept, type NativeInterceptState } from "../src/agent/native-intercept.js";

function fakeFetch(sink: string[]) {
    return (async (input: RequestInfo | URL, _init?: RequestInit) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

async function withHeal<T>(fn: (ctx: { sink: string[]; rearm: (v: typeof fetch) => void; fetch: () => typeof fetch }) => Promise<T>): Promise<{ sink: string[]; result: T }> {
    const saved = globalThis.fetch;
    const sink: string[] = [];
    const state: NativeInterceptState = { origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") };
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest();
    globalThis.fetch = fakeFetch(sink);
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const result = await fn({
            sink,
            rearm: (v) => {
                globalThis.fetch = v;
            },
            fetch: () => globalThis.fetch,
        });
        return { sink, result };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

test("#1158 self-heal: third-party reset to a frozen bare fetch re-chains and keeps routing through bili", async () => {
    const bareSink: string[] = [];
    const { sink } = await withHeal(async ({ rearm, fetch }) => {
        rearm(fakeFetch(bareSink));
        const res = await fetch()("http://127.0.0.1:8199/v1/messages", { method: "POST" });
        assert.equal(res.status, 200);
    });
    assert.deepEqual(bareSink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
    assert.deepEqual(sink, []);
});

test("#1158 self-heal: third-party wrapper becomes the downstream (dsh-http-proxy apply shape)", async () => {
    const downstreamSeen: string[] = [];
    const { sink } = await withHeal(async ({ rearm, fetch }) => {
        const wrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
            downstreamSeen.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
            return fakeFetch([])(input, init);
        }) as typeof fetch;
        rearm(wrapper);
        const res = await fetch()("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        // Non-model URL still passes through to the third-party wrapper untouched.
        await fetch()("https://registry.npmjs.org/billion-context");
    });
    assert.deepEqual(downstreamSeen, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages", "https://registry.npmjs.org/billion-context"]);
    assert.deepEqual(sink, []);
    assert.equal(downstreamSeen.length, 2);
});

test("#1158 self-heal: guarded property is transparent when nobody fights it", async () => {
    const { sink } = await withHeal(async ({ fetch }) => {
        const res = await fetch()("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
        // A re-read of the global yields a stable callable (accessor works).
        assert.equal(typeof fetch(), "function");
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});

test("#1158 self-heal: non-function and self writes are ignored by the guard", async () => {
    const { sink } = await withHeal(async ({ rearm, fetch }) => {
        rearm(undefined as unknown as typeof fetch);
        const mine = fetch();
        rearm(mine);
        const res = await mine("http://127.0.0.1:8199/v1/messages");
        assert.equal(res.status, 200);
    });
    assert.deepEqual(sink, ["http://127.0.0.1:40001/bili/http://127.0.0.1:8199/v1/messages"]);
});
