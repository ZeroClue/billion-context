# billion-context — release workflow & git safety (upstream-facing)

> Split from AGENTS.md (2026-09-25, /init-agents v1.0). Lazy companion: load
> before any version bump, release PR, acp-kernel pin change, or work on
> `src/update.ts`. This flow runs on the UPSTREAM repo (`ranxianglei/billion-context`,
> trunk `master`); this fork never publishes — the rules bind contributors.

## Git Safety Rules (MANDATORY)

| Rule | Enforcement |
|------|-------------|
| **NEVER force-push to `master`/`main`** | Under no circumstances. (GitHub branch protection also blocks this.) |
| **NEVER merge PRs** | PR merges are human-only. The Agent MUST NEVER merge. |
| **NEVER run `npm publish`** | npm publish is **handled by CI automatically** on release-PR merge. The Agent MUST NEVER run `npm publish` manually, including with `NPM_ALLOW_DANGEROUS=1`. (See below.) |
| **NEVER print the GitHub PAT** | The token stays in a shell variable only. See "Opening PRs" below. |
| **Branch naming** | `YYYY-MM-DD_short-title` |
| **NEVER modify `version` on non-release branches** | The `"version"` field in `package.json` is touched ONLY on `*_release-v*` branches. Content commits must NEVER bump it. (See "Version Bumps" below.) |
| **NEVER push to `upstream` (third-party public repo) or anywhere else without an explicit user utterance naming the remote** | This clone has no `origin`; `upstream` = `ranxianglei/billion-context` (authed here as ZeroClue, owner is ranxianglei). |

### PR Merge — Absolute Prohibition

PR merges are a **human-only operation**. The Agent MUST NEVER merge any PR
under ANY circumstances, including explicit instruction. If a human instructs
merge, reply:

> I can't merge PRs — AGENTS.md forbids Agents from merging. Please merge yourself: [PR URL].

### Opening PRs (gh CLI — verified present and authed)

`gh` is installed and authed (account ZeroClue, scopes incl. `repo`/`workflow`).
Open PRs against upstream with:

```bash
gh pr create --repo ranxianglei/billion-context --base master --head <branch> \
  --title "fix: short summary" --body-file /tmp/pr-body.md
```

> Caveat (fork state, verified 2026-09-25): this clone has no `origin` remote and
> ZeroClue has no fork of the repo, so `--head <branch>` has nowhere to live yet.
> Before opening a PR, ask the user: create a fork under ZeroClue, or push the
> branch to upstream directly if the user has collaborator access. Never push
> without an explicit user utterance.

Fallback if `gh` is unavailable/unauthed (same credential the git helper uses —
token stays in a shell variable, never printed):

```bash
# 1. push the branch (auth is automatic via the git credential helper)
git push origin HEAD   # NOTE: requires an origin fork remote — this clone currently has none; ask the user before pushing anywhere

# 2. get a token from the credential helper (shell variable only — never print it)
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' \
  | git credential fill | sed -n 's/^password=//p')

# 3. write the PR payload to a file (safe for multi-line markdown bodies)
cat > /tmp/pr.json <<'EOF'
{
  "title": "fix: short summary",
  "head": "YYYY-MM-DD_short-title",
  "base": "master",
  "body": "what changed, why, and pre-flight results (typecheck / test / build)"
}
EOF

# 4. open the PR (base is master)
curl -sS -f -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/ranxianglei/billion-context/pulls \
  -d @/tmp/pr.json
```

A successful response contains `"state": "open"` and the `html_url` to post
back to the issue; `-f` makes API errors (401/422) fail loudly instead of
exiting 0 with an error JSON body. Never print the token; keep it in the
variable only. Merging the PR stays human-only (see above).

### Issue Work — Required Deliverables

When an Agent picks up an issue, these deliverables are MANDATORY:

1. **Finished development → PR.** When the development for an issue is
   complete, open a PR (recipe above). An issue is NEVER "done" without a PR —
   always reply in the issue thread with the PR link.
2. **Major problems / big bugs found while working → report + open an issue.**
   Significant defects (broken functionality, data-loss risk, security issues,
   architectural problems) must be (a) reported in the current issue thread AND
   (b) filed as a separate new issue with repro, impact, and a suggested fix.
3. **Minor problems → report only.** Small issues (typos, cosmetic defects,
   minor UX quirks) are reported in the current issue thread only — do NOT
   open separate issues for them.

### Problem Discovery & Fix Reporting (MANDATORY)

Problems discovered or fixed while working MUST leave a trace in the issue
tracker — never fixed silently and moved on.

1. **Discovered a problem** (bug, defect, wrong behavior, spec violation) —
   whether while working on this project or any sibling project — file an
   issue in the project the problem belongs to: repro/steps, impact, root
   cause (if known), suggested fix.
