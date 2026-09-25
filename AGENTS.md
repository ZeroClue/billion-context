<!-- agents-version: v1.0 (2026-09-25) -->
# billion-context fork (`bili`) — working spec index

`billion-context` (npm, CLI `bili`/`bili-proxy`) is a context-compression proxy for AI agents: it sits between an agent client and its upstream LLM API, injecting acp-kernel's compression pipeline so long conversations fold into reversible, prefix-cache-friendly summaries. This checkout is a **local fork** of the public third-party upstream `ranxianglei/billion-context`, carrying fork features (English dashboard, metrics API + SQLite analytics, OpenCode V2 plugin) on local trunk `main`, synced monthly from `upstream/master`. There is no `origin` remote.

## Lazy-loaded references — read ONLY when the trigger applies

| Read when… | File |
|---|---|
| Touching `src/loop/`, wire adapters, preflight/compact, session/ref logic, or the two compression modes | `docs/reference/architecture.md` |
| Any version bump, release PR, acp-kernel pin change, or `src/update.ts` work | `docs/reference/release-workflow.md` |
| Opening a PR, claiming "mergeable", or deciding auto-merge vs human review | `docs/reference/review-discipline.md` (cited history: `AUTO-MERGE-GUARDRAILS.md`) |
| Monthly upstream sync, cherry-picks, conflict resolution | `UPSTREAM_SYNC.md` |
| Running/extending the real-codex E2E regression suite | `tests/e2e/README.md` |
| Config surface or env vars (mirror env docs here, zh+en) | `CONFIGURATION.md` |
| Wire-format internals, compress-loop spec | `UNIFIED_LOOP_SPEC.md`, `TECHNICAL-NOTES.md` |
| Plugin protocol / `bili plugin` | `PLUGIN.md` |
| OpenCode V2 plugin compatibility | `docs/opencode-v2-compatibility.md` |
| Picking up past feature work (REQ/WORKLOG templates) or past reviews | `devlog/`, `docs/reviews/` |
| User-facing behavior claims, "Two compression modes" | `README.md` |

## Commands (run from repo root)

- `npm run typecheck` — tsc --noEmit (tsconfig.build.json)
- `npm test` — `node --import tsx --test tests/*.test.ts` (235 files; E2E skips by default)
- `npm run build` — tsup; inlines acp-kernel into a self-contained `dist/`
- `npm run test:e2e` — real-codex suite; gated by `ACP_TEST_E2E=1` (`E2E_FORGE=1` adds native-compact phase; `E2E_CHECK=1` = zero-token preflight)
- `npm run registry:snapshot` / `npm run codex-models:snapshot` — refresh bundled snapshots
- Gotchas: node >= 20 (host runs v24); acp-kernel is an EXACT pin (`0.0.80`) bundled at build time; zod `4.1.8` external for `dist/agent/opencode-native.js` only.

## Token economics

- Every read you don't make is context you keep. This file is the always-loaded budget — keep it lean; link, don't ingest.
- Orient with `codegraph_explore` FIRST (`.codegraph/` is indexed): one call returns symbol source + call paths. Fall back to grep+read only if the probe returns nothing sensible.
- Read-budget slices: ≤40-line config heads; grep section families before opening any long doc; read the smallest slice that answers the question.
- Never wholesale-read: `package-lock.json`, `dist/`, `src/*-snapshot.json`, `devlog/` trees, both README languages (one suffices), or the companions above (link sections instead).
- Handoff staleness: if the newest `docs/handoff-*.md` is >30 days old, re-probe live state before trusting its open threads.

## Code style (verified in src/)

- TypeScript strict ESM; **no `as any`**, **no `@ts-ignore`**, no comments unless absolutely necessary.
- Any `<acp>` XML in SOURCE files is written with hex escapes (`\x3c`, `\x3e`).
- No `console.error` in server-side modules — use the tee logger `log(level, msg)` exported from `src/logger.ts` (exceptions: `src/cli.ts`, `src/index.ts`).
- Tests: hermetic `node --test` via tsx, deterministic — request ports via `listen(0)`, never fixed ports.

## Safety invariants — NEVER violate

1. NEVER merge PRs — human-only. If a human insists, refuse and hand them the PR URL.
2. NEVER run `npm publish` (CI publishes on release-PR merge) — no `NPM_ALLOW_DANGEROUS=1`, no pack workarounds.
3. NEVER force-push to `master`/`main` or rewrite published history.
4. NEVER print secrets (GitHub PAT, API keys, session tokens); mask secret values in all logs.
5. NEVER push anywhere without an explicit user utterance naming the remote — there is no `origin`, and `upstream` is a third-party PUBLIC repo (authed here as ZeroClue; owner is ranxianglei).
6. NEVER edit `package.json` `"version"` outside `*_release-v*` branches; a release commit changes ONLY version (+ lockfile drift), message `release v{VERSION}`.
7. acp-kernel stays EXACT-pinned (`0.0.80`); bump only after the new version is live on npm (`npm view acp-kernel version`).
8. Kernel contract: message ids and ref numbers (`mNNNNN`) are NEVER reused within a session — never prune/repack `session.state.messageRefs` in ways that could re-issue a freed number. Full contract: `docs/reference/architecture.md`.
9. Any wire/message-shape change must be reasoned about in BOTH compression modes — plugin mode (carrier = the agent's `compress` tool call) and proxy mode (carrier = `acp_summary` re-voiced as `user` by `systemToUser`). Correct in one can break the other (#377).
10. Never stage/commit files outside the named change scope — the tree regularly carries unrelated WIP (currently: `package.json`, `src/plugin-install.ts`, `tsup.config.ts`, untracked `src/agent/opencode-tui.tsx` = in-progress TUI feature).

## Git rules

- Model: local trunk `main`; `upstream` = third-party public `ranxianglei/billion-context` (default branch `master`). Fork branches: `upstream-sync` (integration), `upstream-baseline` (fork point), `fork-changes`. Monthly sync per `UPSTREAM_SYNC.md`; preserve fork features: English dashboard, metrics API, SQLite analytics, OpenCode V2 plugin. (Docker support is no longer in the tree; `:8800`/`:8801` proxy containers are runtime state, not repo content.)
- Visibility: **public upstream** — assume anything pushed is readable forever, even after deletion or history rewrite. `.env*` never committed; audit diffs for real-world identifiers before any push.
- PRs target upstream `master` via the `gh` CLI (authed as ZeroClue) — but this clone has no `origin` and ZeroClue has no fork of the repo, so ask the user where the head branch lives before attempting a PR. NEVER merge. PAT+curl fallback recipe: `docs/reference/release-workflow.md`.
- Handoff docs are tracked: `docs/handoff-*.md` committed; older ones `git mv`-ed into `docs/archive/handoffs/` — never deleted.
- Commit prefixes (from git log): `feat:` `fix:` `refactor:` `test:` `docs:` `release:` `sync:` `handoff:` `profile:`.

## Honest status

- Done = evidence: commands actually run with observed output, or a real A/B against the issue repro — never "should work". Label work tested / design-complete / deferred.
- Report doc-vs-repo drift when found instead of silently fixing it; problems discovered get an issue-trace (see `docs/reference/release-workflow.md`).

## Handoff protocol

- `/pickup` and `/handoff` bind through `.opencode/profiles/handoff-profile.md` (handoff_path, live_state, git_policy, timezone). Newest handoff wins; older ones are archived, never deleted.
