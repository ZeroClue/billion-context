import {
    applyRetrieve,
    buildStoredPlaceholder,
    createContentStore,
    noteRetrieval,
    RETRIEVE_TOOL_NAME,
    type CoreMessage,
    type MessageContentStore,
} from "acp-kernel";
import { log as loggerLog } from "./logger.js";
import { getStore } from "./persist.js";
import type { CompressSettings } from "./config.js";
import type { Session } from "./session.js";

export type CcrSettings = NonNullable<CompressSettings["ccr"]>;

const EFFECTIVE_CCR_KEY = "effectiveCcr";

/** Stamp the last-resolved CCR policy onto the session (per-request; the
 *  processTurn loop config must match or be stripped, mirroring absorb). */
export function storeEffectiveCcr(session: Session, ccr: CcrSettings | undefined): void {
    session.metadata[EFFECTIVE_CCR_KEY] = ccr ?? null;
}

/** Read back the CCR policy stamped by {@link storeEffectiveCcr}. */
export function effectiveCcr(session: Session | undefined): CcrSettings | undefined {
    const meta = session?.metadata[EFFECTIVE_CCR_KEY];
    if (meta && typeof meta === "object" && typeof (meta as CcrSettings).enabled === "boolean") {
        return meta as CcrSettings;
    }
    return undefined;
}

export function ccrEnabled(session: Session | undefined): boolean {
    return effectiveCcr(session)?.enabled === true;
}

/** Model-facing retrieve tool name for this session: the config `ccr.toolName`
 *  override when set, else the kernel default. */
export function retrieveToolName(session: Session | undefined): string {
    return effectiveCcr(session)?.toolName ?? RETRIEVE_TOOL_NAME;
}

/** Default per-session content-store envelope cap in bytes (#1282). Bounds the
 *  disk-side mirror of folded context so a heavy session's envelope cannot grow
 *  toward the full transcript. Evicted refs degrade to honest retrieve misses. */
export const DEFAULT_MAX_STORE_BYTES = 32 * 1024 * 1024;

/** Resolve this session's effective store cap in bytes. Absent config → default;
 *  explicit 0 → unbounded (returns null = no eviction); >0 → that many bytes. */
function maxStoreBytesOf(session: Session): number | null {
    const v = effectiveCcr(session)?.maxStoreBytes;
    if (v === undefined) return DEFAULT_MAX_STORE_BYTES;
    return v > 0 ? v : null;
}

/** Total UTF-8 bytes held across unique contents (dedup-aware — byHash only). */
function storeSizeBytes(store: MessageContentStore): number {
    let n = 0;
    for (const text of Object.values(store.byHash)) n += Buffer.byteLength(text, "utf8");
    return n;
}

