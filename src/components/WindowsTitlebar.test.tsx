import { describe, expect, it, vi } from "vitest";
import { render, withClass } from "../test/markup";
import { WindowsTitlebar } from "./WindowsTitlebar";

vi.mock("../utils/platform", () => ({
  isWindowsDesktop: () => true,
}));

vi.mock("../hooks/useAppVersion", () => ({
  useAppVersion: () => "0.0.34",
}));

describe("WindowsTitlebar", () => {
  it("uses the same compact Settings gear contract as macOS", () => {
    const html = render(
      <WindowsTitlebar
        onCheckUpdate={() => {}}
        checkStatus="idle"
        onWindowError={() => {}}
      />,
    );

    const trigger = withClass(html, "windows-settings-trigger")[0];
    expect(trigger?.attrs["aria-label"]).toBe("Settings");
    expect(trigger?.attrs.title).toBe("Settings");
    expect(trigger?.attrs["aria-haspopup"]).toBe("dialog");
    expect(trigger?.classes).toContain("desktop-settings-trigger");
    expect(withClass(html, "settings-gear-icon")).toHaveLength(1);
  });
});
