// #1205: the acp-kernel openai wire codec keeps only text parts — plus
// image_url parts on user messages (sidecar'd as rawOpenaiContent/Parts) — and
// silently drops every other content-part type on the parse→rebuild round trip,
// before any compression happens. DeepSeek's default attachment flow sends
// {"type":"file","file_id":"file-api-…"} parts, so the model never sees the
// pixels. This detector scans the RAW body against that preserved set so the
// proxy can log a one-time warn instead of staying silent. When the kernel
// learns opaque part carry-through the call site should be re-pointed at what
// actually survived the round trip (today nothing does, so raw-body scanning
// is both sufficient and accurate for this drop class).

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

export interface DroppedOpenaiPartsReport {
    count: number;
    types: string[];
    firstIndex: number;
}

const USER_PRESERVED = new Set(["text", "image_url"]);
const DEFAULT_PRESERVED = new Set(["text"]);

export function droppedOpenaiParts(body: unknown): DroppedOpenaiPartsReport | null {
    if (!isObj(body)) return null;
    const messages = body.messages;
    if (!Array.isArray(messages)) return null;
    let count = 0;
    const types = new Set<string>();
    let firstIndex = -1;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!isObj(m) || !Array.isArray(m.content)) continue;
        const preserved = m.role === "user" ? USER_PRESERVED : DEFAULT_PRESERVED;
        for (const p of m.content) {
            if (!isObj(p) || preserved.has(typeof p.type === "string" ? p.type : "<no-type>")) continue;
            count++;
            types.add(typeof p.type === "string" ? p.type : "<no-type>");
            if (firstIndex < 0) firstIndex = i;
        }
    }
    return count > 0 ? { count, types: [...types].sort(), firstIndex } : null;
}
