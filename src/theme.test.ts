import { describe, expect, it } from "vitest";
import {
  parseStoredChoice,
  resolveTheme,
  themeAttribute,
  THEME_CHOICES,
} from "./theme";

describe("parseStoredChoice", () => {
  it("round-trips every choice it can write", () => {
    for (const choice of THEME_CHOICES) {
      expect(parseStoredChoice(choice)).toBe(choice);
    }
  });

  it("falls back to following the OS rather than guessing", () => {
    expect(parseStoredChoice(null)).toBe("system");
    expect(parseStoredChoice("")).toBe("system");
    expect(parseStoredChoice("Dark")).toBe("system");
    expect(parseStoredChoice("moon")).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("keeps an explicit choice whatever the OS says", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
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
