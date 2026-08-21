import { describe, expect, it } from "vitest";
import {
  composeTimelineTail,
  promptKey,
  unresolvedPending,
  type PendingPrompt,
} from "./usePendingPrompts";
import type { PromptQueueState, TimelineItem } from "../types";

const NOW = 1_700_000_000_000;

const pending = (text: string, over?: Partial<PendingPrompt>): PendingPrompt => ({
  id: `p-${text}`,
  sessionId: "s",
  text,
  ts: NOW,
  queued: false,
  ...over,
});

const userItem = (text: string, ts = NOW): TimelineItem => ({
  id: `u-${text}-${ts}`,
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

const live = (
  p: PendingPrompt[],
  items: TimelineItem[] = [],
  q: PromptQueueState | null = null,
  now = NOW,
) => unresolvedPending(p, items, q, "s", now).map((x) => x.text);

describe("promptKey", () => {
  it("ignores the whitespace grok re-flows", () => {
    expect(promptKey("  fix   the\nparser ")).toBe("fix the parser");
  });
});

describe("unresolvedPending", () => {
  it("stands in for a message nothing accounts for yet", () => {
    expect(live([pending("run tests")])).toEqual(["run tests"]);
  });

  it("stops once grok echoes it into the stream", () => {
    expect(live([pending("run tests")], [userItem("run tests")])).toEqual([]);
  });

  it("stops once it appears in the queue", () => {
    expect(live([pending("run tests")], [], queue("run tests"))).toEqual([]);
  });

  it("stops for the prompt grok is running right now", () => {
    // Interject promotes an entry out of the queue and into the turn; without
    // this the placeholder would return the moment the queue emptied.
    expect(
      live([pending("run tests")], [], {
        sessionId: "s",
        entries: [],
        runningText: "run tests",
      }),
    ).toEqual([]);
  });

  it("does not let an older identical message settle a new one", () => {
    // Sending the same thing twice is ordinary — "continue", "go on", "again".
    expect(live([pending("again")], [userItem("again", NOW - 60_000)])).toEqual([
      "again",
    ]);
  });

  it("settles one placeholder per occurrence, not all of them", () => {
    // Two "continue" submitted, one of them queued so far: the other is still
    // unaccounted for and has to keep its row.
    const two = [
      pending("continue", { id: "a", ts: NOW - 1000 }),
      pending("continue", { id: "b" }),
    ];
    expect(live(two, [], queue("continue"))).toEqual(["continue"]);
    expect(live(two, [], queue("continue", "continue"))).toEqual([]);
  });

  it("spends each echo once", () => {
    const two = [
      pending("again", { id: "a", ts: NOW - 1000 }),
      pending("again", { id: "b" }),
    ];
    expect(live(two, [userItem("again")])).toEqual(["again"]);
  });

  it("belongs to the task it was typed in", () => {
    // The store is flat across tasks; the queue beside it is already scoped.
    expect(live([pending("run tests", { sessionId: "other" })])).toEqual([]);
  });

  it("gives up on a message that was never acknowledged", () => {
    // A send that dies on the wire still resolves its promise, so silence is
    // the only signal it was lost. A row waiting forever is worse than none.
    expect(live([pending("run tests")], [], null, NOW + 61_000)).toEqual([]);
    expect(live([pending("run tests")], [], null, NOW + 30_000)).toEqual([
      "run tests",
    ]);
  });
});

describe("composeTimelineTail", () => {
  const items = [userItem("first", NOW - 10_000)];

  it("leaves the timeline alone when nothing is outstanding", () => {
    expect(composeTimelineTail(items, [], null, "h", "s")).toBe(items);
  });

  it("shows a just-sent prompt before anything has come back", () => {
    const out = composeTimelineTail(items, [pending("run tests")], null, "h", "s");
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
    );
    expect(out[1]!.pending?.state).toBe("queued");
  });

  it("carries no clock, because nothing has happened yet", () => {
    // The memo above this recomputes on every streamed chunk, so a sampled
    // time would visibly crawl while the agent worked.
    const out = composeTimelineTail(
      items,
      [pending("run tests")],
      queue("later"),
      "h",
      "s",
    );
    expect(out.slice(1).every((row) => !row.ts)).toBe(true);
  });

  it("hands the row to grok once the queue reports it, without doubling it", () => {
    const settled = unresolvedPending(
      [pending("run tests", { queued: true })],
      items,
      queue("run tests"),
      "s",
      NOW,
    );
    const out = composeTimelineTail(items, settled, queue("run tests"), "h", "s");
    expect(out).toHaveLength(2);
    expect(out[1]!.pending?.entry?.id).toBe("q0");
  });

  it("keeps the queue in the order it will run", () => {
    const out = composeTimelineTail(items, [], queue("a", "b", "c"), "h", "s");
    expect(out.slice(1).map((i) => i.detail)).toEqual(["a", "b", "c"]);
  });
});
