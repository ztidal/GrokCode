import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("./macos-titlebar.css", import.meta.url),
  "utf8",
);

function mediaBody(query: string): string {
  const mediaStart = css.indexOf(`@media ${query}`);
  expect(mediaStart, `missing ${query} media query`).toBeGreaterThanOrEqual(0);

  const bodyStart = css.indexOf("{", mediaStart);
  let depth = 0;
  for (let index = bodyStart; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(bodyStart + 1, index);
  }

  throw new Error(`unterminated ${query} media query`);
}

describe("macOS Settings popover layout", () => {
  it("opens into the workspace when the responsive sidebar is narrower than the panel", () => {
    const narrowViewport = mediaBody("(max-width: 1200px)");

    expect(narrowViewport).toMatch(
      /\.macos-settings-panel\s*\{[^}]*right:\s*auto;[^}]*left:\s*0;/s,
    );
  });

  it("raises the whole narrow macOS rail above adjacent workspace panes", () => {
    const narrowViewport = mediaBody("(max-width: 1200px)");

    expect(narrowViewport).toMatch(
      /html\.platform-macos-desktop\s+\.left-rail\s*\{[^}]*z-index:\s*[1-9]\d*;/s,
    );
  });
});
