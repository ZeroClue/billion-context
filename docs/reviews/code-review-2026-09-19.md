# Code Review — 2026-09-19

**Fixed point**: `upstream-baseline` (6282f35 - v0.1.99)
**Diff**: `git diff upstream-baseline HEAD`
**Spec sources**: ROADMAP.md, HANDOFF.md, CHANGELOG.md

---

## Standards Review

### Baseline Smells (Judgement Calls)

| Smell | Location | Description |
|-------|----------|-------------|
| **Duplicated Code** | `src/agent/opencode.ts:135-155`, `src/agent/pi.ts:395-425` | Dashboard URL construction and OS-specific open commands duplicated across agents |
| **Primitive Obsession** | Multiple files | Dashboard URL built via string concatenation `${proxyBase}/__bili/` instead of URL helper |
| **Shotgun Surgery** | `opencode.ts`, `pi.ts`, `shared.ts` | Adding dashboard command required edits across 3+ files |
| **Data Clumps** | `server.ts`, `metrics.ts`, `analytics.ts` | Related env vars (`BILI_ADMIN_TOKEN`, `BILI_ALLOW_REMOTE_ADMIN`, `BILI_METRICS_CACHE_TTL_MS`, etc.) scattered |

### Documented Standards (AGENTS.md) — ✅ All Passed
- Uses `log()` from `logger.ts`, never `console.log`
- No test suite — manual verification via curl
- MITM domain at launch time (not in config)
- `better-sqlite3` external in `tsup.config.ts`
- TypeScript ESM, Node 20+ target

**Hard violations**: 0
**Judgement calls**: 4

---

## Spec Review

### Spec Requirements → Implementation Status

| Requirement | Status | File/Notes |
|-------------|--------|------------|
| English dashboard UI | ✅ | `src/web/page.ts`, `client.ts` |
| `/__bili/api/stats` endpoint | ✅ | `src/web/api.ts` |
| `/__bili/api/metrics` endpoint | ✅ | Prometheus format |
| SQLite analytics (`~/.billi/data/bili-analytics.db`) | ✅ | 4 tables, 90-day retention |
| Metrics caching (5s TTL) | ✅ | `src/metrics.ts` |
| HistoryMap pruning (48h) | ✅ | Configurable via `BILI_HISTORY_MAX_HOURS` |
| Dashboard poll 5s → 15s | ✅ | `src/web/client.ts` |
| Session sampling in snapshots | ✅ | Reservoir sampling (was top-50) |
| Admin origin check fix | ✅ | Moved routes before check in `server.ts` |
| Metrics cache invalidation | ✅ | `markDirty()` hook in `session.ts` |
| Visibility-aware polling | ✅ | `document.visibilityState` |
| Reservoir sampling | ✅ | Fair representation in `analytics.ts` |
| Prometheus `?fresh=1` | ✅ | Both endpoints |
| Env vars for TTL/prune/sample | ✅ | `BILI_METRICS_CACHE_TTL_MS`, `BILI_HISTORY_MAX_HOURS`, `BILI_MAX_SESSIONS_PER_SNAPSHOT` |
| Docker support | ✅ | `Dockerfile`, `docker-compose.yml`, `.env.example` |
| Project-level plugin install | ✅ | `--project` flag for opencode/pi |
| Launcher proxy URL file | ✅ | `~/.bili/state/proxy-url.txt` |
| Opencode v2 dashboard command | ✅ | V1 `/bili-dashboard` + V2 tool |
| Pi/omp dashboard command | ✅ | `/bili-dashboard` in `pi.ts` |
| Complete English UI translation | ✅ | All Chinese strings replaced |

**Missing from original spec**: None — all 22 requirements implemented.

### Implementation Issues Found

1. **Docker analytics DB fails**: `better-sqlite3` native module not found in runtime stage (warning in logs)
2. **Opencode v2 tool registration**: Uses optional chaining on `ctx.tool.transform` — correct but undocumented version compatibility

---

## Action Plan

### From Standards Review (Code Quality)

| Priority | Task | Effort | Status |
|----------|------|--------|--------|
| **High** | Extract shared dashboard URL helper to `src/agent/shared.ts` | ~30 min | ☐ |
| **Medium** | Group related env vars into config object/module | ~1 hr | ☐ |

### From Spec Review (Correctness)

| Priority | Task | Effort | Status |
|----------|------|--------|--------|
| **High** | Fix Docker analytics: add `npm rebuild better-sqlite3` in runtime stage | ~30 min | ☐ |
| **Medium** | Document opencode v2 tool registration version compatibility | ~15 min | ☐ |

### Quick Wins

- [ ] Remove `.env` from repo (keep `.env.example` only)
- [ ] Add `CHANGELOG.md` link to README

### Verification Commands

```bash
# 1. Extract shared dashboard helper
# Edit src/agent/shared.ts - add getDashboardUrl(proxyBase) function
# Update opencode.ts and pi.ts to import and use it

# 2. Fix Docker analytics
# Edit Dockerfile: add `RUN npm rebuild better-sqlite3` in runtime stage after COPY

# 3. Verify
npm run build
docker build -t billion-context:test .
docker-compose up -d
curl -s http://localhost:8800/__bili/api/stats | jq .ok
```

---

## Archive Note

This review was generated on 2026-09-19 comparing against upstream-baseline (v0.1.99, tag 6282f35). Once action items are complete, this file can be archived or deleted.