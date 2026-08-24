import { describe, expect, it } from "vitest";
import { render, tags, withClass } from "../test/markup";
import { TimelineRowChrome, timelineStackClass } from "./TimelineRow";

const TS = Date.UTC(2026, 0, 2, 3, 4, 5);

describe("TimelineRowChrome markup", () => {
  it("names the row `tl-item` and tags it with its kind", () => {
    // Two things read this pair off one element. `detail.css` opts virtualized
    // rows out of `content-visibility` through `.timeline.is-virtualized
    // .tl-item` — the rule that once said `.tl-row` and therefore matched
    // nothing — and paints per-kind chrome through `.tl-item.kind-shell` and
    // its siblings. Either half going missing costs nothing at build time.
    const html = render(
      <TimelineRowChrome kind="shell" ts={TS} stackClass="">
        body
      </TimelineRowChrome>,
    );

    const row = tags(html)[0]!;
    expect(row.name).toBe("div");
    expect(row.classes).toContain("tl-item");
    expect(row.classes).toContain("kind-shell");
    // `.tl-item.kind-shell .tl-body` paints the terminal block inside the row.
    expect(withClass(html, "tl-body")).toHaveLength(1);
  });

  it("puts the stacking classes on the same element as `tl-item`", () => {
    // `.tl-item.tl-stack-continue` and `.tl-item:not(.tl-stack-has-next)` set
    // the padding that makes a run of same-kind rows read as one group. They
    // are compound selectors: split across two elements they match nothing,
    // and the result is a rhythm that is merely slightly wrong, which is the
    // kind of wrong nobody files.
    const html = render(
      <TimelineRowChrome
        kind="agent"
        ts={TS}
        stackClass={timelineStackClass("agent", "agent", "agent")}
      >
        body
      </TimelineRowChrome>,
    );

    const row = withClass(html, "tl-item")[0]!;
    expect(row.classes).toContain("tl-stack-continue");
    expect(row.classes).toContain("tl-stack-has-next");
  });

  it("stamps a locatable row with the id All-view scroll looks up", () => {
    const html = render(
      <TimelineRowChrome
        kind="user"
        ts={TS}
        stackClass=""
        itemId="event-user-1"
        className="is-locatable"
        onActivate={() => {}}
      >
        body
      </TimelineRowChrome>,
    );

    const row = withClass(html, "tl-item")[0]!;
    expect(row.attrs["data-timeline-id"]).toBe("event-user-1");
    expect(row.attrs.role).toBe("button");
    expect(row.attrs.tabindex).toBe("0");
    expect(row.attrs.title).toBe("Show this message in All");
    expect(row.classes).toContain("is-locatable");
  });
});
