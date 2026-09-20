# Handoff — fresh-session pickup (2026-09-20 09:18 local)
	Context: continues session upstream-sync. Read AGENTS.md + /pickup for standing rules; this doc covers ONLY what changed since docs/handoff-2026-09-20-0911-upstream-sync.md.

## Done / washed-out threads (since previous handoff)
- **Created handoff-profile.md** with upstream check in live_state — evidence: `cat .opencode/profiles/handoff-profile.md` shows `git fetch upstream && git log --oneline HEAD..upstream/master -- src/`
- **Recorded git_policy** — commits approved 2026-09-20 — evidence: `git log --oneline -1` shows `c9c652b profile: add handoff-profile.md`

## Open threads (ranked, top 3-5, each with 1-line verification)
- **Monthly upstream merge** — verify: `git fetch upstream && git merge upstream/master` (should be clean) — In-flight? No — first merge due ~2026-10-20, now 1 new commit on upstream: `c56fd04 fix: failed compress receipts name the live compressible span (#1026)`
- **Optional: Per-session Prometheus labels** — verify: `curl -s http://127.0.0.1:8800/__bili/api/metrics | grep 'bili_session_'` — In-flight? No — low priority
- **Cherry-pick reference** — verify: `git log --oneline upstream-baseline..upstream/master --grep="compress-loop\|preflight\|session-lock\|null-body\|kernel"` — In-flight? No — user chose full sync, optional for future

## Standing decisions (NEW only)
- **Handoff profile** at `.opencode/profiles/handoff-profile.md` — auto-surfaces upstream src/ deltas on /pickup
- **Upstream sync procedure** at `UPSTREAM_SYNC.md` — includes branch strategy, conflict guide, cherry-pick log template

## Archive pointers
- previous handoffs moved to `docs/archive/handoffs/` (when archived — never deleted).
- Previous: `docs/handoff-2026-09-20-0911-upstream-sync.md` (to be archived)

## Unresolved / in-flight / stale
- **Docker proxy instances** may be running on :8800, :8801 — `curl -s http://127.0.0.1:8800/__bili/stats` returns session data (check live state on pickup)
- **Analytics DB** at `~/.billi/data/bili-analytics.db` functional
- **Git clean** — no uncommitted changes on `main`
- **No agents running** at handoff time
- **Upstream delta**: 1 new commit `c56fd04` (compress receipts fix) — not yet merged