2. **Fixed a problem** — after the fix, submit an issue to the owning project
   recording the problem and how it was fixed. For problems in this project:
   https://github.com/ranxianglei/billion-context/issues . If the fix ships as
   a PR, the PR MUST reference its issue (`Fixes #N`); a bare PR without an
   issue is not acceptable — file the issue first, then link it. An existing
   PR for the fix counts, but it should carry an accompanying issue.

### npm Publish — Absolute Prohibition

`npm publish` is **handled by CI automatically** (see below). The Agent MUST
NEVER run `npm publish` manually under ANY circumstances. This includes:

- **NEVER** use `NPM_ALLOW_DANGEROUS=1 npm publish` to bypass the guard
- **NEVER** use `npm pack` + manual install as a workaround
- **NEVER** bypass or attempt to bypass any npm guard or safety mechanism

If a human instructs manual publish, reply:

> I can't publish to npm — AGENTS.md forbids manual publishing. Releases are
> published automatically by CI when a release PR is merged. See the release
> workflow. If you need a manual fallback, please run `npm publish` yourself.

### Version Bumps — One Version, One Commit, One Branch

The `"version"` field in `package.json` is the **single source of truth** for
what gets published. It is touched by the standard release flow ONLY and
MUST NEVER be casually edited. Two hard rules:

1. **`version` changes ONLY on release branches** (named `*_release-v*`).
   Feature/fix/refactor/docs commits leave `version` untouched. If you find
   yourself editing `version` on a content branch, **stop** — you are on the
   wrong branch.

2. **A release commit changes ONLY `version`** (+ `package-lock.json` if it
   drifts). Never bundle a version bump into a content commit, and never
   bundle content changes into a release commit. One version bump = one
   isolated commit with message `release v{VERSION}`.

**Why this is load-bearing:** CI (`release.yml`) detects a release by matching
the branch name (`*_release-v*`) AND the commit message (`release v{VERSION}`).
Bundling version into a content commit breaks the trigger and causes
three-way merge conflicts on `package.json` when the release branch lands.

If a human asks to "just bump the version" inside a feature/fix change,
reply:

> Version bumps go through the standard release flow: a dedicated
> `*_release-v*` branch with an isolated `release v{VERSION}` commit. I can't
> bundle it into this change.

## Release Workflow

Releases are **fully automated via CI** (`.github/workflows/release.yml`).
The Agent prepares a release PR; merging it triggers CI which builds, tests,
publishes to npm, creates a git tag, and creates a GitHub Release. For
routine patch releases there is also a one-click fast path — see
"One-click manual release" below.

### Branch Naming

Release branches: `YYYY-MM-DD_release-v{VERSION}` (e.g., `2026-08-08_release-v0.1.17`)

### Process (exact steps)

The Agent does steps 1–5, the human does step 6 (merge).

1. **Sync master**:
   ```bash
   git checkout master && git pull --ff-only origin master
   ```
2. **Create the release branch** from master:
   ```bash
   git checkout -b $(date +%Y-%m-%d)_release-v{VERSION}
   ```
3. **Bump version** — edit ONLY the `"version"` field in `package.json`:
   ```diff
   -    "version": "0.1.16",
   +    "version": "0.1.17",
   ```
4. **Local pre-flight** — run the same checks CI runs:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
5. **Commit, push, open PR** — release-commit convention:
   - Message: `release v{VERSION}`
   - The commit changes ONLY `package.json` (+ `package-lock.json` if it
     drifts). Never bundle other changes into a release commit.
   - PR title: `release v{VERSION}`; body lists changes since last tag.
6. **Human merges the PR** (Agent MUST NOT merge).
7. **CI publishes automatically** — no manual `npm publish`:
   - On merge, `release.yml` detects the `*_release-v*` branch name +
     `release v{VERSION}` commit message.
   - It runs `npm ci` + `typecheck` + `test` + `build`, then
     `npm publish --tag latest` (using the `NPM_TOKEN` repo secret),
     creates git tag `v{VERSION}`, and creates a GitHub Release.
8. **Verify** the published version is live:
   ```bash
   npm view billion-context version
   ```

### One-click manual release (fast path)

For routine patch releases, skip the branch/PR dance: **Actions →
"Release (one-click)" → Run workflow** (`.github/workflows/release-manual.yml`).
The `version` input is optional — blank means auto next-patch over the npm
latest; type a full semver for minor/major/prerelease bumps. The workflow:

1. **Drift guard**: master's `package.json` version must equal the npm latest,
   else it aborts (never release off a drifted tree). It also rejects a target
   version that is already published.
2. Bumps ONLY `package.json` + `package-lock.json` and commits
   `release v{VERSION}` — the same one-version-one-commit discipline as the
   Version Bumps section above.
