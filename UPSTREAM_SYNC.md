# Upstream Sync Procedure

> **Purpose**: Document the process for periodically syncing this fork with upstream (billion-context/billion-context) while preserving fork-specific features.

---

## Repository Structure

| Branch | Purpose |
|--------|---------|
| `main` | Fork's working branch (production-ready) |
| `upstream-sync` | Integration branch: upstream/master + fork features applied |
| `upstream-baseline` | Tag/branch marking the fork point (upstream v0.1.99) |
| `fork-baseline` | Tag marking current fork state before sync |

---

## One-Time Setup (Already Done)

```bash
# 1. Add upstream remote
git remote add upstream https://github.com/ranxianglei/billion-context.git
git fetch upstream

# 2. Create integration branch from upstream/master
git checkout -b upstream-sync upstream/master

# 3. Enable git rerere for conflict resolution reuse
git config rerere.enabled true

# 4. Apply fork features as logical commits (see commit efb3512)
#    - New files: analytics.ts, metrics.ts, strip-images.ts, weak-overflow.ts, config-env.ts
#    - Web UI: English dashboard, API endpoints, 15s polling
#    - Server: admin endpoint fix (API handlers before origin check)
#    - Agent: OpenCode V2 plugin support
#    - Types: updated metrics.ts for upstream Session type

# 5. Tag the fork baseline
git tag fork-baseline
```

---

## Periodic Sync Workflow (Monthly)

### 1. Update Upstream
```bash
git fetch upstream
```

### 2. Rebase Integration Branch
```bash
git checkout upstream-sync
git rebase upstream/master
# Conflicts auto-resolved via rerere for repeated patterns (server.ts split, etc.)
```

### 3. Review New Upstream Commits
```bash
# Since last sync tag
git log --oneline upstream-sync-YYYY-MM-DD..upstream/master \
  --grep="fix\|feat\|refactor" \
  -- src/ | head -50
```

### 4. Identify High-Value Commits
Priority categories:
| Priority | Categories | Examples |
|----------|------------|----------|
| 🔴 HIGH | Stability, correctness, kernel bumps | Compress loop guards, preflight window clamp, session lock shrink, null-body logging, acp-kernel pins |
| 🟡 MEDIUM | Features, quality | acp_rule/protectedLatestTools, image billing modes, output headroom config, weak-overflow fixes |
| 🟢 LOW | Agent-specific (if used) | Google/Gemini wire, Kimi/OMP/DSH native plugins |
| ⚪ SKIP | Windows-only, encryption (fork has own), unused agents | Windows spawn fixes, session encryption |

### 5. Cherry-Pick / Backport to Main
```bash
git checkout main
git cherry-pick <sha>  # or manual backport for complex changes
# Test: npm run build && npm run typecheck
```

### 6. Tag Sync Point
```bash
git tag upstream-sync-$(date +%Y-%m-%d)
```

---

## Conflict Resolution Guide

### Repeated Conflicts (auto-resolved via `rerere`)
| File | Pattern | Resolution |
|------|---------|------------|
| `src/server.ts` | Admin origin check location | Keep API handlers before origin check |
| `src/web/page.ts` | English vs Chinese UI | Keep English version |
| `src/agent/opencode.ts` | V2 plugin imports | Add `getDashboardUrl` to shared.ts |

### New Conflicts (manual)
1. **Check if upstream added the feature** — if yes, prefer upstream implementation
2. **Preserve fork-specific behavior** — English UI, analytics, metrics endpoints
3. **Update types** — upstream Session type changes require metrics.ts updates
4. **Run typecheck** — `npm run typecheck` must pass

---

## Cherry-Pick Log Template

| Upstream SHA | Title | Status | Fork Files Modified | Notes |
|--------------|-------|--------|---------------------|-------|
| `46cb9e8` | compress failure loops | 🔴 pending | preflight.ts, stream.ts | Backport manually |
| `064b3ad` | preflight window clamp | 🔴 pending | preflight.ts | |
| `16dac72` | shrink session lock | 🔴 pending | session.ts | |
| `3c195d9` | null-body logging | 🔴 pending | stream.ts, server.ts | |
| `9c1c953` | kernel 0.0.80 pin | 🟡 pending | package.json | Already on upstream-sync |

---

## Verification Checklist (After Each Sync)

- [ ] `npm run build` succeeds
- [ ] `npm run typecheck` passes
- [ ] Proxy starts: `node dist/index.js start --port 8800 --host 127.0.0.1`
- [ ] `/__bili/api/stats` returns `ok: true` + metrics
- [ ] `/__bili/api/metrics` returns Prometheus format
- [ ] Dashboard UI loads at `/__bili/` (English text)
- [ ] Analytics DB created at `~/.billi/data/bili-analytics.db`
- [ ] No regression in existing functionality

---

## Fork Features Inventory (Must Preserve)

| Feature | Files | Description |
|---------|-------|-------------|
| English Dashboard | `src/web/page.ts`, `src/web/client.ts` | Full English UI, 15s polling, dashboard tab |
| Metrics API | `src/web/api.ts`, `src/metrics.ts` | `/api/stats` (JSON), `/api/metrics` (Prometheus) |
| SQLite Analytics | `src/analytics.ts` | Persistent snapshots, 50-session sampling, 90-day retention |
| Config Env | `src/config-env.ts` | Centralized `biliEnv` for runtime config |
| Admin Endpoint Fix | `src/server.ts` | API handlers before origin check |
| OpenCode V2 Plugin | `src/agent/opencode.ts`, `src/agent/shared.ts` | `bili-dashboard` command, native tool forwarding |
| Version Metadata | `src/acp-status.ts` | `pack` + `host` in status output |
| Docker Support | `Dockerfile`, `.dockerignore` | Multi-stage build, native module rebuild |

---

## Quick Reference Commands

```bash
# Full sync cycle
git fetch upstream
git checkout upstream-sync
git rebase upstream/master
# resolve conflicts if any
git checkout main
# cherry-pick high-value commits
git tag upstream-sync-$(date +%Y-%m-%d)

# Test
npm run build && npm run typecheck
node dist/index.js start --port 8800 --host 127.0.0.1 &
sleep 2
curl -s http://127.0.0.1:8800/__bili/api/stats | jq .ok
curl -s http://127.0.0.1:8800/__bili/api/metrics | head -5
```

---

## Emergency Rollback

```bash
# If sync breaks main
git checkout main
git reset --hard fork-baseline
npm run build
```