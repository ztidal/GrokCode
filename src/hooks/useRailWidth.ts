import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/**
 * Drag-to-resize for one column of the three-column shell.
 *
 * Both rails are the same problem mirrored, so they share this rather than
 * growing a second pointer implementation — the app already has exactly one
 * other drag (`useDraggableDialog`), and a third idiom would be two too many.
 *
 * The width reaches CSS as a custom property on `.main-grid`, so the shell stays
 * one grid track list and nothing here has to know about the other columns.
 */
/* ── Shell layout floors ──────────────────────────────────────────────────
 * The three columns negotiate one viewport, so their minimums belong together:
 * each rail's maximum is the viewport minus the other two floors. TypeScript
 * owns these numbers and `workspace.css` reads the defaults back through
 * `var(--left-rail-w, …)`, so the stylesheet cannot drift from the clamp. */

/** Narrowest the middle column may get before the composer stops working. */
export const DETAIL_MIN_PX = 420;
/** Below this the Files/Git tab bar wraps and the tree becomes unreadable. */
export const WORKSPACE_MIN_PX = 260;
/** Below this a project header's name, count and "+" stop fitting on one line. */
export const LEFT_RAIL_MIN_PX = 220;
/** Session rail width before anyone drags it. Mirrored by workspace.css. */
export const LEFT_RAIL_DEFAULT_PX = 360;

export interface RailWidthConfig {
  /** localStorage key. Fork-owned "ztidalcode." prefix (ADR-0003). */
  storageKey: string;
  /** Custom property this rail's width is published as. */
  cssVar: string;
  minPx: number;
  /**
   * Which edge of the rail the handle rides. A handle on the `leading` edge
   * widens the rail as the pointer travels left; on the `trailing` edge, right.
   */
  edge: "leading" | "trailing";
  /** Widest this rail may be for a given viewport. */
  maxWidth: (viewportWidth: number) => number;
}

export interface RailWidthApi {
  /** Attach to the rail element — drag origin and keyboard base width. */
  railRef: RefObject<HTMLElement | null>;
  /** null = no explicit width, i.e. whatever the CSS track gives by default. */
  widthPx: number | null;
  minWidthPx: number;
  maxWidthPx: number;
  resizing: boolean;
  /** Inline custom property for `.main-grid`; undefined keeps the CSS default. */
  style: CSSProperties | undefined;
  resetWidth: () => void;
  /** Positive widens the rail, whichever edge the handle is on. */
  nudgeWidth: (deltaPx: number) => void;
  onResizePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResizePointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResizePointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

export function clampRailWidth(
  px: number,
  viewportWidth: number,
  config: Pick<RailWidthConfig, "minPx" | "maxWidth">,
): number {
  const max = Math.max(config.minPx, config.maxWidth(viewportWidth));
  return Math.round(Math.min(Math.max(px, config.minPx), max));
}

/**
 * Persisted width → usable width. Anything unparseable falls back to null (the
 * CSS default) rather than to a guess, so a corrupt value is invisible.
 */
export function parseStoredRailWidth(
  raw: string | null,
  viewportWidth: number,
  config: Pick<RailWidthConfig, "minPx" | "maxWidth">,
): number | null {
  if (raw == null || raw.trim() === "") return null;
  const px = Number(raw);
  if (!Number.isFinite(px) || px <= 0) return null;
  return clampRailWidth(px, viewportWidth, config);
}

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; /* storage disabled */
  }
}

export function writeStored(key: string, value: string | null): void {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage disabled — layout is a preference, not state we must keep */
  }
}

export function useRailWidth(config: RailWidthConfig): RailWidthApi {
  const { storageKey, cssVar, minPx, edge, maxWidth } = config;
  const railRef = useRef<HTMLElement>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [widthPx, setWidthPx] = useState<number | null>(() =>
    parseStoredRailWidth(readStored(storageKey), window.innerWidth, config),
  );
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    originWidth: number;
  } | null>(null);

  // Config is recreated every render by the calling hook; keep the latest in a
  // ref so the effects below do not re-subscribe on every paint.
  const clampRef = useRef({ minPx, maxWidth });
  clampRef.current = { minPx, maxWidth };
  const clamp = useCallback(
    (px: number) => clampRailWidth(px, window.innerWidth, clampRef.current),
    [],
  );

  useEffect(() => {
    function onResize() {
      setViewportWidth(window.innerWidth);
      setWidthPx((prev) => (prev == null ? prev : clamp(prev)));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  useEffect(() => {
    writeStored(storageKey, widthPx == null ? null : String(widthPx));
  }, [storageKey, widthPx]);

  const resetWidth = useCallback(() => setWidthPx(null), []);

  const nudgeWidth = useCallback(
    (deltaPx: number) => {
      setWidthPx((prev) => {
        // With no explicit width yet, start from what the track renders today.
        const base =
          prev ??
          railRef.current?.getBoundingClientRect().width ??
          clampRef.current.minPx;
        return clamp(base + deltaPx);
      });
    },
    [clamp],
  );

  function onResizePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const rail = railRef.current;
    if (!rail) return;
    // Cancel the drag-select the pointer would otherwise paint across the
    // neighbouring column; that also drops focus, so take it back by hand.
    e.preventDefault();
    e.currentTarget.focus();
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      originWidth: rail.getBoundingClientRect().width,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  }

  function onResizePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const travel = e.clientX - drag.startX;
    setWidthPx(
      clamp(
        edge === "leading"
          ? drag.originWidth - travel
          : drag.originWidth + travel,
      ),
    );
  }

  function onResizePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
      setResizing(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }
  }

  return {
    railRef,
    widthPx,
    minWidthPx: minPx,
    maxWidthPx: Math.max(minPx, maxWidth(viewportWidth)),
    resizing,
    style:
      widthPx != null
        ? ({ [cssVar]: `${widthPx}px` } as CSSProperties)
        : undefined,
    resetWidth,
    nudgeWidth,
    onResizePointerDown,
    onResizePointerMove,
    onResizePointerUp,
  };
}
