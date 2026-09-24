# E2E: real codex client through bili against a real upstream

This suite runs the **real `codex` CLI** against a **real Responses-compatible
upstream** through the bili proxy, and asserts the full context-management
lifecycle end-to-end:

1. **warmup** — one turn; plants a known contamination value (`1400`) that the
   purity guard must later defeat.
2. **load growth** — `seq` tool outputs grow the payload deterministically
   (client-side; independent of model cooperation). Asserts `[acp-usage]`
   input grows.
3. **ACP compress** — under a small configured window the proxy must compress
   (model-cooperative `compress requested` **or** autonomous `preflight
   compressed`). Asserts usage drops after compression.
4. **purity** — post-compress recall of pre-compress facts (row counts of the
   `seq` runs) must be correct and must **not** echo the planted `1400`.
5. **forge** (gated by `E2E_FORGE=1`) — establishes an ACP block under an 8k
   window, then flips to a 16k window with a codex-side auto-compact limit
   below the ACP trigger so codex emits a **native compaction request**;
   asserts `codex compact intercepted … upstream not contacted`, a
   `fc_bili_` compaction item in the codex rollout, correct echo-stripping
   on the next turn, and intact recall after the forged compact.

## Running

```bash
npm run build                                  # suite spawns dist/index.js
ACP_TEST_E2E=1 node --import tsx --test tests/e2e/e2e-codex.test.ts
```

By default the suite **skips** (`set ACP_TEST_E2E=1`) so `npm test` stays free.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `ACP_TEST_E2E` | – | `1` enables the suite |
| `E2E_UPSTREAM_URL` | `http://127.0.0.1:8199/v1` | Responses-compatible upstream (no `/bili/` prefix) |
| `E2E_UPSTREAM_KEY` | `bili-local-test` | API key passed via codex `env_key` |
| `E2E_MODEL` | `qwen3.8-27b` | model name |
| `E2E_BILI_DIST` | repo `dist/index.js` | proxy entry under test — point at any build for capability-matrix runs |
| `E2E_CODEX_BIN` | `codex` | codex binary |
| `E2E_FORGE` | – | `1` runs the forge phase (needs a dist with `BILI_CODEX_COMPACT` support, i.e. #325+) |
| `E2E_TMO` | `300000` | per-turn timeout ms |

Preflight (no tokens): `E2E_CHECK=1 node --import tsx --test tests/e2e/e2e-codex.test.ts`
prints codex version, dist path, and an upstream `/models` probe.

## Mechanics

- Full isolation: `CODEX_HOME`, `XDG_{CONFIG,CACHE,STATE}_HOME` and the work
  dir (`tmp/e2e-codex-*` in the repo — **not** `/tmp`, codex refuses TMPDIR
  homes) are throwaway. Codex's **spawn cwd** is deliberately OUTSIDE the repo
  tree (`$TMPDIR/billion-context-e2e*`): codex discovers `AGENTS.md` by walking
  up from its cwd, so an in-repo cwd folds the entire repo doc into every
  request payload and couples CI to doc size (#815). A stub `AGENTS.md` does
  NOT help — codex concatenates every level on the way up.
- The bili window is forced via the `BILI_LAUNCHER_MODEL_WINDOWS` env
  (per-model override; wins over registry peek) so compression triggers
  deterministically on every run, independent of the upstream's advertised
  window and of which window-alignment PRs are merged.
- Provider `name = "OpenAI"` in `config.toml` keeps codex on the remote
  compaction path (V2) so the forge phase exercises the real interception.
- Assertions scrape bili's own log lines (`[acp-usage]`, `preflight
  compressed`, `codex compact intercepted`, `stripped … bili compaction
  item(s)`) plus codex exit codes, `--output-last-message` answers, and the
  rollout JSONL.

## CI

`.github/workflows/ci-e2e.yml` runs the suite on `workflow_dispatch` with
`E2E_UPSTREAM_URL` / `E2E_UPSTREAM_KEY` from repository secrets, against the
repo's own `dist` (i.e. whatever is on master at dispatch time). The forge
phase is enabled via a repository variable `E2E_FORGE` so it can be turned on
once interception ships.

---

## Native-lane suite (`e2e-native-pi.test.ts`) — real `pi` package-native vs deterministic fake

`ACP_TEST_E2E_NATIVE=1` gates the suite (`npm test` stays free). It drives the
**real `pi` CLI** in package-native mode (the repo root installed as a pi
package — the `bili plugin install pi` lane) through a **deterministic
chat-completions fake upstream** (`fake-upstream-chat.mjs`, zero tokens), and
asserts the four user-facing guarantees of #1239:

1. **interception + plugin-mode claim** — every upstream request carries
   `x-bili-plugin: pi` + `x-bili-plugin-conversation` (the #1243 one-shot
   stamp race is asserted per request, not just on the first);
2. **`/acp` command works** — exit 0, no error strings, and the
   `/__bili/plugin/status` endpoint it consumes answers JSON;
3. **the model can call `acp_status`** — the tool is registered from request 2
   onward and its result (the status report) is re-sent in history;
4. **the model can call `compress` and compression actually happens** — the
   compress result reports the fold, the proxy logs the plugin-channel
   execution, and (after a graceful proxy stop) the persisted session carries
   ≥1 compressed block.

### Mechanics

- The fake upstream parses scripted directives (`请调用<tool>`,
  `请调用<tool> {json-args}`) out of the last user message and answers with
  real `tool_calls` shapes (stream + non-stream), so the scripted "model"
  drives pi's whole tool loop deterministically.
- Compression needs the target message OUTSIDE the kernel's protected zone
  (last 5 messages + most recent user message) and ≥5000 chars of
  compressible content: run one loads ~7.6KB of filler, run two
  (`--continue`) cites the run-one filler message in the scripted
  `compress` call.
- The suite spawns pi with a **hermetic `PI_CODING_AGENT_DIR`** (models.json
  pointing at the fake, settings.json loading the repo root as a package) and
  hermetic XDG dirs. `cleanEnv()` strips every bili side-channel
  (`BILLION_CONTEXT_PROXY`, `BILI_*`, `ACP_*`, host pi overrides) **and
  `NODE_TEST_CONTEXT`** — pi-native deliberately stands down inside
  node:test, and the runner exports that variable into every spawned child.
- The spawn cwd is outside the repo (#815, same reason as codex).
- Sessions persist lazily: the suite SIGTERMs the hermetic proxy
  (`stopProxiesGracefully`) before asserting on-disk state; teardown then
  SIGKILLs survivors (fake + instance-record pids).
- `E2E_CHECK=1` runs a zero-cost preflight (pi binary version, built
  `dist/agent/pi-native.js`, fake `/v1/models` probe). `E2E_PI_BIN` /
  `E2E_TMO` override the binary and per-run timeout.

### CI

`.github/workflows/ci-e2e-native.yml` runs the suite on every PR and on
`workflow_dispatch` with pi pinned (`pi-stable@0.83.6`), same discipline as
the codex pin (#815).
