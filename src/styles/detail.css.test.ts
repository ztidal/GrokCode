import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A selector that matches nothing fails silently — nothing errors, the rule
 * simply never applies. The virtualization opt-out below was written against
 * `.tl-row` while rows render as `.tl-item`, so every row kept
 * `content-visibility: auto`, the virtualiser measured the intrinsic
 * placeholder rather than the row, and the timeline could not stay at its own
 * bottom. Nothing else in the suite can see that.
 */
const css = readFileSync(new URL("./detail.css", import.meta.url), "utf8");
const row = readFileSync(
  new URL("../components/TimelineRow.tsx", import.meta.url),
  "utf8",
);

describe("timeline row styling", () => {
  it("opts virtualized rows out of content-visibility by their real class", () => {
    const optOut = css.match(
      /\.timeline\.is-virtualized\s+\.([a-z-]+)\s*\{[^}]*content-visibility:\s*visible/,
    );
    expect(optOut, "no content-visibility opt-out found").not.toBeNull();
    const styled = optOut![1];
    expect(
      row.includes(`${styled} kind-`) || row.includes(`"${styled}"`),
      `detail.css opts out .${styled}, which TimelineRow.tsx never renders`,
    ).toBe(true);
  });

  it("applies content-visibility to that same class, not another one", () => {
    // The rule and its opt-out drifting apart is the failure being guarded.
    const applied = css.match(
      /\.([a-z-]+)\s*\{[^}]*content-visibility:\s*auto/,
    );
    expect(applied).not.toBeNull();
    expect(applied![1]).toBe("tl-item");
  });
});
