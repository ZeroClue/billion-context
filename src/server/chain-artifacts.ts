// #1086: content fallback for bili→bili chain detection. When a middlebox
// strips bili's x-bili-hop header, the only remaining signal that an upstream
// bili instance already compressed the payload is the ACP artifacts inside
// the body itself: render tags (\x3cacp …\x3emNNNNN\x3c/acp\x3e) and the ACP
// tool names (acp_status / search_context) that bili's own plugins register.
//
// v0.1.133 (#1079) seeded this fallback on shapes bili PRODUCES for its own
// clients — the client re-sends render tags verbatim, and the tool names sit
// in the tools array of every plugin-mode request even when never called —
// so a single-instance setup judged EVERY turn as a chain and the compression
// kernel stopped running permanently (#1086). Corrections:
//   1. Tool names only count when they appear in HISTORY tool-call items
//      (an actual prior invocation), never from the tools declaration array
//      alone — declarations are the normal shape of a bili-managed client.
//   2. The DECISION (pass-through vs process) happens in server.ts AFTER
//      session identity is resolved: when THIS instance holds processed
//      compression state for the session, the artifacts are self-produced
//      and the request runs through the kernel normally.
//   3. Render tags only count from HISTORY message content — a client-authored
//      system/developer/instructions block may legitimately quote a tag-shaped
//      example (this repo's AGENTS.md does), which the old whole-body scan
//      misread as a chain and passed through forever, silently disabling
//      compression (#1197). An unparseable body has no structure, so it keeps
//      the whole-body fallback.
//   4. Cooperative plugin requests (x-bili-plugin) are exempt from the content
//      fallback entirely in server.ts — plugin mode re-sends the agent's own
//      compress calls/results by design; real bili→bili chains stay guarded by
//      the x-bili-hop marker above (#1197).

const ACP_TAG_RE = /\x3cacp\s+tokens=\\"?[0-9]+(?:\.[0-9]+)?K?\\"?\s+type=\\"?[^\\"]*\\"?\s*\x3em[0-9]{1,8}\x3c\/acp\x3e/;

export type AcpArtifactKind = "tags" | "tool-history";

/** Allocation-free byte pre-filter: true when either artifact family could
 *  be present. A miss is definitive (both seeds are literal substrings of
 *  the positive forms); a hit only costs one decode in detectAcpArtifacts. */
export function artifactSeedHit(body: Buffer): boolean {
    if (body.length === 0) return false;
    const tagSeed = body.includes("\x3cacp ");
    const toolSeed = body.includes('"acp_status"') && body.includes('"search_context"');
    return tagSeed || toolSeed;
}

/** Verify which ACP artifact family is actually present in the request.
 *  `parsed` is the already-parsed body (null when unparseable — then only
 *  the tag check can fire, over the whole body). Returns null when neither
 *  family is present. */
export function detectAcpArtifacts(body: Buffer, parsed: unknown): AcpArtifactKind | null {
    if (body.includes("\x3cacp ")) {
        // #1197: render tags only ever sit in HISTORY message content. Scope the
        // tag family there so a client-authored system/instructions example does
        // not read as a chain; an unparseable body has no structure to scope to.
        const hist = (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
            ? historyTagContainer(parsed as Record<string, unknown>)
            : null;
        if (ACP_TAG_RE.test(hist !== null ? JSON.stringify(hist) : body.toString("utf8"))) return "tags";
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const names = historyToolCallNames(parsed as Record<string, unknown>);
        if (names.has("acp_status") && names.has("search_context")) return "tool-history";
    }
    return null;
}

/** HISTORY messages only, re-serializable for the wire-escaped tag regex:
 *  the container (messages/input/contents) minus client-authored
 *  system/developer-role items. Top-level Anthropic `system`, Responses
 *  `instructions` and Gemini `systemInstruction` never live in the container,
 *  so they are excluded by construction. A client-authored context block may
 *  quote a render-tag example (this repo's AGENTS.md does) — that is not chain
 *  evidence (#1197). Returns null when the body has no recognizable container. */
function historyTagContainer(parsed: Record<string, unknown>): unknown[] | null {
    const container = Array.isArray(parsed.messages) ? parsed.messages
        : Array.isArray(parsed.input) ? parsed.input
        : Array.isArray(parsed.contents) ? parsed.contents
        : null;
    if (!container) return null;
    return container.filter((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return true;
        const role = (item as Record<string, unknown>).role;
        return role !== "system" && role !== "developer";
    });
}

/** Collect tool names invoked in HISTORY items only: OpenAI
 *  messages[].tool_calls[].function.name, Anthropic content blocks
 *  {type:"tool_use",name}, Responses input[] {type:"function_call",name},
 *  Gemini contents[].parts[].functionCall.name. The top-level `tools`
 *  declaration array is deliberately NOT scanned — a declaration without a
 *  historical call is the normal shape of a bili-managed client, not
 *  evidence of another bili instance (#1086 group E). Prose mentioning the
 *  names is likewise not counted. */
function historyToolCallNames(parsed: Record<string, unknown>): Set<string> {
    const names = new Set<string>();
    const container = Array.isArray(parsed.messages) ? parsed.messages
        : Array.isArray(parsed.input) ? parsed.input
        : Array.isArray(parsed.contents) ? parsed.contents
        : null;
    if (!container) return names;
    for (const item of container) visitHistoryItem(item, names);
    return names;
}

function visitHistoryItem(item: unknown, names: Set<string>): void {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const it = item as Record<string, unknown>;
    const toolCalls = it.tool_calls;
    if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
            if (!tc || typeof tc !== "object" || Array.isArray(tc)) continue;
            const fn = (tc as Record<string, unknown>).function;
            if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof (fn as Record<string, unknown>).name === "string") {
                names.add((fn as Record<string, unknown>).name as string);
            }
        }
    }
    if (it.type === "function_call" && typeof it.name === "string") names.add(it.name);
    const content = it.content;
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block && typeof block === "object" && !Array.isArray(block)
                && (block as Record<string, unknown>).type === "tool_use"
                && typeof (block as Record<string, unknown>).name === "string") {
                names.add((block as Record<string, unknown>).name as string);
            }
        }
    }
    const parts = it.parts;
    if (Array.isArray(parts)) {
        for (const part of parts) {
            if (!part || typeof part !== "object" || Array.isArray(part)) continue;
            const fc = (part as Record<string, unknown>).functionCall;
            if (fc && typeof fc === "object" && !Array.isArray(fc) && typeof (fc as Record<string, unknown>).name === "string") {
                names.add((fc as Record<string, unknown>).name as string);
            }
        }
    }
}
