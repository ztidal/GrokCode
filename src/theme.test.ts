import { describe, expect, it } from "vitest";
import {
  parseStoredChoice,
  resolveTheme,
  themeAttribute,
  THEME_CHOICES,
  DEFAULT_CHOICE,
} from "./theme";

describe("parseStoredChoice", () => {
  it("round-trips every choice it can write", () => {
    for (const choice of THEME_CHOICES) {
      expect(parseStoredChoice(choice)).toBe(choice);
    }
  });

  it("falls back to following the OS rather than guessing", () => {
    expect(parseStoredChoice(null)).toBe(DEFAULT_CHOICE);
    expect(parseStoredChoice("")).toBe(DEFAULT_CHOICE);
    expect(parseStoredChoice("Dark")).toBe(DEFAULT_CHOICE);
    expect(parseStoredChoice("moon")).toBe(DEFAULT_CHOICE);
  });
});

describe("resolveTheme", () => {
  it("keeps an explicit choice whatever the OS says", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("paints dark when nothing has been chosen", () => {
    expect(DEFAULT_CHOICE).toBe("dark");
    expect(resolveTheme(parseStoredChoice(null), false)).toBe("dark");
  });

  it("follows the OS only for 'system'", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("themeAttribute", () => {
  it("stamps an explicit choice", () => {
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("dark")).toBe("dark");
  });

  it("stamps nothing for 'system', leaving the media query in charge", () => {
    expect(themeAttribute("system")).toBeNull();
  });
});
