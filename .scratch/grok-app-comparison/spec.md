# What we took from grok-app, and what we left

`RongleCat/grok-app` (MIT) solves the same problem — a Tauri 2 + React desktop
front end driving `grok agent stdio` over ACP — at roughly ten times our size.
Compared against it on 2026-08-21. No code was copied; these are techniques.

Read this before comparing against it again, so the "why not" does not have to
be re-derived.

## Taken

All six are in the tree. See `6120587` and `6d4c0c3`.

| | Where it lives now |
| --- | --- |
| A log file beside stderr, and a synchronous panic hook | `src-tauri/src/config.rs` |
| A warn when a notification reaches the dispatcher unclaimed | `src-tauri/src/agent_manager.rs` |
| Keep the handshake — agent version, and the reply logged once | `src-tauri/src/acp/{mod,protocol}.rs` |
| Refuse to publish a build that is not ours | `scripts/make-updater-json.mjs` |
| `renderToString` markup tests | `src/test/markup.ts` + three `*.test.tsx` |
| Two-flag pin/escape for stick-to-bottom | `src/components/TimelinePanel.tsx` |

Two of these are shaped by *our* constraints rather than theirs:

- **The log file is named per process.** `multi_instance.rs` runs several windows
  as separate processes over one `~/.ztidalcode`. A shared handle would break
  rotation on Windows — the same silent failure the log exists to end. Pruned by
  mtime, not by the date in the name, because a window left open for a fortnight
  still writes to yesterday's file.
- **The provenance check reads the compiled binary**, not the installer. The
  bundles are compressed, so the embedded key is not findable in them; the
  unpacked `PinkCode.exe` is the same file that goes into both.

## Deliberately not taken

- **Their handshake capability probe.** `initialize_advertises_rewind` guesses at
  six JSON pointers for `extMethods`. Measured: none of the six exist in this
  agent. It would be dead code guarding nothing. See
  `.scratch/grok-wire-names/spec.md`.
- **Their `-32601` detection.** `rpc_looks_like_method_not_found` string-matches
  the error text. Our `AcpError::Rpc { code }` carries the numeric code, so we
  match exactly.
- **Their updater preflight.** `verify-updater-setup.sh` checks that env vars and
  secrets are *present*; it never opens an artifact. Ours verifies each signature
  against the bundle bytes and now also checks the trust anchor compiled into the
  binary. Ours is the stronger primitive.
- **Their transcript store.** An external store with split content/meta
  subscriptions. A real improvement at their scale; a large rewrite of
  `useAgentEvents` at ours, with no bug of ours currently attributed to it.

## Where they have nothing to teach us

**They have no prompt queue.** `grep -rn "x.ai/queue" src-tauri/src/` in their
repo returns nothing. The feature that cost this branch the most work has no
prior art there.

## Three defects the review of that work turned up

Fixed in `6120587`, recorded because each is a class, not an incident:

- `acp::gateway` truncated an unparseable line with a **byte** slice. UTF-8
  cannot be split at an arbitrary byte, so a long line whose boundary fell inside
  a character panicked the reader thread — and Chinese output makes that
  near-certain. The test is written in the language that would have hit it.
- The handshake log redacted `authMethods` and nothing else. The reply has a slot
  for `mcpServers`, whose definitions carry the `env` map an API token lives in,
  and that line goes to a file people attach to bug reports. Redaction is by
  field name now, everywhere it appears.
- A comment claimed `RUST_LOG` could only reach the agent's stderr by naming its
  target. It cannot; a bare `RUST_LOG=debug` is global and does put it on disk.
