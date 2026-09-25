# billion-context — review & auto-merge discipline

> Split from AGENTS.md (2026-09-25, /init-agents v1.0). Lazy companion: load
> before opening a PR, claiming "mergeable", or deciding auto-merge vs human
> review. Full cited history: `AUTO-MERGE-GUARDRAILS.md`.

Distilled from a full-history review of AI auto-dev across billion-context /
billion-context-pi / acp-kernel (#801): 1543 issues+PRs, 3645 comments,
`devlog/`, and AGENTS.md's own git history. Goal: ~90% of bugfixes mergeable
without rework, without drifting off direction.

## 7.1 Before You Start

- **Duplicate screening first.** Search open AND closed issues/PRs for the same
  fix before implementing. If one exists, link it; do not start parallel work.
- **One issue = one scope.** Split extra findings into separate issues/PRs.
  Never bundle unrelated changes or mass whitespace/reformatting into a fix.
- **Open a PR, never just push a branch.** A bare branch is not a deliverable.

## 7.2 Review Discipline

- **Rebase to CURRENT master before claiming mergeable.** Verify against the
  live master, not the PR's original base. After rebase, re-run typecheck +
  full test suite + build. A stale base is the single biggest cause of
  second-round rework (#425 Aug-31 base, #467 43 commits behind, #517).
- **Watch hot-file contention.** `src/server.ts`, the preflight paths,
  `src/persist.ts`, and the `src/agent/*` extension types are touched by many
  concurrent PRs. If another open PR rewrites the same file/region, expect a
  semantic (not textual) conflict — coordinate/sequence, resolve by union of
  intent, then prove it by running tests (#517↔#587, #571↔#558).
- **One linear commit, clean diff.** No merge commits or rebases that explode
  the diff and bury the real change; no incidental whitespace re-alignment.
  Every line must relate to the PR's purpose (#571 "diff-爆炸", #467).
- **Done = evidence, not "should work".** Double-review the code, then actually
  run the changed behavior and observe it matches expectation. For fixes that
  change context/wire behavior, prefer a real end-to-end A/B against the issue
  repro over unit tests alone (#254).
- **Tests must be deterministic.** No assertions that depend on environmental
  luck (e.g. assuming a port range is free — Windows' ephemeral range
  49152–65535 collides with fixed picks; request a port via `listen(0)`
  instead, #360).

## 7.3 Correctness Guardrails

- **Never silently clobber or drop user config.** Any read-modify-write on user
  config needs a parse-state guard; reject malformed input loudly (HTTP 400/409)
  instead of merging into defaults or dropping fields. Whitelists must be
  complete (#155: a missing key silently erased custom compress prompts).
- **Sane defaults & fallbacks.** Fallback values must be reasonable (never a
  too-small value that causes thrashing); a static/fallback source must always
  lose to a fresher authoritative source when both are cheaply available
  (#282: window fallback 200K/min 100K, not 64K; the bundled registry snapshot
  must not outrank the live registry).
- **Prefer native stable identifiers.** Use a client's native stable session id
  when available (it survives credential/model/provider switches); report
  clients that expose none. Do not build identity from derived hashes that
  drift on switch (#280).
- **Wire fidelity (host-side duty).** Never alter upstream protocol shape beyond
  intended injection: preserve tool_call ids/ordering, SSE structure, and
  upstream invariants (e.g. `compaction_trigger` must remain the last input
  item, #283/#209). Reason in BOTH compression modes (see
  `docs/reference/architecture.md`).
  - *Kernel-owned split:* the FORMAT CONTRACT of the kernel-emitted ACP
    artifacts (the compression tags, block refs, `acp_summary` structure) and
    the **id-never-reused guarantee** belong to **acp-kernel**, not this repo.
    This repo only consumes them faithfully. Codifying the kernel-side spec is
    a separate acp-kernel change — deferred; cross-repo work stays manual for
    now.
- **Symptom ≠ mechanism.** Before attributing a bug to bili's mechanism, verify
  against upstream logs — repeated-compression logs may be an upstream rate-limit
  retry illusion, not over-compression (#282).
- **Honest output.** Never emit misleading messages for degenerate states
  (#155: export claimed "original conversation" for a 0-block session).
- **Logs.** Mask secret values in all logs; separate trace/debug/info; keep
  debug-on by default during bug-convergence phases (#247).
- **Docs.** Keep zh/en in sync; place content where the actual reader will see
  it; mirror env-var references into CONFIGURATION.md, not just one README
  (#571).

## 7.4 Auto-Merge Gate (this repo only)

A bugfix may **auto-merge** only if ALL hold:

1. Single-module scoped fix; no architectural change.
2. A regression test reproduces the original bug and now passes.
3. Green **on the rebased head** (typecheck + full test suite + build).
4. No change to: config schema, persistence format/version, wire protocol /
   message shape, or cross-repo dependencies (acp-kernel).
5. Pure `fix:` — no new capability surface (not feat/refactor).
6. Clean diff: no unrelated changes, no mass whitespace/reformat, no generated
   or lock-file churn.
7. References its issue via `Fixes #N`.
8. Does NOT touch load-bearing infra: `src/update.ts`, release workflow, CI
   publish, the acp-kernel pin, message-ref/id logic, or security (MITM/CA/
   credentials).

**Must stay human** (any hit): wire/message-shape changes (both modes affected),
config schema or persistence version, cross-repo dependencies, `src/update.ts`
(needs a no-op release first), identity/session-binding logic, feat/refactor/
architecture, security-related, or any fallback/default-value change (a product
decision).

> **Scope note:** auto-merge applies to THIS repo only. Cross-repo changes
> (acp-kernel bumps, anything spanning repos) remain manual/human for now.

## 7.5 Reviewer Focus — the "重灾区" (second-round zones)

Of 326 analyzed merged PRs, 26 (~7%) needed a second+ human review round. Two
drivers dominate, and they are exactly where auto-merge is unsafe:

1. **Stale-base / concurrent-file churn** — long-lived branches drift from
   fast-moving master and collide with other PRs on hot files. Gate signals:
   branch freshness, and whether a touched file is being rewritten by another
   open PR.
2. **Incomplete first pass** — the initial fix addresses the reported symptom
   but misses an adjacent path/edge case, leaves promised work unfinished, or
   needs its approach reconsidered. Gate signal: does the fix cover ALL paths of
   the bug, not just the repro?

These map directly onto §7.2–§7.3; a reviewer walks those bullets in order.
