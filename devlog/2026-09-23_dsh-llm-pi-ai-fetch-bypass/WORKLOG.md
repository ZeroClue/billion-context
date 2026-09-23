# WORKLOG — dsh profile-install zero-traffic sessions: loud one-shot detection + gate-refusal instrumentation (#1158)

## Date
2026-09-23 (two commits on this branch)

## What was done

### Commit 1 — loud, actionable no-model-request 404
- src/plugin.ts: `handlePluginTool` distinguishes the two `!session` failures
  more precisely on the never-registered (`!entry`) branch — a tool call proves
  the model already answered, so ZERO model requests for that conversation id
  means its traffic never reached the proxy at all. First hit per conversation
  logs a one-shot actionable warn (`[plugin] NO MODEL REQUESTS seen for
  conversation …`); the 404 error body gains the same guidance while keeping
  the exact substrings `src/mcp.ts` (ORPHAN_ADOPT) and
  `src/agent/opencode-v2.ts` match on. One-shot state lives in a bounded module
  Set (cap 4096, coarse clear) reset by `_resetPluginStateForTest`. The
  entry-exists branch keeps its legacy per-call warn and wording byte-for-byte.
- tests/issue1158-no-model-request-warning.test.ts: regression suite — consumer
  substrings preserved, guidance present, warn exactly once per conversation,
  second conversation gets its own, reset re-arms, entry-exists branch
  unchanged.
- README.md / README.zh-CN.md: dsh section gains the #1158 entry.

### Commit 2 — root-cause retraction + takeover-gate refusal instrumentation
The owner's review (thread comment 2026-09-23) REJECTED the "SDK-injected
private fetch bypass" root cause with unpacked evidence across ALL published
versions: dsh-llm-pi-ai never sets a `fetch` key in streamSimple options;
pi-ai forwards `options?.fetch` (= undefined) into the OpenAI SDK, whose
`this.fetch = options.fetch ?? Shims.getDefaultFetch()` resolves globalThis at
client construction — i.e. the patched fetch; and dsh's main chat loop is
statically wrapped in `withInitiator` with zero `withoutInitiator` in llm
packages. The issue's :573-579 citation proved the channel EXISTS, not that
it is populated. Consequences, all applied here:
- plugin.ts warn/error wording made HYPOTHESIS-NEUTRAL: candidates listed
  (transport-level fetch shape / host-side attribution gap leaving traffic
  unclaimed by the takeover gate / stale id after host resume); the "known
  case: dsh llm-pi-ai" assertion removed from code, docs, and tests. The
  diagnostic itself stands regardless of which cause turns out true — it fires
  for ANY cause producing tool-calls-without-model-requests.
- src/agent/dsh-native.ts: `takeoverGate` now logs each DISTINCT endpoint it
  refuses ONCE PER PROCESS via console.error (host stdout/stderr, not
  bili.log): refused origin+pathname (query stripped — keys can ride there) +
  attribution state at refusal time (no initiator vs initiator-without-session
  id). This makes the owner's local repro one-pass diagnosable: a refused line
  with "no active initiator attribution" during an attributed chat turn pins
  the runtime-attribution hypothesis; absence of any refusal line while traffic
  still bypasses pins the transport-fetch-shape hypothesis. Legitimate agentless
  lanes (dsh's intentional `withoutInitiator` background drivers, third-party
  in-process callers) add at most one flat line per endpoint — the #1117
  silence rationale (no per-request noise) is preserved. Boolean gate contract
  unchanged; other consumers unaffected.
- tests/dsh-native.test.ts: new test — refusal logged once per endpoint, query
  string neither spawns a line nor leaks into it, distinct endpoints get their
  own lines, attributed traffic claims silently.
- README zh/en entry reworded to "reported, under investigation" with the two
  detection signals and the launcher workaround (robust under BOTH hypotheses:
  settings-overlay `/bili/` URLs reach the proxy directly, needing neither the
  fetch patch nor the gate).

## Behavior / compatibility changes (disclosure)
- Log volume, never-registered conversation id: every rejected tool call →
  once per conversation (old text `id never registered (stale shim session id
  after host resume?)` replaced by the richer NO MODEL REQUESTS line). Reason:
  the old line repeated on every tool call while pointing at only one of
  several hypotheses.
- Wire: the `/__bili/plugin/tool` 404 `error` string for unknown conversations
  grows a guidance suffix; status code, JSON shape, and both matched substrings
  are unchanged.
- NEW client-side log (dsh process): up to one `bili-native-dsh: model request
  sent DIRECT (uncompressed) — takeover gate refused <origin+path>: …` line per
  distinct endpoint per process lifetime where previously there was none.
  Deliberate deviation from #1117's silent refusals, scoped by the per-endpoint
  dedupe so legitimate agentless traffic stays constant-noise.
- No change to model-request handling, compression, config schema, wire shapes,
  or persistence format.

## Verification
- `npm run typecheck`: clean.
- `npm test`: 2253 total, 2251 pass, 0 fail, 2 skipped (pre-existing gated
  skips); touched suites (issue1158 + dsh-native) 31/31.
- `npm run build`: success.
- Full E2E not run: neither commit touches the request pipeline (server.ts /
  src/loop/* / adapters / preflight) or any wire shape — diagnostics only on
  already-failing paths. Local repro of the original symptom is impossible here
  (needs Windows + dsh web GUI); the owner is building a real dsh + bili + mock
  upstream harness and will post runtime results, which the new gate-refusal
  log is designed to make conclusive in one pass.

## Ceiling notes / deferred
- Generic interception of an arbitrary SDK-injected fetch is infeasible from
  bili's side (the function reference is private to the host module graph; pnpm
  isolation defeats cross-module patching; undici-internals patching too
  invasive). IF the transport-fetch-shape hypothesis survives the runtime
  evidence, the real fix belongs in dsh (lazy globalThis fetch resolution or a
  middleware seam) — cross-repo, stays manual.
- The reported agentless background lanes (dsh goal-round-driver / schedule,
  explicit `withoutInitiator()`) go direct BY DESIGN (owner's finding): their
  traffic now surfaces as one flat gate-refused line per endpoint instead of
  vanishing silently — visible, but intended uncompressed.
- `handlePluginCompact`'s analogous 404 wording left untouched (not part of
  the symptom; dsh-native has no compaction hook calling it).
