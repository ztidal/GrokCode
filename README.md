<!-- Relative path so GitHub does not rewrite via camo (often broken in CN). -->
<p align="center">
  <img src="docs/logo.png" alt="ZtidalCode" width="128" />
</p>

<h1 align="center">ZtidalCode — Grok Desktop GUI</h1>

<p align="center">
  <strong>Our internal build of PinkCode: same workspace, hardened for team use.</strong>
</p>

<p align="center">
  <a href="#what-differs-from-upstream">What differs</a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#installation">Installation</a>
  ·
  <a href="#using-it">Using it</a>
  ·
  <a href="#development">Development</a>
  ·
  <a href="#architecture">Architecture</a>
</p>

Run multiple [Grok Build](https://x.ai/cli) tasks side by side, follow every task in a readable live
timeline, and see where your credits and tokens go. ZtidalCode turns Grok Build's CLI workflow into a
visual desktop workspace while keeping `grok` itself in charge: it connects over
[ACP](https://spec.acp.dev) (Agent Client Protocol) via stdio and does not run a separate agent loop.

This is a fork of [3xian/PinkCode](https://github.com/3xian/PinkCode), kept deliberately thin. Upstream
owns the agent-facing core; we own only what makes the app safe and distributable inside the team. See
[ADR-0001](docs/adr/0001-track-upstream-as-a-thin-hardening-layer.md) for why.

**Tauri 2 · React 19 · TypeScript · Rust**

## What differs from upstream

| Change | Why |
|---|---|
| **A repository cannot set its own permission mode.** Upstream merged `<cwd>/.pinkcode/config.json` as the highest-priority config layer; the layer is removed. | Cloning a repo that shipped one seeded its tasks — including at always-approve — with no prompt. |
| **Full permissions is the default, and a task inherits nothing from the task before it.** Upstream seeded each new task with the previous one's mode; that carry-over is removed, so the mode on screen is always either a constant you can read in `config.rs` or a choice made for that task. | The team works in repositories it already trusts — and a mode chosen once for one job should not quietly follow you into the next. See [ADR-0002](docs/adr/0002-no-permission-policy-layer.md). |
| **Shell calls are never auto-approved on plan.md path text.** | A command merely *containing* the session plan path was auto-approved in every mode, `Don't ask` included. |
| **`auth.json` is replaced atomically and stays owner-only.** | The highest-consequence write in the app was the one skipping the project's own atomic-write helper. |
| **The mode chip names the real mode.** `Accept edits` and `Don't ask` used to display as "Ask before tools". | The indicator was wrong exactly where it mattered most. |
| **Own identity, own update feed.** Product name, bundle identifier, version line and updater key live in `branding/ztidalcode.json`. | So our build is a separate application, and cannot be replaced by an upstream release. |

Deliberately **not** changed: there is no permission allowlist or managed policy — every mode is open to
everyone ([ADR-0002](docs/adr/0002-no-permission-policy-layer.md)) — and the identity we present to Grok
Build on the wire is still upstream's ([ADR-0003](docs/adr/0003-rename-the-package-not-the-protocol.md)).
Both look like oversights and are not.

Host state lives in `~/.ztidalcode` (`%USERPROFILE%\.ztidalcode` on Windows), separate from upstream's
`~/.pinkcode`, so both apps can be installed side by side.

## Screenshot

<p align="center">
  <img src="docs/product.jpg" alt="Parallel tasks, live Timeline, usage, workspace" width="100%" />
</p>

<p align="center"><sub>Upstream's screenshot — the interface is unchanged apart from the name and mark.</sub></p>

## Features

The app is centered on two things that are difficult to manage from a terminal alone: keeping several
agent tasks moving at once, and understanding their activity and cost at a glance.

| Focus | What it makes easier |
|------|----------|
| **Parallel tasks** | Work across multiple Grok Build sessions from one task board. Create, switch, prompt, and stop tasks independently; each task connects to `grok` over ACP when you first send a message. Existing sessions are loaded from `~/.grok` (`%USERPROFILE%\.grok` on Windows). |
| **Clear task activity** | Read user messages, agent responses, thoughts, tool calls, shell output, plans, and events in one live timeline. Subagent and background-task cards update live; attach/reconnect refills running work via ACP list APIs. Reconnect restores history from `updates.jsonl`. |
| **Usage visuals** | See weekly Grok credit usage with a per-product breakdown, a 7-day token-usage series from session logs, and live turn tokens/cost while a turn is running. |

The rest of the interface keeps those parallel workflows practical:

| Area | Behavior |
|------|----------|
| **File changes** | Review agent file hunks from `hunk_records.jsonl`. |
| **Workspace & Git** | Browse the project tree, preview text and images, and manage Git: branch status (ahead/behind), staged/unstaged lists, inline file diffs, **per-hunk stage/unstage**, and commit. |
| **Modes & plans** | Shift+Tab-style cycle aligned with Grok Build: **Normal → Plan → Auto → Always-approve**. Plan is orthogonal to permission mode; free-text send becomes `/plan …`. When the agent exits plan mode, review and choose Approve, Request changes, or Quit. |
| **Model** | Switch the session model mid-task over ACP `session/set_model`. |
| **Permissions** | Default (ask), Accept edits, Auto (classified by Grok), Always approve, Don't ask. Per-task prefs in `~/.ztidalcode/task_prefs.json`. Handles tool permission, file writes, plan approval, and ask-user questions; the task list surfaces **Needs input** when a reverse-request is open. |
| **Updates** | Checks our own release feed once at startup — click the title-bar mark to check again — and installs an update in one click. Updates are minisign-verified against a key compiled into the build. |

## Installation

### 1. Install Grok Build

ZtidalCode requires the [Grok Build CLI](https://x.ai/cli) and a SuperGrok, X Premium+, or SuperGrok Heavy
subscription. The app never handles your credentials — it reuses the session `grok login` creates.

**Windows (PowerShell):**

```powershell
irm https://x.ai/cli/install.ps1 | iex
```

**macOS / Linux / WSL:**

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Grok stores its data under `~/.grok` (`%USERPROFILE%\.grok` on Windows). Set `GROK_HOME` for another
location.

### 2. Install ZtidalCode

Download from **[ZtidalCode-dist releases](https://github.com/ztidal/ZtidalCode-dist/releases)** —
installers are published there because the in-app updater fetches them anonymously.

- **Windows x64 — take `ZtidalCode_<version>_x64-setup.exe`.** It installs per-user, needs no
  administrator, and in-app updates then install silently and relaunch the app.
- Windows x64, administrator-driven rollout: the MSI. It installs per-machine, so **every in-app update
  prompts for administrator** — see
  [which installer to hand people](branding/README.md#which-installer-to-hand-people).
- macOS / Linux: build from source

> **Our installers are not Authenticode-signed**, so SmartScreen will warn about an unknown publisher.
> Check your download against `SHA256SUMS.txt` on the release before installing. In-app updates carry a
> minisign signature and are verified regardless.

## Using it

The day-to-day guide — project grouping, pins, the composer, permission modes, slash commands and the
keyboard table — lives with the downloads, where a teammate lands:
**[ZtidalCode-dist README](https://github.com/ztidal/ZtidalCode-dist#using-it)**.

It is kept there rather than duplicated here so there is one copy to keep true. Two things from it are
worth repeating for anyone changing this code:

- **A new task approves tool calls without asking.** `PINKCODE_DEFAULT_PERMISSION_MODE=ask`, or
  `{"defaultPermissionMode":"default"}` in `~/.ztidalcode/config.json`, restores the prompt without a
  rebuild. See [ADR-0002](docs/adr/0002-no-permission-policy-layer.md).
- **`Enter` sends and `Ctrl+Enter` inserts a newline**, which is the reverse of most chat apps.

### Logs

**Ask for this file first when someone says it stopped working.** An installed build is a windowed
process with no console, so anything it writes to stderr is lost; it also appends to
`~/.ztidalcode/logs/app-<date>-<pid>.log` (`%USERPROFILE%\.ztidalcode\logs\` on Windows). One file per
process — each window is a separate one — and panics land there with a backtrace. Files are removed
seven days after their last write, at startup. `PINKCODE_LOG_LEVEL=debug`, or
`{"logLevel":"debug"}` in `~/.ztidalcode/config.json`, raises the level for the next launch.

## Development

### Prerequisites

| | macOS | Windows 11 | Linux |
|---|---|---|---|
| Node | 24+ | 24+ | 24+ |
| Rust | stable | stable (`x86_64-pc-windows-msvc`) | stable |
| Platform | Xcode CLT | MSVC Build Tools + [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) | webkit2gtk ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)) |
| Grok Build | installed | installed | installed |

Windows toolchain (once):

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows-setup.ps1
```

### Build and run

```bash
npm ci
npm run tauri:dev          # development
npm run check              # frontend + Rust (fmt/clippy/test) — same as CI
```

Release bundles **must** go through the identity overlay, or they ship under upstream's name and updater:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat /path/to/ztidalcode.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri -- build --config branding/ztidalcode.json
```

See [`branding/README.md`](branding/README.md) for the signing key, the version scheme, and the Windows
Installer limits that constrain it.

### Keeping up with upstream

```bash
git fetch upstream && git merge upstream/main
```

Conflicts should be confined to version bumps. If a merge wants to change `config.rs`,
`plan_file_policy.rs`, `task_prefs.rs`, `auth.rs` or `watcher.rs`, read the ADRs first — those files carry
the hardening, and upstream has historically not touched them.

**Env (optional)**

| Variable | Meaning |
|----------|---------|
| `GROK_BIN` | Path to `grok` / `grok.exe` |
| `GROK_HOME` | Grok data root (default `~/.grok`) |

## Architecture

```
UI (React 19 + TypeScript)
  |-- invoke() --> Tauri commands
  |                 sessions, agent lifecycle, permissions,
  |                 billing, workspace FS, git status / hunk apply
  |-- listen() <-- Tauri events
                    agent-* | sessions-changed
        |
        |-- AgentManager — N x `grok agent stdio` (ACP) + host permission gate
        |-- Session index — FS watcher on ~/.grok/sessions (cards, hunks, stats)
        |-- Billing — HTTP calls to Grok billing API (OIDC auth via ~/.grok/auth.json)
```

ZtidalCode communicates with Grok Build over ACP (JSON-RPC over stdio): prompts, `session/set_mode`,
`session/set_model`, usage/recap extensions, and lifecycle notifications. The host-side permission gate
intercepts reverse RPCs (`session/request_permission`, `fs/write_text_file`, `x.ai/exit_plan_mode`,
`x.ai/ask_user_question`) and applies the configured policy before allowing or denying agent actions.

Read [`CONTEXT.md`](CONTEXT.md) for the vocabulary this codebase uses — several terms (Seed,
Escalation) carry distinctions the hardening depends on.

## Acknowledgements

Everything that makes this a workspace rather than a terminal — the task rail, the timeline, the
Files and Git panels, the ACP client that drives `grok` — is **[PinkCode](https://github.com/3xian/PinkCode)**,
by [3xian](https://github.com/3xian). This fork adds a team's hardening on top and keeps its
relationship to upstream deliberately thin (see *What differs from upstream*), so that PinkCode's
improvements keep flowing in with a plain `git merge`.

If this fork is useful, the first thanks belongs upstream.

## License

Licensed under the [Apache License 2.0](LICENSE).

Copyright (c) 2026 3xian — original work, [3xian/PinkCode](https://github.com/3xian/PinkCode).
Modifications copyright (c) 2026 ztidal. Changes from the original are summarised in
[What differs from upstream](#what-differs-from-upstream) and recorded per-commit on the `hardening`
branch.
