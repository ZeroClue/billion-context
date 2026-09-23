import {
    collectBlockContent,
    parseBoundary,
    retrievedMessageId,
    type CompressionBlock,
    type CompressionCore,
    type CompressionState,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { markDirty, preCompactionArchiveOf, peekSession, findSessionByCanonicalId, type Session } from "./session.js";
import { getStore } from "./persist.js";
import { ccrEnabled } from "./store.js";

/** Bounded retention for large-decompress temp files. Each decompress with
 *  body > 10000 writes one file under tmpdir(); the reaper unlinks oldest past
 *  BILI_DECOMPRESS_TMP_CAP (default 50) and beforeExit cleans all. */
type TrackedTempFile = { path: string; mtimeMs: number };
const trackedTempFiles: TrackedTempFile[] = [];

function getDecompressTmpCap(): number {
    const raw = process.env.BILI_DECOMPRESS_TMP_CAP;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

function reapTempFiles(): void {
    const cap = getDecompressTmpCap();
    while (trackedTempFiles.length > cap) {
        trackedTempFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
        const oldest = trackedTempFiles.shift();
        if (!oldest) break;
        try {
            unlinkSync(oldest.path);
        } catch {}
    }
}

process.on("beforeExit", () => {
    for (const f of trackedTempFiles) {
        try {
            unlinkSync(f.path);
        } catch {}
    }
    trackedTempFiles.length = 0;
});

/** Shared ctx shape used by both the chat and responses compress loops. */
export type ProxyToolCtx = {
    core: CompressionCore;
    config: Config;
    messages: CoreMessage[];
    /** Unfolded original history. Loop paths hand the folded view as
     *  `messages`; decompress's cache-miss fallback must scan this instead. */
    compressMessages?: CoreMessage[];
    session: Session;
    log: (msg: string) => void;
};

/** Resolve a decompress request to a result string, honoring the `full` flag
 *  and the cross-round original-content cache on the session.
 *
 *  STATELESS RETRIEVAL: decompress is copy-paste — it changes no state. The
 *  block stays active, the forwarded view keeps folding, the cache is kept
 *  (repeat decompresses are free), and there is no expand/re-fold cycle.
 *
 *  - If the block has cached originals (captured at compress time), use the
 *    cached `one` or `full` view per the flag. This is the cross-round-safe
 *    path: ctx.messages only holds the folded view by the time decompress runs.
 *  - Otherwise fall back to collectBlockContent against the unfolded view
 *    (ctx.compressMessages ?? ctx.messages); if that yields nothing, return
 *    the block summary. */
export function resolveDecompress(
    args: Record<string, unknown>,
    ctx: ProxyToolCtx,
): string {
    const rawBlockId = args.blockId;
    if (typeof rawBlockId !== "string" || rawBlockId.length === 0) {
        return "[decompress FAILED: blockId is required]";
    }
    const blockId = rawBlockId.trim();
    const block = ctx.core.decompress(blockId, ctx.session.state);
    if (!block) return `[Block ${blockId} not found]`;
    const archived = preCompactionArchiveOf(ctx.session);
    if (archived[blockId] !== undefined) {
        return `[decompress FAILED: block ${blockId} is a pre-compaction archive — its content was in the history BEFORE the client's native compaction and is no longer reachable (replaced by the client's compaction summary). decompress is unavailable for archived blocks.]`;
    }
    if (typeof args.startId === "string" || typeof args.endId === "string") {
        return resolveDecompressRange(args, ctx, block);
    }

    const full = args.full === true;
    const cached = ctx.session.blockContents.get(blockId);
    let body: string;
    let count: number;
    if (cached) {
        // Honor the full flag: `one` = direct msgs + nested child summaries,
        // `full` = all original messages. Returning the cached full text
        // unconditionally would break the default one-level semantics.
        // `one === null` means the two views were byte-identical at cache
        // time and deduped to one copy (#401).
        const view = full ? cached.full : (cached.one ?? cached.full);
        body = view.text;
        count = view.count;
    } else {
        const collected = collectBlockContent(ctx.session.state, block, ctx.compressMessages ?? ctx.messages, { full });
        body = collected.text || block.summary;
        count = collected.count;
    }

    const header = `[Block ${blockId} content — ${count} item(s)${full ? ", full" : ""}]`;
    const safeBlockId = blockId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const outPath = body.length > 10000 ? join(tmpdir(), `acp-decompress-${safeBlockId}-${Date.now()}.txt`) : null;
    if (outPath) {
        try {
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, body, "utf8");
            trackedTempFiles.push({ path: outPath, mtimeMs: Date.now() });
            reapTempFiles();
            return `${header}\nContent (${body.length} chars) written to: ${outPath}\nUse the read tool to access it.`;
        } catch (e) {
            return `${header}\n[Failed to write to ${outPath}: ${String(e)}]\n${safePrefix(body, 4000)}...`;
        }
    }
    return `${header}\n${body}`;
}

type CoveredRefs = { raws: Array<{ raw: string; num: number }>; text: string };

function refNum(ref: string): number | null {
    const b = parseBoundary(ref);
    return b && b.kind === "message" ? b.numericId : null;
}

function coveredMessages(state: CompressionState, block: CompressionBlock): CoveredRefs | null {
    const byRaw = state.messageRefs.byRaw;
    const raws: Array<{ raw: string; num: number }> = [];
    for (const raw of block.effectiveMessageIds) {
        const ref = byRaw[raw];
        if (!ref) continue;
        const num = refNum(ref);
        if (num === null) continue;
        raws.push({ raw, num });
    }
    if (raws.length === 0) return null;
    raws.sort((a, z) => a.num - z.num);
    const runs: Array<[number, number]> = [];
    for (const { num } of raws) {
        const last = runs[runs.length - 1];
        if (last && num === last[1] + 1) last[1] = num;
        else runs.push([num, num]);
    }
    const fmtRun = ([a, z]: [number, number]) => (a === z ? `m${String(a).padStart(5, "0")}` : `m${String(a).padStart(5, "0")}–m${String(z).padStart(5, "0")}`);
    const head = runs.slice(0, 5);
    const shownCount = head.reduce((n, [a, z]) => n + (z - a + 1), 0);
    const rest = raws.length - shownCount;
    return { raws, text: head.map(fmtRun).join(", ") + (rest > 0 ? ` …+${rest} more` : "") };
}

/** #1179 CCR v2: the message refs a block covers, as compact span text
 *  ("m00044–m00097") plus count — or null when no individual refs are
 *  resolvable (older blocks whose raw ids left the map). */
export function coveredRefSpan(state: CompressionState, block: CompressionBlock): { text: string; count: number } | null {
    const cov = coveredMessages(state, block);
    return cov ? { text: cov.text, count: cov.raws.length } : null;
}

// #1179 CCR v2: range-level restore — return ONLY the block's messages whose
// refs fall within [startId, endId]. The content rides the ephemeral retrieval
// channel: ack now, full text queued as a request-only injection (same id/role
// shape as acp_retrieve injections, structurally excluded from fold space),
// never cached in blockContents. Gated on CCR being armed for the session.
function resolveDecompressRange(args: Record<string, unknown>, ctx: ProxyToolCtx, block: CompressionBlock): string {
    const startRaw = typeof args.startId === "string" ? args.startId.trim() : "";
    const endRaw = typeof args.endId === "string" ? args.endId.trim() : "";
    if (!startRaw || !endRaw) return "[decompress FAILED: startId and endId must be given together]";
    if (!ccrEnabled(ctx.session)) return "[decompress FAILED: range restore (startId/endId) requires CCR — enable compress.ccr.enabled]";
    const sb = parseBoundary(startRaw);
    const eb = parseBoundary(endRaw);
    if (!sb || sb.kind !== "message" || !eb || eb.kind !== "message") {
        return `[decompress FAILED: startId/endId must be mNNNNN message refs (got "${startRaw}", "${endRaw}") — block ids (bN) are not valid here]`;
    }
    if (sb.numericId > eb.numericId) return `[decompress FAILED: startId ${startRaw} is after endId ${endRaw} — swap them]`;
    const state = ctx.session.state;
    const cov = coveredMessages(state, block);
    if (!cov) return `[decompress FAILED: ${block.blockId} has no per-message coverage recorded (older block) — use plain decompress {blockId} for the whole block]`;
    const pickedSet = new Set(cov.raws.filter(({ num }) => num >= sb.numericId && num <= eb.numericId).map(({ raw }) => raw));
    if (pickedSet.size === 0) return `[decompress FAILED: ${block.blockId} covers no messages in ${startRaw}–${endRaw} (its coverage is ${cov.text})]`;
    const parts: string[] = [];
    for (const m of ctx.compressMessages ?? ctx.messages) {
        if (!pickedSet.has(m.id)) continue;
        const text = m.text ?? "";
        parts.push(m.toolName && m.contentType !== "text" ? `[${m.role} • ${m.toolName}]\n${text}` : `[${m.role}]\n${text}`);
    }
    if (parts.length === 0) {
        return `[decompress FAILED: originals for ${startRaw}–${endRaw} are no longer in this request's view (session restarted?) — whole-block decompress may still work from cache]`;
    }
    const header = `[Block ${block.blockId} content — ${startRaw}–${endRaw} — ${parts.length} item(s)]`;
    let injText: string;
    const body = parts.join("\n\n");
    if (body.length > 10000) {
        const safeBlockId = block.blockId.replace(/[^a-zA-Z0-9_-]/g, "-");
        const outPath = join(tmpdir(), `acp-decompress-${safeBlockId}-${Date.now()}.txt`);
        try {
            mkdirSync(dirname(outPath), { recursive: true });
            writeFileSync(outPath, body, "utf8");
            trackedTempFiles.push({ path: outPath, mtimeMs: Date.now() });
            reapTempFiles();
            injText = `${header}\nContent (${body.length} chars) written to: ${outPath}\nUse the read tool to access it.`;
        } catch (e) {
            injText = `${header}\n[Failed to write to ${outPath}: ${String(e)}]\n${safePrefix(body, 4000)}...`;
        }
    } else {
        injText = `${header}\n${body}`;
    }
    ctx.session.pendingRetrievals.push({ id: retrievedMessageId(`range_${block.blockId}_${startRaw}-${endRaw}`), role: "system", contentType: "text", text: injText });
    ctx.session.stats.rangeRestores = (ctx.session.stats.rangeRestores ?? 0) + 1;
    markDirty(ctx.session);
    ctx.log(`[acp-decompress-range] ${block.blockId} ${startRaw}–${endRaw}: restored ${parts.length} item(s) via ephemeral injection`);
    return `[decompress ${block.blockId} ${startRaw}–${endRaw}: restored ${parts.length} item(s) — full content follows]`;
}

// Back off a cut that lands between the two halves of a surrogate pair, so the
// truncated prefix never ends on a lone high surrogate (#816: strict-UTF-8
// gateways 500 deterministically on re-encoded request bodies).
function safePrefix(text: string, n: number): string {
    let cut = Math.min(n, text.length);
    if (cut > 0 && cut < text.length) {
        const c = text.charCodeAt(cut - 1);
        if (c >= 0xD800 && c <= 0xDBFF) cut -= 1;
    }
    return text.slice(0, cut);
}

/** Shared search_context execution for all wire paths. Distinguishes "no active
 *  blocks at all" (searching is pointless until compress runs — an explicit
 *  message stops premature-search retry loops, #714) from "blocks exist but none
 *  matched". */
export function executeSearchContext(
    args: Record<string, unknown>,
    core: CompressionCore,
    state: CompressionState,
    foreignSessionId?: string,
): string {
    const query = typeof args.query === "string" ? args.query : "";
    if (query.length === 0) return "[search_context FAILED: query is required]";
    const scope = foreignSessionId ? ` in session ${foreignSessionId}` : "";
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
    const blocks = core.search(query, state).slice(0, limit);
    if (blocks.length === 0) {
        if (!state.blocks.some((b) => b.active)) return `[No compressed blocks exist yet${scope} — nothing to search.]`;
        return `[No blocks matched "${query}"${scope}]`;
    }
    const lines = blocks.map((b) => {
        const topic = b.topic ?? "(no topic)";
        const preview = b.summary.length > 200 ? safePrefix(b.summary, 200) + "..." : b.summary;
        // #1179 CCR v2: covered message-ref span(s) — connect block space to
        // store space so the model can target acp_retrieve / range decompress
        // at individual messages instead of whole blocks.
        const span = coveredRefSpan(state, b);
        const spanNote = span ? ` [${span.text} · ${span.count} msgs]` : "";
        return `${b.blockId} (T${b.tier}) "${topic}"${spanNote}\n  ${preview}`;
    });
    const note = foreignSessionId
        ? `\n\n[Read-only search of historical session ${foreignSessionId}. Block ids are per-session namespaces — decompress acts on the current session only. For bulk content use bili export ${foreignSessionId} [--full].]`
        : "";
    return `Found ${blocks.length} block(s) for "${query}"${scope}:\n\n${lines.join("\n\n")}${note}`;
}

// #841: resolve a requested session id to its compression state without
// touching it — resident memory first (verbatim id or canonical alias), then
// the persisted store. Never creates, reloads or marks anything dirty.
export function resolveForeignSessionState(id: string): CompressionState | null {
    const resident = peekSession(id) ?? findSessionByCanonicalId(id);
    if (resident) return resident.state;
    return getStore().loadStateForSearch(id);
}

export function executeSearchContextTarget(
    args: Record<string, unknown>,
    core: CompressionCore,
    sessionId: string,
    state: CompressionState,
): string {
    const requested = typeof args.conversation_id === "string" ? args.conversation_id.trim() : "";
    // #1125: honor the param description's "Defaults to the current conversation" —
    // the literal "current" (any case) resolves to this session, not the foreign lookup.
    if (!requested || requested === sessionId || requested.toLowerCase() === "current") return executeSearchContext(args, core, state);
    // A self-reference under an alias form (canonical pfa-* id) keeps plain
    // current-session semantics — no "historical session" framing.
    const self = peekSession(requested) ?? findSessionByCanonicalId(requested);
    if (self?.id === sessionId) return executeSearchContext(args, core, state);
    const foreign = resolveForeignSessionState(requested);
    if (!foreign) return `[search_context FAILED: unknown session "${requested}"]`;
    return executeSearchContext(args, core, foreign, requested);
}
