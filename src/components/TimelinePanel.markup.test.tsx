import { describe, expect, it } from "vitest";
import type { TimelineItem } from "../types";
import { render, tags, withClass } from "../test/markup";
import { TimelinePanel } from "./TimelinePanel";

const TS = Date.UTC(2026, 0, 2, 3, 4, 5);

function item(id: string, kind: string): TimelineItem {
  return { id, handleId: "h1", kind, title: kind, detail: kind, ts: TS };
}

/**
 * The whole panel, which turns out to need no scaffolding worth the name: five
 * props, none of them a mock. Effects do not run under `renderToStaticMarkup`,
 * so what comes back is first paint — which is exactly when
 * `syncFilterIndicator` goes looking for these elements.
 */
function renderPanel(items: TimelineItem[]): string {
  return render(
    <TimelinePanel
      items={items}
      managed={null}
      hasMore={false}
      loadingOlder={false}
      onLoadOlder={async () => {}}
    />,
  );
}

describe("timeline filter bar markup", () => {
  it("emits both hooks the sliding indicator reads, on every chip", () => {
    const html = renderPanel([
      item("a", "user"),
      item("b", "agent"),
      item("c", "tool"),
    ]);

    // `syncFilterIndicator` finds the active chip with
    // `[data-filter-kind="<kind>"]`, then reads `--chip-bg-active` off its
    // computed style — a variable that only `.timeline-filter-chip.filter-user`
    // and its siblings in `detail.css` set. The attribute and the class name
    // the same kind twice, in two languages; if they ever disagree the
    // indicator takes the wrong colour, or, missing its chip entirely, never
    // leaves the origin. Both failures are silent.
    const chips = withClass(html, "timeline-filter-chip");
    expect(chips.map((chip) => chip.attrs["data-filter-kind"])).toEqual([
      "all",
      "user",
      "agent",
      "tool",
    ]);
    for (const chip of chips) {
      expect(chip.classes).toContain(`filter-${chip.attrs["data-filter-kind"]}`);
    }

    // The `ResizeObserver` that keeps the indicator on the chip through a
    // reflow enumerates them by class alone, so the two queries have to reach
    // the same set of elements.
    const byAttribute = tags(html).filter(
      (tag) => tag.attrs["data-filter-kind"] !== undefined,
    );
    expect(byAttribute).toHaveLength(chips.length);
  });

  it("gives the filter that is active on first paint a chip to measure", () => {
    // The panel opens on `all`, and `syncFilterIndicator` returns without a
    // word when it cannot find the active chip: no `is-indicator-ready`, so the
    // indicator stays invisible and nothing says why. `all` is the one chip
    // that is not derived from the stream, so it is the one that can go missing
    // without any item kind changing.
    const html = renderPanel([item("a", "user")]);

    const all = withClass(html, "timeline-filter-chip").find(
      (chip) => chip.attrs["data-filter-kind"] === "all",
    );
    expect(all, "no `all` chip for the default filter").toBeDefined();
    // `.timeline-filter-chip.active` is what paints the selected chip.
    expect(all!.classes).toContain("active");
  });

  it("leaves All without `is-filtered`, which is what the user-chat CSS keys off", () => {
    const html = renderPanel([item("a", "user"), item("b", "agent")]);
    const stream = withClass(html, "stream-timeline")[0]!;
    expect(stream.classes).not.toContain("is-filtered");
    expect(withClass(html, "kind-user")).toHaveLength(1);
  });
});
