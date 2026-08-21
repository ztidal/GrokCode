import { describe, expect, it } from "vitest";
import {
  applyOverflowTitle,
  cardTitleTooltip,
  type MeasurableElement,
} from "./overflowTitle";

function element(scrollWidth: number, clientWidth: number) {
  const attrs = new Map<string, string>();
  const el: MeasurableElement = {
    scrollWidth,
    clientWidth,
    setAttribute: (name, value) => void attrs.set(name, value),
    removeAttribute: (name) => void attrs.delete(name),
  };
  return { el, title: () => attrs.get("title") ?? null };
}

describe("applyOverflowTitle", () => {
  it("gives clipped text a tooltip", () => {
    const { el, title } = element(300, 180);
    expect(applyOverflowTitle(el, "A very long session name")).toBe(true);
    expect(title()).toBe("A very long session name");
  });

  it("leaves text that fits without one", () => {
    const { el, title } = element(120, 180);
    expect(applyOverflowTitle(el, "Short")).toBe(false);
    expect(title()).toBeNull();
  });

  it("ignores a sub-pixel difference, which is not text anyone is missing", () => {
    const { el, title } = element(181, 180);
    expect(applyOverflowTitle(el, "Short")).toBe(false);
    expect(title()).toBeNull();
  });

  it("clears a tooltip the element picked up while it was narrower", () => {
    // The rail is resizable, so the same card is measured again every hover.
    const { el, title } = element(300, 180);
    applyOverflowTitle(el, "A very long session name");
    expect(title()).not.toBeNull();

    const widened = { ...el, scrollWidth: 300, clientWidth: 400 };
    applyOverflowTitle(widened, "A very long session name");
    expect(title()).toBeNull();
  });

  it("keeps a forced tooltip on text that fits", () => {
    const { el, title } = element(120, 180);
    expect(applyOverflowTitle(el, "Renamed\nAgent's title: x", true)).toBe(true);
    expect(title()).toBe("Renamed\nAgent's title: x");
  });

  it("sets nothing for empty text, forced or not", () => {
    const { el, title } = element(300, 180);
    expect(applyOverflowTitle(el, "", true)).toBe(false);
    expect(title()).toBeNull();
  });
});

describe("cardTitleTooltip", () => {
  it("is just the name when nothing is hiding behind it", () => {
    expect(cardTitleTooltip("Updater work", null)).toBe("Updater work");
  });

  it("carries the agent's own title under a rename", () => {
    expect(cardTitleTooltip("Updater work", "Debug the release feed")).toBe(
      "Updater work\nRenamed — agent's title: Debug the release feed",
    );
  });

  it("does not repeat a title that happens to match", () => {
    expect(cardTitleTooltip("Same", "Same")).toBe("Same");
  });
});
