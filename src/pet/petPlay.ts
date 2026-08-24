import type { AtlasRowName } from "./petAtlas";
import type { PetMotion } from "./types";

/** 16 look poses: 0 = screen-up, then clockwise 22.5° steps (hatch-pet v2). */
export const LOOK_STEP_DEG = 22.5;
export const LOOK_COUNT = 16;

export type OverlayPresentation =
  | { kind: "animate"; row: AtlasRowName }
  | { kind: "look"; index: number };

/**
 * Screen-space look index. `dy` is down-positive.
 * 0 is up, 4 is screen-right, 8 is down, 12 is screen-left.
 */
export function lookIndexFromDelta(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return Math.round(deg / LOOK_STEP_DEG) % LOOK_COUNT;
}

export function dragLocomotion(
  dx: number,
): Extract<AtlasRowName, "running-left" | "running-right"> | null {
  if (dx > 0) return "running-right";
  if (dx < 0) return "running-left";
  return null;
}

export function baseRow(
  motion: PetMotion,
  failedConsumed: boolean,
): AtlasRowName {
  switch (motion) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "review":
      return "review";
    case "failed":
      return failedConsumed ? "idle" : "failed";
    default:
      return "idle";
  }
}

/**
 * Codex overlay stack: drag locomotion, then a one-shot (jump/wave/fail),
 * then v2 gaze while idle, else the looping task row.
 */
export function resolveOverlayPresentation(input: {
  motion: PetMotion;
  dragging: boolean;
  dragRow: Extract<AtlasRowName, "running-left" | "running-right"> | null;
  oneshot: AtlasRowName | null;
  lookIndex: number | null;
  spriteVersion: number;
  failedConsumed: boolean;
}): OverlayPresentation {
  if (input.dragging && input.dragRow) {
    return { kind: "animate", row: input.dragRow };
  }
  if (input.oneshot) {
    return { kind: "animate", row: input.oneshot };
  }
  const row = baseRow(input.motion, input.failedConsumed);
  if (
    row === "idle" &&
    input.spriteVersion >= 2 &&
    input.lookIndex != null
  ) {
    return { kind: "look", index: input.lookIndex };
  }
  return { kind: "animate", row };
}
