import { describe, expect, it } from "vitest";
import {
  clampWorkspaceWidth,
  parseStoredCollapsed,
  parseStoredWidth,
  workspaceMaxWidth,
  WORKSPACE_MIN_PX,
} from "./useWorkspaceWidth";

/** 1600 − 180 rail − 420 detail = 1000px of headroom. */
const WIDE = 1600;

describe("workspaceMaxWidth", () => {
  it("leaves room for the left rail and a usable detail column", () => {
    expect(workspaceMaxWidth(WIDE)).toBe(1000);
  });

  it("never drops below the minimum on a cramped viewport", () => {
    expect(workspaceMaxWidth(700)).toBe(WORKSPACE_MIN_PX);
    expect(workspaceMaxWidth(0)).toBe(WORKSPACE_MIN_PX);
  });
});

describe("clampWorkspaceWidth", () => {
  it("passes through a width inside the band", () => {
    expect(clampWorkspaceWidth(520, WIDE)).toBe(520);
  });

  it("clamps to the minimum and the viewport-derived maximum", () => {
    expect(clampWorkspaceWidth(10, WIDE)).toBe(WORKSPACE_MIN_PX);
    expect(clampWorkspaceWidth(9000, WIDE)).toBe(1000);
  });

  it("rounds to whole pixels so the CSS variable stays stable", () => {
    expect(clampWorkspaceWidth(520.4, WIDE)).toBe(520);
    expect(clampWorkspaceWidth(520.6, WIDE)).toBe(521);
  });

  it("prefers the minimum when the viewport cannot honour both bounds", () => {
    expect(clampWorkspaceWidth(900, 700)).toBe(WORKSPACE_MIN_PX);
  });
});

describe("parseStoredWidth", () => {
  it("treats an absent or blank value as the 1fr default", () => {
    expect(parseStoredWidth(null, WIDE)).toBeNull();
    expect(parseStoredWidth("", WIDE)).toBeNull();
    expect(parseStoredWidth("   ", WIDE)).toBeNull();
  });

  it("discards junk rather than guessing a width", () => {
    expect(parseStoredWidth("wide", WIDE)).toBeNull();
    expect(parseStoredWidth("NaN", WIDE)).toBeNull();
    expect(parseStoredWidth("Infinity", WIDE)).toBeNull();
    expect(parseStoredWidth("0", WIDE)).toBeNull();
    expect(parseStoredWidth("-40", WIDE)).toBeNull();
  });

  it("clamps a width persisted on a larger monitor", () => {
    expect(parseStoredWidth("900", WIDE)).toBe(900);
    expect(parseStoredWidth("900", 900)).toBe(300);
    expect(parseStoredWidth("900", 700)).toBe(WORKSPACE_MIN_PX);
  });
});

describe("parseStoredCollapsed", () => {
  it("only the written marker collapses", () => {
    expect(parseStoredCollapsed("1")).toBe(true);
    expect(parseStoredCollapsed("0")).toBe(false);
    expect(parseStoredCollapsed(null)).toBe(false);
    expect(parseStoredCollapsed("true")).toBe(false);
  });
});