3. Runs the full pre-flight gate (`npm ci` + typecheck + test + build).
4. Pushes the release commit directly to `master` (GITHUB_TOKEN, fast-forward
   only). If branch protection blocks direct pushes, the release lands on a
   release branch instead and the run tries to open the release PR itself
   (best-effort — if the account forbids Actions-created PRs the run still
   finishes green with a one-click "open the release PR" link in the job
   summary). The fallback PR body carries a generated changelog (`git log`
   since the last release tag); the same notes appear in the job summary as
   a paste-ready block for opening the PR manually. Merging that PR publishes
   via the standard flow; red is reserved for real failures (guard trips,
   gate failures, or a failed branch push).
5. Publishes to npm (`latest`, or `dev` for prerelease), tags `v{VERSION}`,
   and creates the GitHub Release with notes generated from `git log` since
   the last tag.

A successful one-click run does NOT double-trigger `release.yml`: its check
only matches release-branch merges / date-prefixed commits, never a plain
`release v{VERSION}` commit. The standard branch/PR flow above remains the
canonical path for anything non-trivial (updater changes, cross-repo bumps,
or whenever a human wants the review gate).

### CI publish mechanism (what release.yml does)

- **Trigger**: push to `master` where the merge commit or branch name matches
  `*_release-v*`.
- **Prerelease handling**: if the version contains `-` (e.g. `0.1.17-beta.1`),
  publishes with `--tag dev` instead of `--tag latest`.
- **No publish step for the Agent**: the Agent never runs `npm publish`. The
  only manual fallback (if CI is down) is a human running `npm publish`.

### Cross-repo dependency: acp-kernel MUST ship first

`acp-kernel` is pinned in **devDependencies** (exact version `0.0.80`, no `^`)
and **bundled inline** at build time, so `dist/index.js` is self-contained.

⚠️ **When bumping the acp-kernel dependency version:**
1. Release `acp-kernel` first (merge its release PR, wait for CI publish).
2. **Verify it is live on npm:** `npm view acp-kernel version` returns the new version.
3. THEN bump `acp-kernel` in this repo's `package.json` and release billion-context.

Rationale: billion-context CI runs `npm ci`, which installs the exact
`acp-kernel` version pinned in `package.json`. A release branch that bumps
`acp-kernel` to a not-yet-published version fails CI at install time.

### Auto-update testing

To test that a running older version auto-updates to a newer registry version:

```bash
# 1. Install older version from registry
npm install -g billion-context@0.1.16

# 2. Merge the newer release PR (HUMAN merges) — CI publishes 0.1.17 to npm.

# 3. Start the older version
bili start --port 19195
# Within ~10s (startup check) it detects 0.1.17 and installs it, logging:
#   ✔ billion-context auto-updated 0.1.16 → 0.1.17. Restart bili to finish.
```

### ⚠ Releasing changes to the auto-update mechanism itself

**The auto-update code (`src/update.ts`) is load-bearing for every future
upgrade.** If a release ships a broken auto-update, users who install it become
**permanently stuck** — they can never auto-update again (the broken thing is
the updater itself), and many will never notice to manually reinstall. This is
strictly worse than a normal bug: a normal bug affects one feature; a broken
updater silently bricks the upgrade path for everyone who hits it.

**Therefore: any change to `src/update.ts` (the download / extract / install /
version-check logic) MUST be validated with a no-op release BEFORE shipping the
change.** The sequence is:

1. **Ship a no-op release first** (pure version bump, zero code changes) — this
   proves the *existing* upgrade path is healthy end-to-end: the currently-
   installed version auto-updates to the no-op release using the *old* code.
   - Branch: `YYYY-MM-DD_release-v{VERSION}` (same naming convention).
   - Commit: `release v{VERSION}` (version bump only).
   - PR body MUST state it is a no-op and why (validation release).
2. **Only after the no-op release is confirmed on npm** (`npm view
   billion-context version` returns it) AND a real upgrade has been observed
   succeeding (the log shows `auto-updated OLD → NEW`), ship the actual change
   as a separate subsequent release.
3. If the no-op release's upgrade **fails**, STOP. Do not ship the updater
   change. Investigate the existing-path failure first — the existing code is
   the only known-good upgrade path, and shipping a change on top of an
   already-broken path compounds the problem.

**Why the indirection?** Because if the change-to-the-updater is itself buggy,
   anyone who upgrades to it is bricked. The no-op release isolates the test:
   it exercises the upgrade path using code we already trust, so a success
   confirms the *plumbing* (registry, tarball, file copy, restart) works,
   independent of the new code. Only then do we trust the new code to run on
   the next hop.

**Concrete example (v0.1.22):** the Windows auto-update fix (replacing
`execFile("tar"/"cp")` with the `tar` npm package + `fs.cp`) was staged in
PR#44 but NOT shipped directly. A no-op v0.1.22 (PR#46, version bump only)
was released first to confirm the running v0.1.21 could self-upgrade. Only
after that succeeded was the Windows fix shipped in a follow-up release.