function refOrder(ref: string): number {
    const m = /^m(\d+)$/.exec(ref);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** Bound the session's content-store envelope to its byte cap by evicting oldest
 *  refs first (mNNNNN ascending) — folded content drops out before recent
 *  arrivals without any persistence-format change or ref reissue. Dedup-aware: a
 *  ref frees bytes only when it is the LAST ref pointing at its hash, which then
 *  drops from byHash too. Mutates the store in place — the host owns it post-
 *  adoption (kernel processTurn is pure). Marks dirty only when something was
 *  evicted, so an already-compliant store costs no extra write. Returns evictions. */
export function enforceStoreCap(session: Session): number {
    const store = session.contentStore;
    const cap = maxStoreBytesOf(session);
    if (!store || cap === null) return 0;
    let size = storeSizeBytes(store);
    if (size <= cap) return 0;
    const refCount = new Map<string, number>();
    for (const entry of Object.values(store.byRef)) {
        refCount.set(entry.hash, (refCount.get(entry.hash) ?? 0) + 1);
    }
    const refs = Object.keys(store.byRef).sort((a, b) => refOrder(a) - refOrder(b));
    let evicted = 0;
    for (const ref of refs) {
        if (size <= cap) break;
        const entry = store.byRef[ref];
        delete store.byRef[ref];
        evicted += 1;
        const remaining = (refCount.get(entry.hash) ?? 1) - 1;
        if (remaining > 0) {
            refCount.set(entry.hash, remaining);
        } else {
            const text = store.byHash[entry.hash];
            if (text !== undefined) size -= Buffer.byteLength(text, "utf8");
            delete store.byHash[entry.hash];
            refCount.delete(entry.hash);
        }
        loggerLog("warn", `[ccr] evict ${ref} (${entry.kind}, rawId=${entry.rawId}) — envelope over cap ${cap} B`);
    }
    if (evicted > 0) session.contentStoreDirty = true;
    return evicted;
}

/** Lazily materialize the session's kernel content-store envelope: loaded
 *  from the session's content-store.json on first touch, fresh when the file
 *  is absent (or corrupt — degraded to retrieve misses, never a crash). #1282:
 *  a legacy/oversized file written before the cap existed is trimmed to the
 *  current cap on first touch so disk usage converges within one request. */
export function contentStoreOf(session: Session): MessageContentStore {
    if (!session.contentStore) {
        session.contentStore = getStore().loadContentStore(session) ?? createContentStore();
        enforceStoreCap(session);
    }
    return session.contentStore;
}

/** Adopt the store returned by kernel processTurn (append-only, first write
 *  wins — refs are never rewritten). Stats and the persist dirty flag move
 *  only when new entries appeared, so a no-growth turn costs nothing. */
export function adoptContentStore(session: Session, store: MessageContentStore): void {
    const prev = session.contentStore;
    const added = prev
        ? Object.entries(store.byRef).filter(([ref]) => !(ref in prev.byRef))
        : Object.entries(store.byRef);
    session.contentStore = store;
    if (added.length === 0) return;
    // Growth is the only way the envelope exceeds its cap (#1282) — bound it now.
    enforceStoreCap(session);
    let saved = 0;
    for (const [ref, entry] of added) {
        // A just-added ref can only be evicted in the pathological single-entry-
        // over-cap case; skip it so stats count what actually stayed.
        if (!(ref in store.byRef)) continue;
        const placeholder = buildStoredPlaceholder({
            ref,
            kind: entry.kind,
            tokens: entry.tokens,
            head: entry.head,
            retrieveToolName: retrieveToolName(session),
        });
        saved += Math.max(0, entry.chars - Buffer.byteLength(placeholder, "utf8"));
    }
    session.stats.storedBytes = storeSizeBytes(store);
    session.stats.storeBytesSaved = (session.stats.storeBytesSaved ?? 0) + saved;
    session.contentStoreDirty = true;
}

/** Execute a retrieve-tool call against the kernel store: resolve the ref,
 *  count hit/miss, and queue the full-text injection for the re-request path
 *  (request-only, same channel as nudges — never persisted, structurally
 *  excluded from refs). Returns the deterministic ack that rides as the tool
 *  result on every wire. A hallucinated ref costs one tool call by design. */
export function executeRetrieve(args: Record<string, unknown>, session: Session): string {
    session.stats.retrieveCalls = (session.stats.retrieveCalls ?? 0) + 1;
    const rawRef = args.ref;
    const ref = typeof rawRef === "string" ? rawRef.trim() : "";
    if (!ref) {
        session.stats.retrieveMisses = (session.stats.retrieveMisses ?? 0) + 1;
        return `[${retrieveToolName(session)} FAILED: ref (an mNNNNN id) is required]`;
    }
    const result = applyRetrieve({ store: contentStoreOf(session), ref });
    if (!result.ok) {
        session.stats.retrieveMisses = (session.stats.retrieveMisses ?? 0) + 1;
        loggerLog("info", `[ccr] retrieve ${ref}: miss (${result.reason})`);
        return result.ackText;
    }
    session.stats.retrieveHits = (session.stats.retrieveHits ?? 0) + 1;
    session.state = noteRetrieval(session.state);
    session.pendingRetrievals.push(result.injection);
    loggerLog("info", `[ccr] retrieve ${ref} (${result.entry.tokens} tok, ${result.entry.chars} chars)`);
    return result.ackText;
}

/** Drain queued retrieval injections: callers append them to the re-request
 *  message list AFTER the tool-result pair (ack first, full text second). */
export function drainPendingRetrievals(session: Session): CoreMessage[] {
    return session.pendingRetrievals?.length ? session.pendingRetrievals.splice(0) : [];
}
