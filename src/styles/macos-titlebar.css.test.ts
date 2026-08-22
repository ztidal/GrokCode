import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("./macos-titlebar.css", import.meta.url),
  "utf8",
);

describe("macOS Settings popover layout", () => {
  it("opens into the workspace when the responsive sidebar is narrower than the panel", () => {
    const narrowViewport = css.match(
      /@media\s*\(max-width:\s*1200px\)\s*\{([\s\S]*?)\n\}/,
    );

    expect(narrowViewport, "missing the 1200px sidebar layout guard").not.toBeNull();
    expect(narrowViewport![1]).toMatch(
      /\.macos-settings-panel\s*\{[^}]*right:\s*auto;[^}]*left:\s*0;/s,
    );
  });
});
