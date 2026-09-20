# Handoff Profile — billion-context Fork

workspace: .
persona: session coordinator
handoff_path: docs/handoff-<YYYY-MM-DD>-<HHMM>-<topic>.md
live_state: |
  git status --short
  git fetch upstream 2>/dev/null && git log --oneline HEAD..upstream/master -- src/ | head -20
git_policy: commits approved 2026-09-20
standing_rules: |
  - Monthly upstream sync per UPSTREAM_SYNC.md
  - UPSTREAM_SYNC.md § "Periodic Workflow" for merge/cherry-pick steps
  - Fork features must be preserved: English UI, metrics API, analytics, V2 plugin, Docker