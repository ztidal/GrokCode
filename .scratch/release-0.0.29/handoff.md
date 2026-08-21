# Release 0.0.29 — built, installed, not published

Status: **held, awaiting the user's own check.** Everything before the
outward-facing step is done.

## What is ready

| | |
| --- | --- |
| Bundles | `src-tauri/target/release/bundle/{nsis,msi}/ZtidalCode_0.0.29_*` — signed |
| Feed | `latest.json` at the repo root, generated and gitignored. Every signature verified against the bundle bytes; the new provenance gate confirmed the binary carries our key and not upstream's |
| Installed | 0.0.29 is installed and running on the user's machine |
| Source | pushed, `hardening` at `5d2525c` |
| dist README | two commits in the dist clone, **2 ahead of origin, unpushed** |

The dist clone lives outside this repo, under the agent scratchpad for session
`d3dd5246`, at `scratchpad/dist-repo`. If that directory is gone, re-clone
`ztidal/ZtidalCode-dist` and redo the README section — the queue behaviour it
documents is described in the app README's "While the agent is working".

## To publish

```bash
npm run updater:json -- --notes "…"          # regenerate; latest.json is gitignored
gh release create v0.0.29 --repo ztidal/ZtidalCode-dist \
  latest.json \
  src-tauri/target/release/bundle/nsis/*-setup.exe* \
  src-tauri/target/release/bundle/msi/*.msi*
```

…and push the dist README commits.

## What the notes should lead with

Not "the prompt queue works". The headline is bigger and worse:

> Every one of the fifteen `x.ai/*` methods this client sent went out under a
> name the agent does not answer to. Session usage and cost, recap, rewind,
> subagent listing and cancel, task listing and kill, interject, and every
> control on the prompt queue had never once reached the agent, in any release.

Also in this release: the timeline can be scrolled back a little without being
dragged to the bottom by the next chunk, and the app writes a log a teammate can
attach to a bug report (`~/.ztidalcode/logs/app-<date>-<pid>.log`).

## What the user was going to check first

1. **Usage and cost.** `session/usage` never arrived before, so that display had
   nothing behind it. If it starts showing real numbers, the whole outbound
   chain is live.
2. Scrolling back mid-reply, and not being pulled down again.
3. The queue row controls, and `Send now`.

## A hazard worth not repeating

Two agent sessions worked this repository at once tonight and collided on the
one resource that cannot be shared: the version number. The other session
bumped and built `0.0.28` at 01:19–01:28; work committed at 01:41 and 01:44 is
not in that installer, and nothing about the number says so. This release went
out as 0.0.29 to step around it.

Version numbers are the updater's whole identity here. If two sessions run
again, only one of them should bump and build.
