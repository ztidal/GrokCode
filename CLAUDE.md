# ZtidalCode

A fork of [`3xian/PinkCode`](https://github.com/3xian/PinkCode) — a Tauri 2 + React desktop GUI for xAI's
Grok Build coding agent, driven over ACP (`grok agent stdio`) — hardened for team use and published under
its own name, for Windows and macOS. `origin` is the public `ztidal/ZtidalCode`, whose default branch is
`hardening`; `upstream` is the original repository, merged from `upstream/main`. Releases are not cut
here: installers and the update feed live in `ztidal/ZtidalCode-dist`.

Read `CONTEXT.md` for vocabulary and `docs/adr/` before changing anything about permissions, the fork's
relationship to upstream, or naming. Several things that look like oversights are decisions.

## Build

```bash
npm ci
npm run build          # tsc + vite
npm test               # vitest
npm run check:rust     # cargo fmt + clippy -D warnings + cargo test
```

Release bundles must be built through the identity overlay, or they carry upstream's name and updater:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat /path/to/ztidalcode.key)"   # contents — Tauri ignores _PATH
npm run tauri -- build --config branding/ztidalcode.json
```

Releases go through `npm run release -- --help`: it builds from a clean detached worktree and
refuses, by design, each mistake that has already shipped once by hand.

See `branding/README.md`. Without a signing key, add
`--config '{"bundle":{"createUpdaterArtifacts":false}}'` to skip update artifacts — the result installs but
can never be updated in place.

## Keeping up with upstream

```bash
git fetch upstream && git merge upstream/main
```

Conflicts should be confined to version bumps in `package.json` / `Cargo.toml` / `tauri.conf.json`, plus
one deliberate modify/delete: upstream's `.github/workflows/release.yml`, `pages.yml`,
`fix-updater-json.yml` and `site/` are removed here on purpose (they would publish builds and a website
from this repository; releases come from `npm run release`), so keep the deletion whenever upstream
edits them. Never push tags wholesale (`--tags`, `--follow-tags`): upstream's tags are in this clone and
each would trigger a run of the workflow file at that tag. If a
merge wants to change `config.rs`, `plan_file_policy.rs`, `task_prefs.rs`, `auth.rs` or `watcher.rs`,
read the ADRs first — those files carry the hardening and upstream has historically not touched them.
`watcher.rs` is the newest of them: it learned to report a session directory going away, which is what
lets a deleted task leave the list.

## Agent skills

### Issue tracker

Bug reports and feature requests are GitHub Issues on `ztidal/ZtidalCode`. `.scratch/<slug>/` holds what
is not an issue — specs, measurements, parked investigations and hand-off notes — versioned next to the
code they describe. See `docs/agents/issue-tracker.md` for which goes where.

### Triage labels

The five canonical roles, each label string equal to its name, applied as labels on the GitHub issue. A
`Status:` line near the top of a `.scratch/` file says where that effort stands, in plain words. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
