// #1196: a dsh profile-bundle copy must not stay frozen — its own proxy
// drives the owner's channel (refreshDshProfileBundles) instead of
// dead-ending on the bare #991 skip. Covers the lane classifier, the lane's
// update function, and checkForUpdate routing (incl. per-lane throttle
// isolation: the dsh lane must not starve behind the shared record).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
    checkForUpdate,
    checkDshProfileBundleUpdate,
    dshProfileBundleOf,
    _setFindInstallDirStartForTest,
    type UpdateOptions,
} from "../src/update.ts";
import { _setDshRunnersForTest, type DshPlan } from "../src/dsh-channel.ts";

// — helpers ---------------------------------------------------------------

interface ProfileFixture {
    root: string;
    dshHome: string;
    cacheDir: string;
    installDir: string;
    cleanup(): void;
}

/** A dsh profile bundle running at `version`: profile manifest (registry
 *  pin) plus the .pnpm store copy the "proxy" runs from. */
function makeProfileFixture(version: string): ProfileFixture {
    const root = mkdtempSync(path.join(tmpdir(), "bc-dsh-selfupdate-"));
    const dshHome = path.join(root, ".dsh");
    const cacheDir = path.join(root, "cache");
    const installDir = path.join(dshHome, "profiles", "web", "node_modules", ".pnpm", `billion-context@${version}`, "node_modules", "billion-context");
    mkdirSync(path.join(installDir, "dist"), { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
        path.join(dshHome, "profiles", "web", "package.json"),
        JSON.stringify({ name: "profile-web", version: "0.0.0", dependencies: { "billion-context": `^${version}` } }),
    );
    writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version, main: "dist/index.js" }));
    return { root, dshHome, cacheDir, installDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function setEnv(vars: Record<string, string>): Record<string, string | undefined> {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }
    return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
}

function mockRegistryFetch(calls: string[], doc: unknown): void {
    globalThis.fetch = ((input: RequestInfo | URL) => {
        calls.push(String(input));
        return Promise.resolve(new Response(JSON.stringify(doc)));
    }) as unknown as typeof fetch;
}

/** Records successful calls; profiles in `failNames` throw before recording.
 *  On Windows the plan rides cmd.exe /d /s /c "<line>" — unpack to argv
 *  tokens first so recording is platform-neutral (no spaced test tokens). */
function recordingAsyncRunner(calls: string[], failNames?: Set<string>): (plan: DshPlan) => Promise<{ stdout: string; stderr: string }> {
    return async (plan) => {
        const base = path.basename(plan.command).toLowerCase();
        const tokens = base === "cmd.exe" || base === "cmd"
            ? (plan.args[3] ?? "").replace(/^"|"$/g, "").split(" ").map((t) => t.replace(/^"|"$/g, "")).filter((t) => t.length > 0).slice(1)
            : [...plan.args];
        const name = tokens[tokens.indexOf("--profile") + 1];
        if (failNames?.has(name)) throw Object.assign(new Error("spawn failed"), { status: 1, stderr: "boom" });
        calls.push(tokens.join(" "));
        return { stdout: "", stderr: "" };
    };
}

function makeOpts(currentVersion: string, stale?: Array<{ diskVersion: string; runningVersion: string }>): UpdateOptions {
    return {
        packageName: "billion-context",
        currentVersion,
        autoUpdate: true,
        updateTag: "latest",
        ...(stale ? { onStaleInstall: (info) => stale.push(info) } : {}),
    };
}

// — lane classifier --------------------------------------------------------

