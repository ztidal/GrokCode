# How grok names things on the wire

Measured against `agentVersion 1.0.5` on 2026-08-21, by driving `grok agent stdio`
directly with a minimal client that sent our exact `InitializeParams::pinkcode()`
payload. Re-deriving this costs an hour; it is written down so nobody has to.

## The rule

**Every `x.ai/*` extension is registered under a leading underscore.**
`_x.ai/queue/remove`, `_x.ai/session/usage`, and so on.

The confusion is grok's own, and it is in a single handshake reply:

```
agentCapabilities._meta:  "x.ai/fs_notify": true      ← capability key, bare
wire notification:        "_x.ai/fs_notify"           ← method name, underscored
```

Nothing in the protocol reconciles the two, so a call site that copies the
spelling it can *see* reaches a method that does not exist. That is how fifteen
outbound calls shipped dead (fixed in `db5475d`) and how every inbound queue
notification was dropped for the whole life of the prompt queue (fixed earlier
in the same branch).

## What was measured

Sent as requests, so the router had to answer. `-32601` means the name is not
registered. Params used ids that do not exist, so nothing destructive could run.

| method | `x.ai/…` | `_x.ai/…` |
| --- | --- | --- |
| `interject` | -32601 | exists |
| `session/usage` | -32601 | exists |
| `recap` | -32601 | exists |
| `rewind/points` | -32601 | exists |
| `rewind/execute` | -32601 | exists (-32602 on a bogus point) |
| `subagent/cancel` · `subagent/list_running` | -32601 | exists |
| `task/kill` · `task/list` | -32601 | exists |
| `queue/remove` · `reorder` · `clear` · `edit` | -32601 | -32601 **as a request** |
| `queue/interject` | -32601 | -32601 |
| `yolo_mode_changed` | -32601 | -32601 |

The queue methods are **notification-only**: grok routes notifications
separately, so they answer nothing as requests. Verified by effect instead —
queue a prompt, send `_x.ai/queue/remove` as a notification, watch the queue
depth drop. The bare spelling did nothing; the underscored one removed it.

### `x.ai/queue/interject` does not exist at all

Neither spelling, as a request or as a notification. `Send now` was therefore
dead from the day it was written. It is now two calls that do exist — inject the
text into the running turn with `interject`, then `queue/remove` the entry so it
cannot run twice — in that order, so a failure leaves the message queued rather
than losing it.

### `extMethods` is not advertised

`RongleCat/grok-app` probes six JSON pointers for a published method list
(`/_meta/extMethods`, `/agentCapabilities/extMethods`, …). **None of the six
exist in this agent's handshake.** Do not copy that code; it would guard nothing.
What the handshake does carry is recorded in `handshake_contract_tests` in
`src-tauri/src/acp/protocol.rs`.

## Where the rule lives now

`AcpClient::ext_wire` in `src-tauri/src/acp/mod.rs` — one place, with the bare
name kept at each call site because that is the spelling anybody can look up.
Requests fall back to the bare form on `-32601`, so a future rename costs
nothing. Two tests guard it: one pins the rule, and one reads the file and fails
if a new call site reaches for `call`/`call_raw`/`notify_typed` with an `x.ai/`
name — which is how the original fifteen got there.

Inbound is normalised once in `AgentManager::canonical_method`.

## Still unknown

- Whether `yolo_mode_changed` exists under any spelling. It is a notification we
  send and never hear about; it may simply have been removed from the agent.
- Whether the underscore is permanent. Both spellings appear in one handshake
  today, which is the argument for the `-32601` fallback rather than a constant.
