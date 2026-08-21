import { describe, expect, it } from "vitest";
import {
  composeTimelineTail,
  isPendingResolved,
  promptKey,
  type PendingPrompt,
} from "./usePendingPrompts";
import type { PromptQueueState, TimelineItem } from "../types";

const NOW = 1_700_000_000_000;

const pending = (text: string, over?: Partial<PendingPrompt>): PendingPrompt => ({
  id: "p1",
  sessionId: "s",
  text,
  ts: NOW,
  queued: false,
  ...over,
});

const userItem = (text: string, ts = NOW): TimelineItem => ({
  id: `u-${ts}`,
  handleId: "h",
  kind: "user",
  title: "",
  detail: text,
  ts,
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

describe("promptKey", () => {
  it("ignores the whitespace grok re-flows", () => {
    expect(promptKey("  fix   the\nparser ")).toBe("fix the parser");
  });
});

describe("isPendingResolved", () => {
  it("is unresolved while nothing accounts for it", () => {
    expect(isPendingResolved(pending("run tests"), [], null)).toBe(false);
  });

  it("resolves once grok echoes it into the stream", () => {
    expect(
      isPendingResolved(pending("run tests"), [userItem("run tests")], null),
    ).toBe(true);
  });

  it("resolves once it shows up in the queue", () => {
    expect(isPendingResolved(pending("run tests"), [], queue("run tests"))).toBe(
      true,
    );
  });

  it("resolves against the prompt grok is running right now", () => {
    // Interject promotes an entry out of the queue and into the turn; without
    // this the placeholder would come back the moment the queue emptied.
    expect(
      isPendingResolved(pending("run tests"), [], {
        sessionId: "s",
        entries: [],
        runningText: "run tests",
      }),
    ).toBe(true);
  });

  it("does not let an older identical message resolve a new one", () => {
    // Sending the same thing twice is ordinary — "continue", "go on", "again".
    const old = userItem("again", NOW - 60_000);
    expect(isPendingResolved(pending("again"), [old], null)).toBe(false);
  });
});

describe("composeTimelineTail", () => {
  const items = [userItem("first", NOW - 10_000)];

  it("leaves the timeline alone when nothing is outstanding", () => {
    expect(composeTimelineTail(items, [], null, "h", "s", NOW)).toBe(items);
  });

  it("shows a just-sent prompt before anything has come back", () => {
    const out = composeTimelineTail(
      items,
      [pending("run tests")],
      null,
      "h",
      "s",
      NOW,
    );
    expect(out).toHaveLength(2);
    expect(out[1]!.detail).toBe("run tests");
    expect(out[1]!.pending?.state).toBe("sending");
  });

  it("says queued for one submitted mid-turn", () => {
    const out = composeTimelineTail(
      items,
      [pending("run tests", { queued: true })],
      null,
      "h",
      "s",
      NOW,
    );
    expect(out[1]!.pending?.state).toBe("queued");
  });

  it("hands the row to grok once the queue reports it, without doubling it", () => {
    // The placeholder and the real entry are the same message; showing both is
    // the bug this whole layer exists to avoid.
    const out = composeTimelineTail(
      items,
      [pending("run tests", { queued: true })],
      queue("run tests"),
      "h",
      "s",
      NOW,
    );
    expect(out).toHaveLength(2);
    expect(out[1]!.pending?.entry?.id).toBe("q0");
  });

  it("does not show one task's pending prompt at the bottom of another", () => {
    // The pending store is flat across sessions; the queue it sits beside is
    // already scoped, and the two have to agree.
    const mine = composeTimelineTail(
      items,
      [pending("run tests", { sessionId: "other" })],
      null,
      "h",
      "s",
      NOW,
    );
    expect(mine).toBe(items);
  });

  it("keeps the queue in the order it will run", () => {
    const out = composeTimelineTail(items, [], queue("a", "b", "c"), "h", "s", NOW);
    expect(out.slice(1).map((i) => i.detail)).toEqual(["a", "b", "c"]);
  });

  it("drops a placeholder once the prompt has actually run", () => {
    const out = composeTimelineTail(
      items,
      [pending("run tests")],
      null,
      "h",
      "s",
      NOW,
    );
    expect(out).toHaveLength(2);
    const after = composeTimelineTail(
      [...items, userItem("run tests")],
      [pending("run tests")],
      null,
      "h",
      "s",
      NOW,
    );
    expect(after).toHaveLength(2);
    expect(after.every((i) => !i.pending)).toBe(true);
  });
});
