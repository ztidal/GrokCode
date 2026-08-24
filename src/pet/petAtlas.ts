/**
 * Codex pet atlas contract (openai/skills hatch-pet).
 *
 * V1: 1536×1872, 8×9 cells of 192×208.
 * V2: 1536×2288, 8×11 — same first nine rows, plus look-direction rows we ignore.
 */

export const CELL_W = 192;
export const CELL_H = 208;
export const ATLAS_COLS = 8;

export type AtlasRowName =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export const ATLAS_ROW: Record<AtlasRowName, number> = {
  idle: 0,
  "running-right": 1,
  "running-left": 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8,
};

/** Per-frame durations in ms; last value is the hold on the final used column. */
export const ATLAS_FRAMES: Record<AtlasRowName, number[]> = {
  idle: [280, 110, 110, 140, 140, 320],
  "running-right": [120, 120, 120, 120, 120, 120, 120, 220],
  "running-left": [120, 120, 120, 120, 120, 120, 120, 220],
  waving: [140, 140, 140, 280],
  jumping: [140, 140, 140, 140, 280],
  failed: [140, 140, 140, 140, 140, 140, 140, 240],
  waiting: [150, 150, 150, 150, 150, 260],
  running: [120, 120, 120, 120, 120, 220],
  review: [150, 150, 150, 150, 150, 280],
};

export function atlasPixelSize(spriteVersion: number): {
  width: number;
  height: number;
} {
  const rows = spriteVersion >= 2 ? 11 : 9;
  return { width: ATLAS_COLS * CELL_W, height: rows * CELL_H };
}

export function frameCount(row: AtlasRowName): number {
  return ATLAS_FRAMES[row].length;
}

export function frameDurationMs(row: AtlasRowName, frame: number): number {
  const frames = ATLAS_FRAMES[row];
  if (frames.length === 0) return 280;
  const index = ((frame % frames.length) + frames.length) % frames.length;
  return frames[index] ?? 280;
}

export function nextFrame(row: AtlasRowName, frame: number): number {
  const n = frameCount(row);
  if (n <= 0) return 0;
  return (frame + 1) % n;
}

export function backgroundPosition(row: AtlasRowName, frame: number): string {
  const n = frameCount(row);
  const col = n <= 0 ? 0 : ((frame % n) + n) % n;
  return cellPosition(ATLAS_ROW[row], col);
}

/** V2 rows 9–10: 16 static poses, 000° up then clockwise 22.5°. */
export function lookCell(index: number): { row: number; col: number } {
  const i = ((index % 16) + 16) % 16;
  if (i < 8) return { row: 9, col: i };
  return { row: 10, col: i - 8 };
}

export function lookBackgroundPosition(index: number): string {
  const cell = lookCell(index);
  return cellPosition(cell.row, cell.col);
}

function cellPosition(row: number, col: number): string {
  return `-${col * CELL_W}px -${row * CELL_H}px`;
}
