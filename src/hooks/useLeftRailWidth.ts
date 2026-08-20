import {
  DETAIL_MIN_PX,
  LEFT_RAIL_MIN_PX,
  WORKSPACE_MIN_PX,
  useRailWidth,
  type RailWidthApi,
} from "./useRailWidth";

/** Fork-owned key — upstream stores nothing under this prefix (ADR-0003). */
const LEFT_WIDTH_KEY = "ztidalcode.leftRail.width";

/** Widest the session rail may be: the other two columns keep their floors. */
export function leftRailMaxWidth(viewportWidth: number): number {
  return Math.max(
    LEFT_RAIL_MIN_PX,
    viewportWidth - WORKSPACE_MIN_PX - DETAIL_MIN_PX,
  );
}

export function useLeftRailWidth(): RailWidthApi {
  return useRailWidth({
    storageKey: LEFT_WIDTH_KEY,
    cssVar: "--left-rail-w",
    minPx: LEFT_RAIL_MIN_PX,
    // Handle rides the rail's right edge, so rightward travel widens it.
    edge: "trailing",
    maxWidth: leftRailMaxWidth,
  });
}
