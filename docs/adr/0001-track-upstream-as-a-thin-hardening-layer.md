# Track upstream as a thin hardening layer

This repository is a fork of `3xian/PinkCode` kept deliberately close to it: we add only what is needed to
distribute the app safely inside the team, and leave the agent-facing core to upstream. The alternative —
taking ownership and diverging — was rejected because the app's core features ride on 36 undocumented
`x.ai/*` ACP extensions (193 call sites) that break whenever Grok Build changes, and keeping up with those
is the one job we cannot staff. Upstream ships roughly a release every 1.5 days, so the thing we depend on
them for is exactly the thing they are actively doing.

## Consequences

Hardening patches must survive repeated upstream merges, which is affordable because the files we changed
are ones upstream does not touch: across its last 30 commits, `permission_policy.rs`, `plan_file_policy.rs`,
`task_prefs.rs`, `config.rs` and `auth.rs` were modified **zero** times. Upstream's churn is concentrated in
`package.json`, `Cargo.toml` and `tauri.conf.json` — version bumps — so conflicts are expected to be
mechanical.

The corollary is a standing rule: prefer a change that upstream will never collide with over a smaller
change inside a file upstream owns. Build-time overlays (see ADR-0003) beat edits to shared config.
