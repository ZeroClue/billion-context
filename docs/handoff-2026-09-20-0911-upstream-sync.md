# Handoff — fresh-session pickup (2026-09-20 09:11 local)
	Context: continues session upstream-sync. Read AGENTS.md + /pickup for standing rules; this doc covers ONLY what changed since docs/handoff-2026-09-19-2231-env-config-opencode-docs.md.

## Done / washed-out threads (since previous handoff)
- **Fixed admin endpoint 404** — moved `/__bili/api/stats` and `/__bili/api/metrics` handlers before origin check in `src/server.ts` — evidence: `curl -s http://127.0.0.1:8800/__bili/api/stats | jq .ok` returns `true`
- **Full upstream sync** — created `upstream-sync` branch from `upstream/master` (v0.1.127), applied all fork features, merged back to `main` (553 upstream commits integrated) — evidence: `git log --oneline -3` shows fork commits `bf75dec`, `efb3512` atop upstream `af42145`
- **Created UPSTREAM_SYNC.md** — complete sync procedure with conflict resolution, cherry-pick log template, verification checklist — evidence: `cat UPSTREAM_SYNC.md`
- **Updated AGENTS.md §8** — lazy-loaded reference to UPSTREAM_SYNC.md (avoids context bloat) — evidence: `grep -A 20 "## 8. Upstream Sync" AGENTS.md`
- **Enabled git rerere** — auto-resolves repeated server.ts/UI conflicts on future syncs — evidence: `git config rerere.enabled` returns `true`
- **Tagged fork-baseline** — rollback point for pre-sync state — evidence: `git tag -l | grep fork-baseline`

## Open threads (ranked, top 3-5, each with 1-line verification)
- **Cherry-pick HIGH-priority upstream fixes to main** (if not using full sync) — verify: `git log --oneline upstream-baseline..upstream/master --grep="compress-loop\|preflight\|session-lock\|null-body\|kernel"` — In-flight? No — user chose full sync (Option A), so this is optional for future reference
- **Monthly upstream merge** — verify: `git fetch upstream && git merge upstream/master` (should be clean) — In-flight? No — first merge due ~2026-10-20
- **Optional: Per-session Prometheus labels** — verify: `curl -s http://127.0.0.1:8800/__bili/api/metrics | grep 'bili_session_'` — In-flight? No — low priority

## Standing decisions (NEW only)
- **Upstream sync procedure** documented at `UPSTREAM_SYNC.md` — includes branch strategy, conflict guide, cherry-pick log template, verification checklist
- **Fork features inventory** in UPSTREAM_SYNC.md § "Fork Features Inventory (Must Preserve)" — 8 items including English UI, metrics API, analytics, V2 plugin, Docker
- **Code review findings** at `docs/reviews/code-review-2026-09-19.md` — 4 baseline smells, 0 hard violations, 22/22 spec requirements met

## Archive pointers
- previous handoffs moved to `docs/archive/handoffs/` (when archived — never deleted).
- Previous: `docs/handoff-2026-09-19-2231-env-config-opencode-docs.md` (to be archived)

## Unresolved / in-flight / stale
- **Docker proxy instances** may be running on :8800, :8801 — `curl -s http://127.0.0.1:8800/__bili/stats` returns session data (check live state on pickup)
- **Analytics DB** at `~/.billi/data/bili-analytics.db` functional
- **Git clean** — no uncommitted changes on `main`
- **No agents running** at handoff time