import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseStoredChoice,
  resolveTheme,
  themeAttribute,
  THEME_CHOICES,
  DEFAULT_CHOICE,
} from "./theme";

const THEME_CSS = ["./styles/theme-dark.css", "./styles/theme-puredark.css"]
  .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n");

/**
 * Choices that must carry their own palette. 'system' stamps no attribute, and
 * 'light' is tokens.css's bare `:root` — every other choice re-points --rp-*.
 */
const STAMPED = THEME_CHOICES.filter(
  (choice) => themeAttribute(choice) !== null && choice !== "light",
);

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
    expect(themeAttribute("puredark")).toBe("puredark");
  });

  it("stamps nothing for 'system', leaving the media query in charge", () => {
    expect(themeAttribute("system")).toBeNull();
  });
});

describe("pure dark", () => {
  it("is an explicit choice the OS can never resolve to", () => {
    expect(resolveTheme("puredark", true)).toBe("puredark");
    expect(resolveTheme("puredark", false)).toBe("puredark");
    // No prefers-color-scheme value means "pure black", so 'system' must not
    // reach it — a user who wants black has to say so, and keeps saying it.
    expect(resolveTheme("system", true)).not.toBe("puredark");
    expect(resolveTheme("system", false)).not.toBe("puredark");
  });
});

describe("every stamped choice has paint", () => {
  // Without this, adding a choice and forgetting its palette is invisible in
  // review and silently paints the Dawn tokens instead.
  it("activates a palette block", () => {
    expect(STAMPED.length).toBeGreaterThan(0);
    for (const choice of STAMPED) {
      expect(THEME_CSS).toContain(`:root[data-theme="${choice}"] {`);
    }
  });

  // theme-dark.css's second half activates on `:root:not([data-theme="light"])`,
  // which any other stamped attribute also matches. It carries the same
  // specificity as the theme it would paint over, so the exclusion is what
  // decides the winner — not @import order.
  it("is excluded from the dark media query it would otherwise match", () => {
    const dark = readFileSync(
      new URL("./styles/theme-dark.css", import.meta.url),
      "utf8",
    );
    for (const choice of STAMPED) {
      if (choice === "dark") continue;
      expect(dark).toContain(`:not([data-theme="${choice}"])`);
    }
  });
});
