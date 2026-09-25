# handoff-profile — billion-context fork bindings for /pickup and /handoff

- workspace: /home/arminm/projects/billion-context-fork (if cwd is not inside it, cd there)
- persona: session coordinator
- herdr: none (only consider a herdr binding if HERDR_ENV=1)
- handoff_path: docs/handoff-<YYYY-MM-DD>-<HHMM>-<topic>.md (dated; topic = one word)
- handoff_discovery: `ls -t docs/handoff-*.md | head -1` — read ONLY the newest; older handoffs live in docs/archive/handoffs/
- live_state: `git status --short`; `git fetch upstream 2>/dev/null && git log --oneline HEAD..upstream/master -- src/ | head -20`; `curl -s http://127.0.0.1:8800/__bili/stats` if a proxy instance is expected
- git_policy: commits approved 2026-09-20, reconfirmed 2026-09-25 — commit handoff docs (after `git mv`-ing older `docs/handoff-*.md` into `docs/archive/handoffs/`, mkdir -p first); NEVER push (no origin; upstream is third-party) unless the user says so; report the commit hash
- agents_version: v1.0 (2026-09-25) — mirrors the AGENTS.md stamp; re-sync on refresh
- comms: none
- standing_rules: see AGENTS.md (safety invariants + fork-feature preserve list + token economics)
- report_format: ≤8 lines: upstream delta since last handoff; WIP/open-thread status; live-state surprises; top open question
- timezone: local system time, SAST (+0200) — HH:MM in handoff titles
