# ZtidalCode

A desktop GUI that drives xAI's Grok Build coding agent over ACP, hardened for team use and published
under its own name. It is a public fork of upstream PinkCode, not a separate product.

## Language

### The fork

**ZtidalCode**:
The name this fork ships under. Package identity only — the ACP client identity we present to Grok Build
remains upstream's, because changing it would change wire behaviour for no benefit.
_Avoid_: Our PinkCode, the hardened PinkCode, the ztidal build

**Hardening Layer**:
What this fork is: a deliberately thin set of changes on top of upstream that make the app safe for team
use and distributable under its own name, while upstream keeps ownership of the agent-facing core.
_Avoid_: Our version, our product, the custom build

**Upstream Core**:
The parts of the app we do not intend to own — the ACP client, the `x.ai/*` private extensions, session
and task handling. Changes here are upstream's responsibility to maintain; ours only to consume.
_Avoid_: Vendor code, third-party code

### Permissions

**Permission Mode**:
How much the agent may do without asking a human, for one task. One of five: `DontAsk`, `Default`,
`Auto`, `AcceptEdits`, `BypassPermissions`. These are named states, not a ranked scale — `Auto` gates by
risk while `AcceptEdits` gates by category, so neither is "higher" than the other.
_Avoid_: Permission level, trust level, approval setting

**Effective Permission Mode**:
The Permission Mode a task actually spawns with: its own stored choice, else the configured Seed. Nothing
sits between the two. It is the single value that reaches the agent's command line.
_Avoid_: Current mode, active permission

**Seed**:
A configured Permission Mode that supplies a task's starting value when nothing else has chosen one. A
Seed constrains nothing — the task can move away from it freely. There is exactly one, and it is written
down in `config.rs`: a task never inherits the mode of the task before it.
_Avoid_: Default (ambiguous — `Default` is also the name of one Permission Mode); Sticky Seed (upstream's
last-spawn carry-over, removed)

**Escalation**:
Moving a task to a Permission Mode that asks a human less often. Our concern is never that a person can
escalate — everyone on the team may, and full permissions is the Seed — but that a mode chosen for one
task could follow the user into the next one without being chosen again.
_Avoid_: Bypass, YOLO, going permissive

**Plan-File Auto-Allow**:
A rule that approves writes to a session's `plan.md` before any Permission Mode is consulted, so Plan mode
does not stall. It currently matches on truncated, agent-supplied text, which makes it the one path that
grants approval in every Permission Mode.
_Avoid_: Plan exception, plan whitelist
