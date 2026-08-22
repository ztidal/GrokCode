# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## How labels are applied in this repo

Bugs and requests live in GitHub Issues, where these are ordinary labels. Specs and working notes
under `.scratch/` (see `issue-tracker.md`) carry the same vocabulary as a `Status:` line near the top of
the file, so an agent reading either place sees one set of roles:

```markdown
# 01 — Repoint the updater at our own release feed

Status: ready-for-agent
```

On GitHub the fork inherited a `wontfix` label from upstream, reused as-is; the other four
(`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`) are created with `gh label create`
the first time they are needed.