test("dshProfileBundleOf: only real profile bundles classify, everything else stays global-lane", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-dsh-classify-"));
    try {
        const dshHome = path.join(base, ".dsh");
        const env = { ...process.env, DSH_HOME: dshHome };
        const bundle = path.join(dshHome, "profiles", "web", "node_modules", ".pnpm", "billion-context@0.1.139", "node_modules", "billion-context");
        assert.equal(dshProfileBundleOf(bundle, env), "web");
        // pnpm global store layout — .pnpm but NOT under a dsh profile
        assert.equal(dshProfileBundleOf(path.join(base, "pnpm", "global", "5", ".pnpm", "billion-context@0.1.139", "node_modules", "billion-context"), env), undefined);
        // plain bili-owned install
        assert.equal(dshProfileBundleOf(path.join(base, "scratch", "node_modules", "billion-context"), env), undefined);
        // profiles/node_modules is the store root, not a profile
        assert.equal(dshProfileBundleOf(path.join(dshHome, "profiles", "node_modules", ".pnpm", "x"), env), undefined);
        // sibling tree outside the profiles root
        assert.equal(dshProfileBundleOf(path.join(dshHome, "other", "billion-context"), env), undefined);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

// — the dsh-profile lane ---------------------------------------------------

test("checkDshProfileBundleUpdate: outdated bundle refreshes through the dsh channel, never in place", { timeout: 30_000 }, async () => {
    const fx = makeProfileFixture("0.1.139");
    const calls: string[] = [];
    const fetchCalls: string[] = [];
    const stale: Array<{ diskVersion: string; runningVersion: string }> = [];
    const originalFetch = globalThis.fetch;
    const saved = setEnv({ DSH_HOME: fx.dshHome, XDG_CACHE_HOME: fx.cacheDir });
    _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
    mockRegistryFetch(fetchCalls, { name: "billion-context", version: "0.1.140" });
    try {
        await checkDshProfileBundleUpdate(makeOpts("0.1.139", stale), fx.installDir);
        assert.deepEqual(calls, ["plugin --profile web add billion-context@0.1.140"]);
        assert.equal(fetchCalls.length, 1, "registry lookup only — no tarball download");
        assert.match(fetchCalls[0], /billion-context\/latest/);
        assert.deepEqual(stale, [{ diskVersion: "0.1.140", runningVersion: "0.1.139" }]);
        assert.equal(
            JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version,
            "0.1.139",
            "#991 single-writer: bili never overwrote the store copy in place",
        );
    } finally {
        globalThis.fetch = originalFetch;
        _setDshRunnersForTest(undefined);
        restoreEnv(saved);
        fx.cleanup();
    }
});

test("checkDshProfileBundleUpdate: up-to-date bundle makes no channel calls", { timeout: 30_000 }, async () => {
    const fx = makeProfileFixture("0.1.140");
    const calls: string[] = [];
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    const saved = setEnv({ DSH_HOME: fx.dshHome, XDG_CACHE_HOME: fx.cacheDir });
    _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
    mockRegistryFetch(fetchCalls, { name: "billion-context", version: "0.1.140" });
    try {
        await checkDshProfileBundleUpdate(makeOpts("0.1.140"), fx.installDir);
        assert.deepEqual(calls, []);
        assert.equal(fetchCalls.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
        _setDshRunnersForTest(undefined);
        restoreEnv(saved);
        fx.cleanup();
    }
});

test("checkDshProfileBundleUpdate: registry failure is swallowed and retried next cycle", { timeout: 30_000 }, async () => {
    const fx = makeProfileFixture("0.1.139");
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    const saved = setEnv({ DSH_HOME: fx.dshHome, XDG_CACHE_HOME: fx.cacheDir });
    _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
    globalThis.fetch = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    try {
        await assert.doesNotReject(checkDshProfileBundleUpdate(makeOpts("0.1.139"), fx.installDir));
        assert.deepEqual(calls, []);
    } finally {
        globalThis.fetch = originalFetch;
        _setDshRunnersForTest(undefined);
        restoreEnv(saved);
        fx.cleanup();
    }
});

test("checkDshProfileBundleUpdate: a failed dsh plugin add never breaks the loop", { timeout: 30_000 }, async () => {
    const fx = makeProfileFixture("0.1.139");
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    const saved = setEnv({ DSH_HOME: fx.dshHome, XDG_CACHE_HOME: fx.cacheDir });
    _setDshRunnersForTest({ async: recordingAsyncRunner(calls, new Set(["web"])) });
    mockRegistryFetch([], { name: "billion-context", version: "0.1.140" });
    try {
        await assert.doesNotReject(checkDshProfileBundleUpdate(makeOpts("0.1.139"), fx.installDir));
        assert.deepEqual(calls, [], "failed profile is not recorded as refreshed");
    } finally {
        globalThis.fetch = originalFetch;
        _setDshRunnersForTest(undefined);
        restoreEnv(saved);
        fx.cleanup();
    }
});

test("checkDshProfileBundleUpdate: never downgrades past the configured tag", { timeout: 30_000 }, async () => {
    const fx = makeProfileFixture("0.1.140");
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    const saved = setEnv({ DSH_HOME: fx.dshHome, XDG_CACHE_HOME: fx.cacheDir });
    _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
    mockRegistryFetch([], { name: "billion-context", version: "0.1.139" });
    try {
        await checkDshProfileBundleUpdate(makeOpts("0.1.140"), fx.installDir);
        assert.deepEqual(calls, []);
    } finally {
        globalThis.fetch = originalFetch;
        _setDshRunnersForTest(undefined);
        restoreEnv(saved);
        fx.cleanup();
    }
});

test("checkDshProfileBundleUpdate: defers while another process holds the update lock", { timeout: 30_000 }, async () => {
    const fx = makeProfileFixture("0.1.139");
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    const saved = setEnv({ DSH_HOME: fx.dshHome, XDG_CACHE_HOME: fx.cacheDir });
    _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
    mockRegistryFetch([], { name: "billion-context", version: "0.1.140" });
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    try {
        await new Promise<void>((resolve) => {
            child.once("spawn", () => resolve());
            setTimeout(resolve, 2000);
        });
        assert.ok(child.pid);
        mkdirSync(path.join(fx.cacheDir, "billion-context"), { recursive: true });
        writeFileSync(path.join(fx.cacheDir, "billion-context", ".update-lock"), JSON.stringify({ pid: child.pid, ts: Date.now() }));
        await checkDshProfileBundleUpdate(makeOpts("0.1.139"), fx.installDir);
        assert.deepEqual(calls, [], "lock held by a live foreign pid → no concurrent channel run");
    } finally {
        child.kill();
        globalThis.fetch = originalFetch;
        _setDshRunnersForTest(undefined);
        restoreEnv(saved);
        fx.cleanup();
    }
});

// — checkForUpdate routing (the #1196 regression itself) --------------------

test("checkForUpdate: a running dsh profile bundle takes the dsh lane end-to-end", { timeout: 30_000 }, async () => {
    const fx = makeProfileFixture("0.1.139");
    const calls: string[] = [];
    const fetchCalls: string[] = [];
    const stale: Array<{ diskVersion: string; runningVersion: string }> = [];
    const originalFetch = globalThis.fetch;
    const saved = setEnv({ DSH_HOME: fx.dshHome, XDG_CACHE_HOME: fx.cacheDir });
    _setFindInstallDirStartForTest(path.join(fx.installDir, "dist"));
    _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
    mockRegistryFetch(fetchCalls, { name: "billion-context", version: "0.1.140" });
    try {
        await checkForUpdate(makeOpts("0.1.139", stale), true);
        assert.deepEqual(calls, ["plugin --profile web add billion-context@0.1.140"]);
        assert.equal(fetchCalls.length, 1, "registry lookup only — the dsh lane never downloads tarballs");
        assert.deepEqual(stale, [{ diskVersion: "0.1.140", runningVersion: "0.1.139" }]);
        assert.equal(
            JSON.parse(readFileSync(path.join(fx.installDir, "package.json"), "utf-8")).version,
            "0.1.139",
            "#991 single-writer: the store copy is untouched by bili",
        );
        assert.ok(existsSync(path.join(fx.cacheDir, "billion-context", ".update-check-dsh-profile")), "dsh lane wrote its OWN throttle record");
        assert.ok(!existsSync(path.join(fx.cacheDir, "billion-context", ".update-check")), "global lane record untouched");
        // immediate non-forced follow-up is throttled on the dsh-lane record
        await checkForUpdate(makeOpts("0.1.139"), false);
        assert.equal(calls.length, 1, "throttled cycle did not re-run the channel");
    } finally {
        globalThis.fetch = originalFetch;
        _setFindInstallDirStartForTest(undefined);
        _setDshRunnersForTest(undefined);
        restoreEnv(saved);
        fx.cleanup();
    }
});

test("checkForUpdate: a non-dsh install dir stays on the legacy lane", { timeout: 30_000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-dsh-routing-"));
    const dshHome = path.join(root, ".dsh");
    const cacheDir = path.join(root, "cache");
    const installDir = path.join(root, "scratch", "node_modules", "billion-context");
    mkdirSync(path.join(installDir, "dist"), { recursive: true });
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "billion-context", version: "0.1.139", main: "dist/index.js" }));
    const calls: string[] = [];
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    const saved = setEnv({ DSH_HOME: dshHome, XDG_CACHE_HOME: cacheDir });
    _setFindInstallDirStartForTest(path.join(installDir, "dist"));
    _setDshRunnersForTest({ async: recordingAsyncRunner(calls) });
    mockRegistryFetch(fetchCalls, { name: "billion-context", version: "0.1.140" });
    try {
        await checkForUpdate(makeOpts("0.1.139"), true);
        assert.deepEqual(calls, [], "no dsh channel traffic for a bili-owned copy");
        assert.equal(fetchCalls.length, 1);
        assert.ok(existsSync(path.join(cacheDir, "billion-context", ".update-check")), "global lane record written");
        assert.ok(!existsSync(path.join(cacheDir, "billion-context", ".update-check-dsh-profile")), "dsh lane record untouched");
    } finally {
        globalThis.fetch = originalFetch;
        _setFindInstallDirStartForTest(undefined);
        _setDshRunnersForTest(undefined);
        restoreEnv(saved);
        rmSync(root, { recursive: true, force: true });
    }
});
