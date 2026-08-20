# Issue tracker: Local Markdown

Issues and specs (you may know a spec as a PRD) for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` — never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## Why local markdown for this repo

This repo is a fork of [`3xian/PinkCode`](https://github.com/3xian/PinkCode) maintained for internal hardening
and packaging. Local markdown was chosen over GitHub Issues for two reasons:

1. GitHub disables Issues on forks by default (`has_issues: false` on `ztidal/PinkCode`), so the GitHub
   route needs a repository settings change before it works at all.
2. The fork is public — GitHub's forks of public repositories cannot be made private — so issues filed
   there would be publicly visible, which is a poor fit for internal security-hardening work.

### Switching to GitHub later

If the fork is replaced by a private mirror, or you decide public issues are acceptable:

1. Enable Issues on the repo: `gh api -X PATCH repos/ztidal/PinkCode -f has_issues=true`
2. Replace this file with the GitHub template from the `setup-matt-pocock-skills` skill folder
   (`issue-tracker-github.md`).
3. Create the four missing triage labels (`wontfix` already exists on this fork — see `triage-labels.md`).
