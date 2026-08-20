# No permission policy layer; every mode stays open, and full permissions is the default

There is no allowlist, ceiling, or managed policy file restricting which Permission Mode a person may
choose. This is deliberate, and it is the decision most likely to look like an oversight in a fork whose
whole purpose is hardening — so: it was designed, then dropped on purpose.

Since the same reasoning decides where a task *starts*, this ADR also records that: the built-in default
is now `BypassPermissions` — full permissions — where it used to be `Default` (Ask before every tool).

## Considered options

A build-time allowlist of permitted modes was designed and rejected once the team confirmed everyone should
have every mode. An allowlist containing all five modes enforces nothing, and a no-op policy engine is
exactly the kind of speculative machinery ADR-0001 says not to carry. A **runtime** policy file was rejected
earlier for a different reason: our developers are local administrators on their own machines, so a
`%ProgramData%` file with an ACL is advisory at best — it would have bought the appearance of a control
rather than a control.

Note also that the five modes are not a ranked scale. `Auto` gates by risk and `AcceptEdits` gates by
category, so neither is "higher" than the other; any "maximum permission mode" setting would have had to
invent an ordering the code does not have.

The default moved for the same reason the runtime policy file was dropped. Ask-before-every-tool was
answered "yes" on repositories the team had already chosen to point the agent at, often enough that the
dialog stopped carrying information — and a prompt everybody clicks through is the appearance of a control,
not a control. Better to state the posture in one readable line than to keep collecting reflex consent.

## What full permissions means here

`config::DEFAULT_PERMISSION_MODE` is `PermissionMode::BypassPermissions`. A task nobody has configured
spawns `grok agent --always-approve stdio`: the agent stops raising permission requests, and the few that
still arrive are answered `Allow` by the host gate. Edits land and commands run without a prompt.

It is a Seed, not a ceiling. Config is the weakest layer in the stack, so `PINKCODE_DEFAULT_PERMISSION_MODE`,
`~/.ztidalcode/config.json`, the Sticky Seed and the task's own Mode selector each override it. A machine or
a person who wants the old posture back sets the env var or the global file to `ask`; a single task steps
down in the New Task modal, which opens with **Always approve** visibly pre-selected rather than applying it
silently.

## Consequences

Capability is unrestricted and the starting point is permissive, so the safety properties this fork provides
are entirely about *how* a mode is reached rather than *which* modes exist or how open the default is:

- A repository cannot choose the mode its own tasks start in — upstream's `<cwd>/.pinkcode/config.json`
  layer is removed (`config.rs`), and neither `resolve` nor `effective_permission_mode` takes a working
  directory. Unchanged by the new default, and now cuts both ways: a cloned repository can no more talk a
  task *down* than it could talk one up.
- `BypassPermissions` still never becomes the Sticky Seed (`task_prefs::may_persist_as_seed`). What that
  buys has changed, though: it is no longer holding back an escalation, it is keeping the seed empty so the
  answer keeps coming from `DEFAULT_PERMISSION_MODE` — one line, in one file, that a person can read and
  change. Lower it there and every machine follows on the next launch; had one earlier `/always-approve`
  been allowed to write itself into the seed, that same edit would have changed nothing.
- The host still never fabricates a human answer. `decide_gate` returns `Ask` for `PlanApproval` and
  `UserQuestion` in every mode, `BypassPermissions` included — approving a plan and answering the agent's
  question stay decisions a person makes.
- The composer's mode chip names the real mode even when the session-mode cycle cannot express it, so
  `AcceptEdits` no longer displays as "Ask before tools". This one matters more than it used to: the chip is
  now the only thing on screen saying that a task will not stop to ask.

Two things in the old list no longer bite, and pretending otherwise would be dishonest:

- "One `/always-approve` cannot silently become the starting mode for all later work" was the point of the
  seed guard. The guard is intact and tested, but later work now starts at full permissions regardless. The
  property that survives is about where the decision is written down, not about how permissive it is.
- The approval prompt is no longer a backstop for a task pointed at the wrong working directory, or for a
  tool call the agent was talked into by content it read. Choosing the folder in the New Task modal, and
  choosing a narrower Mode there, are what is left of that — the prompt used to do the catching and does
  not any more. A team that wants it back does not need a code change: `PINKCODE_DEFAULT_PERMISSION_MODE=ask`
  or `{"defaultPermissionMode":"default"}` in `~/.ztidalcode/config.json` restores the old behaviour, per
  machine, without touching this fork.

If the team ever does want to restrict modes, add the build-time allowlist then — it is a small patch at
three chokepoints (`effective_permission_mode`, `set_permission_mode`, `set_last_spawn_mode`), not a
subsystem.
