#!/usr/bin/env python3
"""Probe the live `grok agent stdio` wire instead of trusting a reading of it.

Kept because reading code answered wire questions wrongly for the whole life of
a feature, and one afternoon against the live agent (2026-08-22) answered them:

* grok registers its private extension methods underscored on the wire
  (`_x.ai/queue/changed`) while spelling the same names bare in its own
  handshake capability keys. This client matched the bare form, so every
  inbound queue notification was dropped for as long as the queue UI existed.

* All fifteen outbound `x.ai/*` methods were shipped bare. Requests came back
  `-32601 method not found`; notifications were discarded in silence. Usage,
  recap, rewind, subagent and task control, interject and the entire prompt
  queue had never once reached the agent.

The iron rule this tool encodes: protocol behaviour here gets verified against
a live agent, not inferred from reading code, grok's or ours.

This docstring doubles as --help output, so it stays ASCII: Git Bash pipes and
cp936 consoles both mangle anything wider.

  census   handshake, one trivial prompt, then watch for a minute; prints every
           method the agent sent, with counts, underscore forms flagged.
  queue    one long prompt, then N more sent mid-turn; prints each queue
           notification and whether grok queued or ran the turns concurrently.

Stdlib only. The agent runs in a throwaway temp directory so probing never
dirties a repo. Initialize params are byte-equivalent to
`InitializeParams::pinkcode()` (src-tauri/src/acp/protocol.rs); if that struct
changes, this file must follow.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import uuid

CLIENT_IDENTIFIER = "grok-desktop"

# The census keeps watching after the trivial turn ends: the notifications this
# tool exists for are the ones an agent sends when nothing asked it anything.
CENSUS_WINDOW_SECS = 60.0

# Must land while the long turn is still generating; 6s is measured headroom
# against the count-to-40 prompt below, and the run aborts if it was not.
MID_TURN_DELAY_SECS = 6.0

LONG_PROMPT = (
    "Think step by step and count slowly from 1 to 40, writing a short "
    "sentence about each number. Do not use any tools."
)


class ProbeFailure(Exception):
    pass


def repo_client_version() -> str:
    # protocol.rs stamps clientInfo.version from CARGO_PKG_VERSION; a version
    # pinned here instead would silently diverge at the next release bump, and
    # the probe would stop identifying as the client we ship.
    cargo = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "src-tauri", "Cargo.toml"
    )
    try:
        with open(cargo, encoding="utf-8") as fh:
            text = fh.read()
    except OSError as err:
        raise ProbeFailure(f"cannot read {cargo}: {err}") from err
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if not match:
        raise ProbeFailure(f"no [package] version in {cargo}")
    return match.group(1)


def initialize_params(version: str) -> dict:
    # Byte-equivalent to InitializeParams::pinkcode(). The private x.ai
    # extensions are plausibly gated on `meta.clientIdentifier`, so a probe
    # that drops or respells any of this is testing some client we do not
    # ship. `x.ai/fs_notify` really is the lone snake_case key in an otherwise
    # camelCase set — the serde rename in protocol.rs says so.
    return {
        "protocolVersion": 1,
        "clientInfo": {"name": "pinkcode", "version": version},
        "clientCapabilities": {
            "fs": {"readTextFile": True, "writeTextFile": True},
            "terminal": False,
            "meta": {
                "x.ai/incrementalBashOutput": True,
                "x.ai/bashOutputNoColor": True,
                "x.ai/hunkTracker": {"mode": "agent_only"},
                "x.ai/fs_notify": True,
                "x.ai/gitHeadChanged": True,
            },
        },
        "meta": {"clientIdentifier": CLIENT_IDENTIFIER},
    }


def find_grok(override: str | None) -> str:
    if override:
        return override
    on_path = shutil.which("grok")
    if on_path:
        return on_path
    # which() applies PATHEXT to an explicit path too, which is how the default
    # Windows install spells it: ~/.grok/bin/grok.exe.
    fallback = os.path.expanduser(os.path.join("~", ".grok", "bin", "grok"))
    return shutil.which(fallback) or fallback


def meta_of(result: dict) -> dict:
    # grok answers under `_meta`; the bare spelling is read too because the
    # same handshake already mixes both conventions (see InitializeResult).
    for key in ("_meta", "meta"):
        value = result.get(key)
        if isinstance(value, dict):
            return value
    return {}


def pick_auth_method(init: dict) -> str | None:
    # Mirrors select_non_interactive_auth_method() in src-tauri/src/acp/mod.rs:
    # only the two methods that need no browser round-trip can work here.
    offered = {
        m.get("id") for m in init.get("authMethods") or [] if isinstance(m, dict)
    }
    default = meta_of(init).get("defaultAuthMethodId")
    if default in ("cached_token", "xai.api_key") and default in offered:
        return default
    for method_id in ("cached_token", "xai.api_key"):
        if method_id in offered:
            return method_id
    return None


def summarize_response(msg: dict) -> str:
    result = msg.get("result")
    if isinstance(result, dict) and "stopReason" in result:
        return f"  stopReason={result['stopReason']}"
    if "error" in msg:
        error = msg["error"] if isinstance(msg["error"], dict) else {}
        return f"  error code={error.get('code')}"
    return ""


class Probe:
    def __init__(self, grok: str, timeout: float) -> None:
        self.t0 = time.time()
        self.deadline = self.t0 + timeout
        self.timed_out = False
        self.cwd = tempfile.mkdtemp(prefix="acp-probe-")
        # stdin is shared: the main thread sends prompts while the reader
        # thread answers reverse RPCs.
        self.write_lock = threading.Lock()
        self.responses: dict[object, tuple[float, dict]] = {}
        self.methods: dict[str, int] = {}
        self.queue_events: list[tuple[float, str, int | None]] = []
        self.queue_payloads: list[dict] = []
        self.junk_lines = 0
        try:
            self.child = subprocess.Popen(
                [grok, "agent", "stdio"],
                cwd=self.cwd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except OSError as err:
            shutil.rmtree(self.cwd, ignore_errors=True)
            raise ProbeFailure(f"cannot launch {grok!r}: {err}") from err
        # Every wait below is bounded by self.deadline, but a write into a full
        # pipe is not; killing the child is what breaks such a write loose.
        self.watchdog = threading.Timer(timeout, self._expire)
        self.watchdog.daemon = True
        self.watchdog.start()
        threading.Thread(target=self._read_loop, daemon=True).start()

    # ── lifecycle ───────────────────────────────────────────────────────────

    def _expire(self) -> None:
        self.timed_out = True
        self.note("--", "overall --timeout reached; killing agent")
        self.kill()

    def kill(self) -> None:
        try:
            self.child.kill()
        except OSError:
            pass

    def close(self) -> None:
        self.watchdog.cancel()
        self.kill()
        shutil.rmtree(self.cwd, ignore_errors=True)

    def elapsed(self) -> float:
        return time.time() - self.t0

    def note(self, arrow: str, label: str) -> None:
        print(f"{self.elapsed():7.2f}s  {arrow} {label}", flush=True)

    # ── outbound ────────────────────────────────────────────────────────────

    def send(self, obj: dict) -> None:
        try:
            with self.write_lock:
                self.child.stdin.write(json.dumps(obj) + "\n")
                self.child.stdin.flush()
        except OSError as err:
            raise ProbeFailure(f"agent stdin closed: {err}") from err

    def request(self, rid: int, method: str, params: dict) -> None:
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})

    def wait_response(self, rid: int, label: str) -> dict:
        while rid not in self.responses:
            if self.child.poll() is not None:
                raise ProbeFailure(f"agent exited before answering {label}")
            if time.time() >= self.deadline:
                raise ProbeFailure(f"no response to {label} within --timeout")
            time.sleep(0.1)
        _, msg = self.responses[rid]
        if "error" in msg:
            raise ProbeFailure(f"{label} failed: {json.dumps(msg['error'])}")
        result = msg.get("result")
        return result if isinstance(result, dict) else {}

    def observe(self, secs: float, done=None) -> None:
        # Half a second short of the watchdog so a clean run's report never
        # races the kill.
        end = min(time.time() + secs, self.deadline - 0.5)
        while time.time() < end:
            if done is not None and done():
                return
            if self.child.poll() is not None:
                self.note("--", "agent exited")
                return
            time.sleep(0.2)

    # ── inbound ─────────────────────────────────────────────────────────────

    def _read_loop(self) -> None:
        for raw in self.child.stdout:
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                self.junk_lines += 1
                continue
            if not isinstance(msg, dict):
                self.junk_lines += 1
                continue
            try:
                self._dispatch(msg)
            except ProbeFailure:
                # The pipe died mid-answer: the agent is going away, and the
                # main thread's poll() checks are what report it.
                return

    def _dispatch(self, msg: dict) -> None:
        method = msg.get("method")
        if method is None:
            if "id" in msg:
                self.responses[msg["id"]] = (self.elapsed(), msg)
                self.note("<-", f"response id={msg['id']}{summarize_response(msg)}")
            return
        self.methods[method] = self.methods.get(method, 0) + 1
        if "id" in msg:
            self._answer_reverse_rpc(msg, method)
            return
        # The census counts the underscored spelling verbatim; only queue
        # detection normalizes it, because the spelling is a finding here, not
        # an implementation detail.
        if method.lstrip("_").startswith("x.ai/queue/"):
            params = msg.get("params")
            params = params if isinstance(params, dict) else {}
            entries = params.get("entries")
            count = len(entries) if isinstance(entries, list) else None
            self.queue_events.append((self.elapsed(), method, count))
            self.queue_payloads.append(params)
            self.note("<-", f"{method}  entries={'?' if count is None else count}")

    def _answer_reverse_rpc(self, msg: dict, method: str) -> None:
        # An unanswered reverse RPC parks the agent forever — the turn never
        # ends and nothing times out on its side. Everything carrying an id
        # gets an answer, including methods this probe has never heard of.
        params = msg.get("params")
        params = params if isinstance(params, dict) else {}
        if method == "session/request_permission":
            options = [o for o in params.get("options") or [] if isinstance(o, dict)]
            allow = next(
                (o.get("optionId") for o in options if "allow" in str(o.get("optionId"))),
                options[0].get("optionId") if options else "allow",
            )
            self.note("<-", f"session/request_permission -> {allow}")
            result = {"outcome": {"outcome": "selected", "optionId": allow}}
        elif method == "fs/read_text_file":
            try:
                with open(params.get("path") or "", encoding="utf-8") as fh:
                    result = {"content": fh.read()}
            except OSError:
                result = {"content": ""}
        elif method == "fs/write_text_file":
            self._write_inside_scratch(params)
            result = {}
        else:
            self.send(
                {
                    "jsonrpc": "2.0",
                    "id": msg["id"],
                    "error": {
                        "code": -32601,
                        "message": f"probe does not implement {method}",
                    },
                }
            )
            return
        self.send({"jsonrpc": "2.0", "id": msg["id"], "result": result})

    def _write_inside_scratch(self, params: dict) -> None:
        # Acknowledged unconditionally, written only under the scratch cwd: a
        # probe must never be the thing that edits a real checkout.
        path = params.get("path") or ""
        root = os.path.normcase(os.path.realpath(self.cwd)) + os.sep
        if not os.path.normcase(os.path.realpath(path)).startswith(root):
            return
        try:
            os.makedirs(os.path.dirname(path) or self.cwd, exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(params.get("content") or "")
        except OSError:
            pass


# ── shared handshake ────────────────────────────────────────────────────────


def start_session(probe: Probe, version: str) -> str:
    probe.note("->", "initialize")
    probe.request(1, "initialize", initialize_params(version))
    init = probe.wait_response(1, "initialize")
    # When wire behaviour shifts under us, "which agent build did it" is the
    # first question every time (see InitializeResultMeta).
    agent = meta_of(init).get("agentVersion") or "unreported"
    probe.note("--", f"agent version {agent}; probing as pinkcode {version}")
    auth = pick_auth_method(init)
    if auth:
        probe.note("->", f"authenticate ({auth})")
        probe.request(2, "authenticate", {"methodId": auth})
        probe.wait_response(2, "authenticate")
    probe.note("->", "session/new")
    probe.request(3, "session/new", {"cwd": probe.cwd, "mcpServers": []})
    session = probe.wait_response(3, "session/new")
    session_id = session.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        raise ProbeFailure("session/new returned no sessionId")
    probe.note("--", f"session {session_id}")
    return session_id


def send_prompt(probe: Probe, rid: int, session_id: str, text: str) -> None:
    # Byte-equivalent to SessionPromptParams::text() modulo the uuid: a prompt
    # without `_meta.clientIdentifier` is not the prompt the shipped client
    # sends, and the queue methods key on that identifier.
    probe.request(
        rid,
        "session/prompt",
        {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": text}],
            "_meta": {
                "promptId": str(uuid.uuid4()),
                "clientIdentifier": CLIENT_IDENTIFIER,
            },
        },
    )


# ── census ──────────────────────────────────────────────────────────────────


def run_census(probe: Probe, version: str) -> int:
    session_id = start_session(probe, version)
    probe.note("->", "session/prompt (trivial)")
    send_prompt(probe, 10, session_id, "Say OK and nothing else. Do not use any tools.")
    probe.note("--", f"watching for {CENSUS_WINDOW_SECS:.0f}s")
    probe.observe(CENSUS_WINDOW_SECS)

    print()
    print("=" * 62)
    seen = sorted(probe.methods.items(), key=lambda kv: (-kv[1], kv[0]))
    total = sum(count for _, count in seen)
    print(f"methods the agent sent ({probe.elapsed():.0f}s observed, {total} messages):")
    for method, count in seen:
        flag = "   [underscore form]" if method.startswith("_") else ""
        print(f"  {count:5}  {method}{flag}")
    if not seen:
        print("  (none)")
    underscored = sum(1 for method, _ in seen if method.startswith("_"))
    print(f"underscore forms: {underscored} of {len(seen)} distinct methods")
    if probe.junk_lines:
        print(f"non-JSON stdout lines ignored: {probe.junk_lines}")
    print("=" * 62)
    return 0 if probe.child.poll() is None and not probe.timed_out else 1


# ── queue ───────────────────────────────────────────────────────────────────


def run_queue(probe: Probe, version: str, mid_turn: int) -> int:
    session_id = start_session(probe, version)
    long_id = 10
    probe.note("->", "session/prompt #1 (long)")
    send_prompt(probe, long_id, session_id, LONG_PROMPT)
    probe.observe(MID_TURN_DELAY_SECS, done=lambda: long_id in probe.responses)
    if long_id in probe.responses:
        raise ProbeFailure(
            "the long turn finished before any mid-turn prompt was sent; nothing "
            "was measured -- rerun, or lengthen LONG_PROMPT if models got faster"
        )
    mid_ids = list(range(long_id + 1, long_id + 1 + mid_turn))
    for i, rid in enumerate(mid_ids):
        probe.note("->", f"session/prompt #{i + 2} (mid-turn)")
        send_prompt(
            probe, rid, session_id,
            f"Say MIDTURN-{i + 2} and nothing else. Do not use any tools.",
        )
        time.sleep(0.4)
    wanted = [long_id, *mid_ids]
    probe.observe(1e9, done=lambda: all(rid in probe.responses for rid in wanted))

    print()
    print("=" * 62)
    spellings = sorted({method for _, method, _ in probe.queue_events})
    print(
        f"queue notifications: {len(probe.queue_events)}"
        + (f"   spellings seen: {', '.join(spellings)}" if spellings else "")
    )
    for at, method, count in probe.queue_events:
        print(f"  {at:7.2f}s  {method}  entries={'?' if count is None else count}")
    for i, payload in enumerate(probe.queue_payloads[:3]):
        pretty = json.dumps(payload, indent=2, sort_keys=True)
        if len(pretty) > 4000:
            pretty = pretty[:4000] + "\n... truncated"
        print(f"payload #{i + 1}:")
        print(textwrap.indent(pretty, "  "))

    labels = {rid: f"#{i + 2}" for i, rid in enumerate(mid_ids)}
    long_done = probe.responses.get(long_id)
    missing = [labels[rid] for rid in mid_ids if rid not in probe.responses]
    print()
    if long_done is None:
        print("VERDICT: the long turn never completed in the window; no ordering verdict.")
    elif missing:
        print(f"VERDICT: inconclusive -- mid-turn prompt(s) {', '.join(missing)} never completed.")
    else:
        overlapped = [
            labels[rid] for rid in mid_ids if probe.responses[rid][0] < long_done[0]
        ]
        if overlapped:
            print(
                f"VERDICT: CONCURRENT -- prompt(s) {', '.join(overlapped)} completed "
                "while the long turn was still running."
            )
        else:
            print("VERDICT: QUEUED -- every mid-turn prompt completed only after the long turn.")
    if probe.queue_events:
        print(
            f"  first queue notification at {probe.queue_events[0][0]:.2f}s; "
            f"names seen: {', '.join(spellings)}"
        )
    else:
        print("  NO queue notification arrived: the UI's 'Queued' badge would never")
        print("  gain its controls, and a queued placeholder would resolve only when")
        print("  the agent echoed the message back.")
    print("=" * 62)
    return 0 if probe.child.poll() is None and not probe.timed_out else 1


# ── entry point ─────────────────────────────────────────────────────────────


def positive_int(text: str) -> int:
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("must be >= 1")
    return value


def main() -> int:
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument(
        "--grok",
        metavar="PATH",
        default=None,
        help="grok binary (default: grok on PATH, then ~/.grok/bin/grok)",
    )
    shared.add_argument(
        "--timeout",
        type=float,
        default=180.0,
        metavar="SECS",
        help="overall wall-clock budget; the agent is killed at expiry (default 180)",
    )

    parser = argparse.ArgumentParser(
        prog="acp-probe",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser(
        "census",
        parents=[shared],
        help="one trivial prompt, then list every method the agent sent",
    )
    queue = sub.add_parser(
        "queue",
        parents=[shared],
        help="one long prompt plus N mid-turn prompts; report queue behaviour",
    )
    queue.add_argument(
        "-n",
        "--mid-turn",
        type=positive_int,
        default=2,
        metavar="N",
        # Two, not one: a lone held prompt can ride as an in-flight request
        # with the queue only materializing for the overflow behind it.
        help="prompts sent while the long turn runs (default 2; the second is "
        "what forces a queue to exist)",
    )
    args = parser.parse_args()

    try:
        version = repo_client_version()
        probe = Probe(find_grok(args.grok), args.timeout)
    except ProbeFailure as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    try:
        if args.command == "census":
            return run_census(probe, version)
        return run_queue(probe, version, args.mid_turn)
    except ProbeFailure as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    finally:
        probe.close()


if __name__ == "__main__":
    sys.exit(main())
