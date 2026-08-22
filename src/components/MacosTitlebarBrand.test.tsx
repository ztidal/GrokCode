import { afterEach, describe, expect, it, vi } from "vitest";
import { render, tags, withClass } from "../test/markup";
import {
  isMacosSettingsShortcut,
  MacosSettingsPanel,
  MacosTitlebarBrand,
} from "./MacosTitlebarBrand";

vi.mock("../utils/platform", () => ({
  isMacosDesktop: () => true,
}));

vi.mock("../hooks/useAppVersion", () => ({
  useAppVersion: () => "0.0.34",
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MacosTitlebarBrand", () => {
  it("places the approved product subtitle between name and version", () => {
    const html = render(
      <MacosTitlebarBrand
        onCheckUpdate={() => {}}
        checkStatus="idle"
        onWindowError={() => {}}
      />,
    );

    const copyLines = tags(html)
      .filter((tag) =>
        tag.classes.some((name) => name.startsWith("macos-titlebar-")),
      )
      .flatMap((tag) => tag.classes)
      .filter((name) =>
        [
          "macos-titlebar-name",
          "macos-titlebar-subtitle",
          "macos-titlebar-version",
        ].includes(name),
      );
    expect(copyLines).toEqual([
      "macos-titlebar-name",
      "macos-titlebar-subtitle",
      "macos-titlebar-version",
    ]);
    expect(html).toContain("ZtidalCode for Grok Build");
  });

  it("puts update checking and Settings on separate named buttons", () => {
    const html = render(
      <MacosTitlebarBrand
        onCheckUpdate={() => {}}
        checkStatus="idle"
        onWindowError={() => {}}
      />,
    );

    const buttons = tags(html).filter((tag) => tag.name === "button");
    expect(buttons.map((button) => button.attrs["aria-label"])).toEqual([
      "Check for updates",
      "Settings",
    ]);
    expect(withClass(html, "macos-settings-trigger")[0]?.attrs["aria-expanded"])
      .toBe("false");
    expect(withClass(html, "macos-settings-trigger")[0]?.attrs["aria-haspopup"])
      .toBe("dialog");
    expect(
      withClass(html, "macos-settings-trigger")[0]?.classes,
    ).toContain("desktop-settings-trigger");
    expect(withClass(html, "settings-gear-icon")).toHaveLength(1);
  });

  it("renders the shared desktop actions before every persisted theme choice", () => {
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
    });

    const html = render(<MacosSettingsPanel version="0.0.34" />);

    const firstMenuItem = withClass(html, "desktop-settings-item")[0];
    expect(firstMenuItem?.attrs.autofocus).toBe("");

    const menuSections = [
      "New Window",
      "Check for Updates",
      "Theme",
      "Current version",
    ].map((label) => html.indexOf(label));
    expect(menuSections.every((index) => index >= 0)).toBe(true);
    expect(menuSections).toEqual([...menuSections].sort((a, b) => a - b));

    const radios = tags(html).filter(
      (tag) => tag.name === "button" && tag.attrs.role === "radio",
    );
    expect(radios).toHaveLength(5);
    expect(html).toContain("Light");
    expect(html).toContain("Dark");
    expect(html).toContain("Pure Dark");
    expect(html).toContain("Warm Gold");
    expect(html).toContain("System");
    expect(html).toContain("v0.0.34");
  });

  it("recognises Command-comma without stealing other shortcuts", () => {
    expect(
      isMacosSettingsShortcut({
        key: ",",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      isMacosSettingsShortcut({
        key: ",",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
    expect(
      isMacosSettingsShortcut({
        key: ".",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });
});
