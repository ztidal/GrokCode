# No permission policy layer; every mode stays open to everyone

There is no allowlist, ceiling, or managed policy file restricting which Permission Mode a person may
choose. This is deliberate, and it is the decision most likely to look like an oversight in a fork whose
whole purpose is hardening — so: it was designed, then dropped on purpose.

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

## Consequences

Capability is unrestricted, so the safety properties this fork does provide are about *how* a mode is
reached rather than *which* modes exist:

- A repository cannot choose the mode its own tasks start in — upstream's `<cwd>/.pinkcode/config.json`
  layer is removed (`config.rs`).
- `BypassPermissions` never becomes the Sticky Seed, so one `/always-approve` cannot silently become the
  starting mode for all later work (`task_prefs::may_persist_as_seed`).
- The composer's mode chip names the real mode even when the session-mode cycle cannot express it, so
  `AcceptEdits` no longer displays as "Ask before tools".

If the team ever does want to restrict modes, add the build-time allowlist then — it is a small patch at
three chokepoints (`effective_permission_mode`, `set_permission_mode`, `set_last_spawn_mode`), not a
subsystem.
