# ZtidalCode

A desktop GUI that drives xAI's Grok Build coding agent over ACP, packaged for internal team use.
It is a fork of upstream PinkCode, not a separate product.

## Language

### The fork

**ZtidalCode**:
The name this fork ships under. Package identity only — the ACP client identity we present to Grok Build
remains upstream's, because changing it would change wire behaviour for no benefit.
_Avoid_: Our PinkCode, the internal build

**Hardening Layer**:
What this fork is: a deliberately thin set of changes on top of upstream that make the app safe and
distributable internally, while upstream keeps ownership of the agent-facing core.
_Avoid_: Our version, the internal product, the custom build

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
The Permission Mode a task actually spawns with, after resolving the per-session choice, then the Sticky
Seed, then the configured default. It is the single value that reaches the agent's command line.
_Avoid_: Current mode, active permission

**Seed**:
A configured Permission Mode that only supplies a starting value when nothing else has chosen one. A Seed
constrains nothing — a user or a workspace can move away from it freely.
_Avoid_: Default (ambiguous — `Default` is also the name of one Permission Mode)

**Sticky Seed**:
The last Permission Mode any task spawned with, persisted and reused as the Seed for every later task.
Distinct from a Seed the user or an administrator chose: nobody selects a Sticky Seed, it is a residue of
one earlier decision.
_Avoid_: Last mode, remembered mode

**Escalation**:
Moving a task to a Permission Mode that asks a human less often. Our concern is never that a person can
escalate — everyone on the team may — but that an Escalation can outlive the task it was made for, or
happen without a person choosing it.
_Avoid_: Bypass, YOLO, going permissive

**Plan-File Auto-Allow**:
A rule that approves writes to a session's `plan.md` before any Permission Mode is consulted, so Plan mode
does not stall. It currently matches on truncated, agent-supplied text, which makes it the one path that
grants approval in every Permission Mode.
_Avoid_: Plan exception, plan whitelist
