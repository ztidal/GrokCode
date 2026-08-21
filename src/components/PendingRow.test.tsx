import { describe, expect, it } from "vitest";
import type { PromptQueueController } from "../hooks/usePromptQueueController";
import type { PromptQueueEntry, TimelineItem } from "../types";
import { render, tags, withClass } from "../test/markup";
import { PendingRow, type QueueRowUi } from "./PendingRow";

const TS = Date.UTC(2026, 0, 2, 3, 4, 5);

const entry: PromptQueueEntry = {
  id: "q1",
  version: 1,
  kind: "text",
  text: "run the migration",
  position: 0,
};

function pending(state: "sending" | "queued", owned: boolean): TimelineItem {
  return {
    id: "p1",
    handleId: "h1",
    kind: "user",
    title: "",
    detail: entry.text,
    ts: TS,
    pending: { state, entry: owned ? entry : undefined },
  };
}

const noop = async () => {};
const controller: PromptQueueController = {
  queue: { sessionId: "s1", entries: [entry] },
  remove: noop,
  edit: noop,
  reorder: noop,
  clear: noop,
  interject: noop,
};
const ui: QueueRowUi = {
  draft: null,
  setDraft: () => {},
  busyKey: null,
  setBusyKey: () => {},
};

describe("PendingRow markup", () => {
  it("gives a queued row the controls, once grok owns the entry", () => {
    const html = render(
      <PendingRow
        item={pending("queued", true)}
        stackClass=""
        controller={controller}
        ui={ui}
      />,
    );

    // `.tl-pending-actions` is what `agent.css` lays the row of buttons out
    // with, and these buttons are the only way to reorder, edit or cancel a
    // prompt that has been submitted — the composer has already let go of it.
    expect(withClass(html, "tl-pending-actions")).toHaveLength(1);
    const buttons = tags(html).filter((tag) => tag.name === "button");
    expect(buttons).toHaveLength(5);
    // Move up, move down, edit, send now, remove. The two arrows carry no text,
    // so `aria-label` is the only name they have.
    expect(buttons.map((b) => b.attrs["aria-label"]).filter(Boolean)).toEqual([
      "Move queued prompt up",
      "Move queued prompt down",
    ]);
    // `.queue-icon-btn` / `.queue-text-btn` carry the whole appearance of these
    // buttons; without one they render as bare browser chrome.
    expect(withClass(html, "queue-icon-btn")).toHaveLength(2);
    expect(withClass(html, "queue-text-btn")).toHaveLength(3);
  });

  it("gives a sending row none of them, and marks the badge as waiting", () => {
    const html = render(
      <PendingRow
        item={pending("sending", false)}
        stackClass=""
        controller={controller}
        ui={ui}
      />,
    );

    // Nothing to act on yet: reorder sends a whole-queue ordering and this
    // prompt is not in one, so a control here would send an ordering that
    // silently drops it.
    expect(withClass(html, "tl-pending-actions")).toHaveLength(0);
    expect(tags(html).filter((tag) => tag.name === "button")).toHaveLength(0);

    // `.tl-pending-badge.is-waiting` is a compound selector: the muted styling
    // that says "not promised yet" needs both classes on the one span.
    const badge = withClass(html, "tl-pending-badge")[0]!;
    expect(badge.classes).toContain("is-waiting");
  });
});
