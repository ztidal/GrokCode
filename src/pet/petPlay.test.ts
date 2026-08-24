import { describe, expect, it } from "vitest";
import {
  baseRow,
  dragLocomotion,
  lookIndexFromDelta,
  resolveOverlayPresentation,
} from "./petPlay";

describe("lookIndexFromDelta", () => {
  it("starts at up and walks clockwise in 22.5° steps", () => {
    expect(lookIndexFromDelta(0, -10)).toBe(0);
    expect(lookIndexFromDelta(10, 0)).toBe(4);
    expect(lookIndexFromDelta(0, 10)).toBe(8);
    expect(lookIndexFromDelta(-10, 0)).toBe(12);
  });
});

describe("dragLocomotion", () => {
  it("picks the atlas walk row from horizontal delta", () => {
    expect(dragLocomotion(8)).toBe("running-right");
    expect(dragLocomotion(-8)).toBe("running-left");
    expect(dragLocomotion(0)).toBeNull();
  });
});

describe("resolveOverlayPresentation", () => {
  const base = {
    motion: "idle" as const,
    dragging: false,
    dragRow: null,
    oneshot: null,
    lookIndex: null,
    spriteVersion: 2,
    failedConsumed: false,
  };

  it("lets drag win over task motion and one-shots", () => {
    expect(
      resolveOverlayPresentation({
        ...base,
        motion: "running",
        dragging: true,
        dragRow: "running-left",
        oneshot: "jumping",
      }),
    ).toEqual({ kind: "animate", row: "running-left" });
  });

  it("plays a one-shot over idle gaze", () => {
    expect(
      resolveOverlayPresentation({
        ...base,
        oneshot: "jumping",
        lookIndex: 4,
      }),
    ).toEqual({ kind: "animate", row: "jumping" });
  });

  it("uses v2 look poses while idle, and idle looping on v1", () => {
    expect(
      resolveOverlayPresentation({ ...base, lookIndex: 4 }),
    ).toEqual({ kind: "look", index: 4 });
    expect(
      resolveOverlayPresentation({
        ...base,
        spriteVersion: 1,
        lookIndex: 4,
      }),
    ).toEqual({ kind: "animate", row: "idle" });
  });

  it("loops running / waiting / review, and spends failed once", () => {
    expect(baseRow("running", false)).toBe("running");
    expect(baseRow("waiting", false)).toBe("waiting");
    expect(baseRow("review", false)).toBe("review");
    expect(baseRow("failed", false)).toBe("failed");
    expect(baseRow("failed", true)).toBe("idle");
  });
});
