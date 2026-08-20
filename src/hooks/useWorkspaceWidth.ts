import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/** Fork-owned keys — upstream stores nothing under this prefix (ADR-0003). */
const WIDTH_KEY = "ztidalcode.workspace.width";
const COLLAPSED_KEY = "ztidalcode.workspace.collapsed";

/** The fixed left rail track from workspace.css. */
const LEFT_RAIL_PX = 180;
/** Narrowest the middle column may get before the composer stops working. */
const MIN_DETAIL_PX = 420;
/** Below this the Files/Git tab bar wraps and the tree becomes unreadable. */
export const WORKSPACE_MIN_PX = 260;

export interface WorkspaceWidthApi {
  /** Attach to the workspace `<aside>` — drag origin and keyboard base width. */
  panelRef: RefObject<HTMLElement | null>;
  /** null = no explicit width, i.e. the even 1fr split CSS gives by default. */
  widthPx: number | null;
  minWidthPx: number;
  maxWidthPx: number;
  collapsed: boolean;
  resizing: boolean;
  /** Inline `--workspace-w` for .main-grid; undefined keeps the CSS default. */
  gridStyle: CSSProperties | undefined;
  toggleCollapsed: () => void;
  resetWidth: () => void;
  nudgeWidth: (deltaPx: number) => void;
  onResizePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResizePointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResizePointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

/**
 * Widest the rail may be for a given viewport.
 * Exported for unit tests.
 */
export function workspaceMaxWidth(viewportWidth: number): number {
  return Math.max(
    WORKSPACE_MIN_PX,
    viewportWidth - LEFT_RAIL_PX - MIN_DETAIL_PX,
  );
}

/**
 * Clamp a candidate rail width to the current viewport.
 * Exported for unit tests.
 */
export function clampWorkspaceWidth(
  px: number,
  viewportWidth: number,
): number {
  const max = workspaceMaxWidth(viewportWidth);
  return Math.round(Math.min(Math.max(px, WORKSPACE_MIN_PX), max));
}

/**
 * Persisted width → usable width. Anything unparseable falls back to null
 * (the 1fr default) rather than to a guess, so a corrupt value is invisible.
 * Exported for unit tests.
 */
export function parseStoredWidth(
  raw: string | null,
  viewportWidth: number,
): number | null {
  if (raw == null || raw.trim() === "") return null;
  const px = Number(raw);
  if (!Number.isFinite(px) || px <= 0) return null;
  return clampWorkspaceWidth(px, viewportWidth);
}

/** Exported for unit tests. */
export function parseStoredCollapsed(raw: string | null): boolean {
  return raw === "1";
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; /* storage disabled */
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage disabled — layout is a preference, not state we must keep */
  }
}

/**
 * Width and collapse state for the right workspace rail, both persisted.
 * The width reaches CSS as a custom property on .main-grid so the whole
 * three-column shell stays one grid track list.
 */
export function useWorkspaceWidth(): WorkspaceWidthApi {
  const panelRef = useRef<HTMLElement>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [widthPx, setWidthPx] = useState<number | null>(() =>
    parseStoredWidth(readStored(WIDTH_KEY), window.innerWidth),
  );
  const [collapsed, setCollapsed] = useState(() =>
    parseStoredCollapsed(readStored(COLLAPSED_KEY)),
  );
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    originWidth: number;
  } | null>(null);

  useEffect(() => {
    function onResize() {
      setViewportWidth(window.innerWidth);
      setWidthPx((prev) =>
        prev == null ? prev : clampWorkspaceWidth(prev, window.innerWidth),
      );
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    writeStored(WIDTH_KEY, widthPx == null ? null : String(widthPx));
  }, [widthPx]);

  useEffect(() => {
    writeStored(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => !v);
  }, []);

  const resetWidth = useCallback(() => {
    setWidthPx(null);
  }, []);

  const nudgeWidth = useCallback((deltaPx: number) => {
    setWidthPx((prev) => {
      // With no explicit width yet, start from whatever 1fr currently renders.
      const base =
        prev ??
        panelRef.current?.getBoundingClientRect().width ??
        WORKSPACE_MIN_PX;
      return clampWorkspaceWidth(base + deltaPx, window.innerWidth);
    });
  }, []);

  function onResizePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;

    // Cancel the drag-select the pointer would otherwise paint across the
    // detail column; that also drops focus, so take it back by hand.
    e.preventDefault();
    e.currentTarget.focus();

    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      originWidth: panel.getBoundingClientRect().width,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  }

  function onResizePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    // Handle rides the panel's left edge, so leftward travel widens it.
    setWidthPx(
      clampWorkspaceWidth(
        drag.originWidth - (e.clientX - drag.startX),
        window.innerWidth,
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

  const gridStyle: CSSProperties | undefined =
    widthPx != null
      ? ({ "--workspace-w": `${widthPx}px` } as CSSProperties)
      : undefined;

  return {
    panelRef,
    widthPx,
    minWidthPx: WORKSPACE_MIN_PX,
    maxWidthPx: workspaceMaxWidth(viewportWidth),
    collapsed,
    resizing,
    gridStyle,
    toggleCollapsed,
    resetWidth,
    nudgeWidth,
    onResizePointerDown,
    onResizePointerMove,
    onResizePointerUp,
  };
}
