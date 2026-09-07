# Issue tracker: GitHub Issues, with `.scratch/` for what is not an issue

Bug reports and feature requests for this repo are GitHub Issues on
[`ztidal/GrokCode`](https://github.com/ztidal/GrokCode/issues). Specs (you may know a spec as a PRD),
measurements, comparisons and hand-off notes live as markdown under `.scratch/<slug>/` in this repo,
versioned beside the code they describe. The two are not interchangeable: an issue is something that gets
closed, a note is something that stays true.

## Which goes where

| | Goes to | Because |
|---|---|---|
| Something is broken, missing or wrong, and someone should act on it | a GitHub Issue | It has a reporter and an end; labels, cross-references and notifications work; people outside the repo can file it and follow it |
| A spec for work about to be done | `.scratch/<slug>/spec.md` | It is read during the work and stays as the record of why the code is shaped as it is; the work it implies gets issues of its own |
| A finding that cost real effort to measure and must not be re-derived | `.scratch/<slug>/findings.md`, or a name that says what it is | There is nothing to close — see `grok-wire-names/spec.md` and `rename/findings.md` |
| A hand-off in the middle of a release or an effort | `.scratch/<slug>/handoff.md` | It tells the next session where things stand and what is left to do |

An issue may point at a `.scratch/` file and a `.scratch/` file may point at an issue, but a `.scratch/`
file is never the only record of a bug.

## `.scratch/` conventions

- One effort per directory: `.scratch/<slug>/`.
- The spec is `spec.md`; other files are named for what they are (`findings.md`, `handoff.md`, `map.md`).
- A `Status:` line near the top says where the effort stands, in words — `Parked — the name is
  undecided`, `held, awaiting the user's own check`. The triage roles in `triage-labels.md` are labels
  for issues, not values for this line.
- Everything under `.scratch/` is committed, and the repository is public. Working files that should not
  be published — logs, builds, a clone of the dist repo — belong in the session scratchpad outside the
  repository, and a `.scratch/` file may refer to them by location but never carry them.

## When a skill says "publish to the issue tracker"

Create a GitHub Issue and apply the triage label from `triage-labels.md`:

```bash
gh issue create --repo ztidal/GrokCode --title "<title>" --body-file <file> --label <triage label>
```

If what the skill produced is a spec rather than a ticket, write it to `.scratch/<slug>/spec.md` and open
one issue per piece of work it implies — never a single combined issue.

## When a skill says "fetch the relevant ticket"

```bash
gh issue view <number> --repo ztidal/GrokCode --comments
```

The user will normally pass the number or the URL. A path under `.scratch/` is a note, not a ticket: read
the file.

## Wayfinding operations

Used by `/wayfinder`. These tickets are questions one session claims and answers inside one effort. They
stay as files because they are working notes, not reports: nobody outside the effort needs to follow
them, and they are finished when the map is.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## What moved, and what did not

Until the repository went public, this file said that every ticket was a markdown file —
`.scratch/<slug>/issues/NN-<slug>.md`, with the triage role on its `Status:` line — because GitHub Issues
was disabled on the repository at the time and the hardening work was not yet public. Issues is enabled
now. Implementation tickets, bug reports and requests are GitHub Issues, and the triage role is a label on
the issue rather than a line in a file. Specs, findings, hand-offs, the `Status:` line on a note and the
wayfinding files are where they were. No ticket file was ever committed under the old path, so there is
nothing to migrate.
