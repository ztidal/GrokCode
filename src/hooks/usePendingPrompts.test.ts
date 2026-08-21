import { describe, expect, it } from "vitest";
import {
  ACK_TIMEOUT_MS,
  composeTimelineTail,
  isConnectionLoss,
  isStillPending,
  type PendingPrompt,
} from "./usePendingPrompts";
import type { PromptQueueState, TimelineItem } from "../types";

const NOW = 1_700_000_000_000;

const submitted = (over?: Partial<PendingPrompt>): PendingPrompt => ({
  id: "p1",
  sessionId: "s",
  text: "run tests",
  ts: NOW,
  queued: false,
  ...over,
});

const userItem = (ts: number, over?: Partial<TimelineItem>): TimelineItem => ({
  id: `u-${ts}`,
  handleId: "h",
  kind: "user",
  title: "",
  detail: "run tests",
  ts,
  ...over,
});

const queue = (...texts: string[]): PromptQueueState => ({
  sessionId: "s",
  entries: texts.map((text, i) => ({
    id: `q${i}`,
    version: 1,
    kind: "prompt",
    text,
    position: i,
  })),
});

describe("isStillPending", () => {
  it("stands in for the message while nothing has come back", () => {
    expect(isStillPending(submitted(), [], 0, 0, NOW)).toBe(true);
  });

  it("stops as soon as grok says anything about the queue", () => {
    // Deliberately not "says something about *this* message" — matching
    // placeholders to entries by text is what the earlier version did, and
    // every rule for it could settle the wrong one or the same one twice.
    expect(isStillPending(submitted(), [], NOW + 400, 0, NOW + 500)).toBe(false);
  });

  it("stops once an echoed message appears after it", () => {
    expect(
      isStillPending(submitted(), [userItem(NOW + 300)], 0, 0, NOW + 400),
    ).toBe(false);
  });

  it("stops when the connection it was sent on is lost", () => {
    // Nothing will ever echo it: the RPC died on a transport that is now being
    // reconnected, and the completion handler bails at the reconnecting guard
    // without emitting. Waiting out the timeout would only delay the same
    // answer.
    expect(isStillPending(submitted(), [], 0, NOW + 300, NOW + 400)).toBe(false);
  });

  it("is not settled by what was already there when it was sent", () => {
    // A queue update, a message, or a dropped connection from before the
    // submission says nothing about it.
    expect(isStillPending(submitted(), [userItem(NOW - 5_000)], 0, 0, NOW)).toBe(
      true,
    );
    expect(isStillPending(submitted(), [], NOW - 5_000, 0, NOW)).toBe(true);
    expect(isStillPending(submitted(), [], 0, NOW - 5_000, NOW)).toBe(true);
  });

  it("does not mistake its own row for an echo", () => {
    const ownRow = userItem(NOW + 300, {
      id: "pending-p1",
      pending: { state: "sending" },
    });
    expect(isStillPending(submitted(), [ownRow], 0, 0, NOW + 400)).toBe(true);
  });

  it("gives up when nothing ever acknowledges it", () => {
    // A send that dies on the wire still resolves its promise, and a failure
    // the agent survives — a refused prompt, a worker that never runs — leaves
    // its status alone too. Silence is the last signal there is.
    expect(isStillPending(submitted(), [], 0, 0, NOW + ACK_TIMEOUT_MS + 1)).toBe(
      false,
    );
    expect(isStillPending(submitted(), [], 0, 0, NOW + ACK_TIMEOUT_MS - 1)).toBe(
      true,
    );
  });

  it("is nothing at all when nothing was submitted", () => {
    expect(isStillPending(null, [], 0, 0, NOW)).toBe(false);
  });
});

describe("isConnectionLoss", () => {
  it("sees the transport go: a live agent flipped back to starting", () => {
    // `handle_transport_closed` sets exactly this, and nothing else moves an
    // agent from live to `starting`.
    expect(isConnectionLoss("running", "starting")).toBe(true);
    expect(isConnectionLoss("ready", "starting")).toBe(true);
    expect(isConnectionLoss("awaitingPermission", "starting")).toBe(true);
  });

  it("leaves the first connect alone, which only ever climbs", () => {
    // A prompt submitted here is remembered before `ensureAttached` even
    // starts, and the seconds it takes are the whole reason the placeholder
    // exists.
    expect(isConnectionLoss("starting", "ready")).toBe(false);
    expect(isConnectionLoss("starting", "running")).toBe(false);
    expect(isConnectionLoss("starting", "starting")).toBe(false);
  });

  it("leaves a prompt queued behind a long turn alone", () => {
    // The agent never stops being attached while it works through its queue.
    expect(isConnectionLoss("running", "running")).toBe(false);
    expect(isConnectionLoss("ready", "running")).toBe(false);
    expect(isConnectionLoss("running", "awaitingPermission")).toBe(false);
    expect(isConnectionLoss("awaitingPermission", "running")).toBe(false);
  });

  it("counts an agent stopped or failed out from under the send", () => {
    // Not a transport failure, but the message is just as lost: the connection
    // that was carrying it is gone and no row is coming.
    expect(isConnectionLoss("running", "stopping")).toBe(true);
    expect(isConnectionLoss("running", "stopped")).toBe(true);
    expect(isConnectionLoss("running", "error")).toBe(true);
  });

  it("says nothing about an agent that was already down", () => {
    expect(isConnectionLoss("stopped", "starting")).toBe(false);
    expect(isConnectionLoss("error", "starting")).toBe(false);
    expect(isConnectionLoss("stopped", "stopped")).toBe(false);
  });
});

describe("composeTimelineTail", () => {
  const items = [userItem(NOW - 10_000, { id: "old", detail: "first" })];

  it("leaves the timeline alone when nothing is outstanding", () => {
    expect(composeTimelineTail(items, null, null, "h", "s")).toBe(items);
  });

  it("shows a just-sent message before anything has come back", () => {
    const out = composeTimelineTail(items, submitted(), null, "h", "s");
    expect(out).toHaveLength(2);
    expect(out[1]!.detail).toBe("run tests");
    expect(out[1]!.pending?.state).toBe("sending");
  });

  it("says queued for one submitted mid-turn", () => {
    const out = composeTimelineTail(
      items,
      submitted({ queued: true }),
      null,
      "h",
      "s",
    );
    expect(out[1]!.pending?.state).toBe("queued");
  });

  it("carries no clock, because nothing has happened yet", () => {
    // The memo above this recomputes on every streamed chunk, so a sampled
    // time would visibly crawl while the agent worked.
    const out = composeTimelineTail(items, submitted(), queue("later"), "h", "s");
    expect(out.slice(1).every((row) => !row.ts)).toBe(true);
  });

  it("puts grok's queue in the order it will run, ahead of the placeholder", () => {
    const out = composeTimelineTail(
      items,
      submitted({ text: "newest" }),
      queue("a", "b"),
      "h",
      "s",
    );
    expect(out.slice(1).map((i) => i.detail)).toEqual(["a", "b", "newest"]);
    expect(out[1]!.pending?.entry?.id).toBe("q0");
    expect(out[3]!.pending?.entry).toBeUndefined();
  });
});
