import { describe, expect, it } from "vitest";
import {
  ATLAS_FRAMES,
  atlasPixelSize,
  backgroundPosition,
  frameCount,
  frameDurationMs,
  lookBackgroundPosition,
  lookCell,
  nextFrame,
} from "./petAtlas";

describe("petAtlas", () => {
  it("sizes v1 and v2 sheets from the Codex contract", () => {
    expect(atlasPixelSize(1)).toEqual({ width: 1536, height: 1872 });
    expect(atlasPixelSize(2)).toEqual({ width: 1536, height: 2288 });
  });

  it("walks idle frames in a loop with the published timings", () => {
    expect(frameCount("idle")).toBe(6);
    expect(frameDurationMs("idle", 0)).toBe(280);
    expect(frameDurationMs("idle", 5)).toBe(320);
    expect(nextFrame("idle", 5)).toBe(0);
    expect(backgroundPosition("idle", 3)).toBe("-576px -0px");
    expect(backgroundPosition("running", 0)).toBe("-0px -1456px");
  });

  it("uses eight frames on failed and the locomotion rows", () => {
    expect(ATLAS_FRAMES.failed).toHaveLength(8);
    expect(ATLAS_FRAMES["running-right"]).toHaveLength(8);
    expect(backgroundPosition("failed", 7)).toBe("-1344px -1040px");
  });

  it("maps v2 look poses onto rows 9–10", () => {
    expect(lookCell(0)).toEqual({ row: 9, col: 0 });
    expect(lookCell(4)).toEqual({ row: 9, col: 4 });
    expect(lookCell(8)).toEqual({ row: 10, col: 0 });
    expect(lookCell(12)).toEqual({ row: 10, col: 4 });
    expect(lookBackgroundPosition(8)).toBe("-0px -2080px");
  });
});
