import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

/** Arrow-key step on the handle; Shift jumps in coarser increments. */
const NUDGE_PX = 16;
const NUDGE_COARSE_PX = 64;

interface Props {
  /**
   * Which edge of its rail this handle rides. Decides only which arrow key
   * widens — the pointer maths lives in `useRailWidth`, which knows the same
   * thing and must be given the matching value.
   */
  edge?: "leading" | "trailing";
  /** Announced to screen readers, e.g. "Resize workspace panel". */
  label?: string;
  /** Extra class for the edge-specific placement rules. */
  className?: string;
  /** null while the rail is still its default CSS track. */
  widthPx: number | null;
  minWidthPx: number;
  maxWidthPx: number;
  resizing: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  /** Positive widens the rail. */
  onNudge: (deltaPx: number) => void;
  onReset: () => void;
}

/**
 * Drag handle on a rail's edge — used by both the session rail and the
 * workspace rail.
 * Not to be confused with `.workspace-split`, the decorative hairline between
 * the panel's two halves — that one is inert and lives inside the panel.
 */
export function WorkspaceSplitter({
  edge = "leading",
  label = "Resize workspace panel",
  className = "",
  widthPx,
  minWidthPx,
  maxWidthPx,
  resizing,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onNudge,
  onReset,
}: Props) {
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? NUDGE_COARSE_PX : NUDGE_PX;
    // Whichever arrow points away from the rail's body widens it.
    const widens = edge === "leading" ? "ArrowLeft" : "ArrowRight";
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      onNudge(e.key === widens ? step : -step);
    } else if (e.key === "Home") {
      e.preventDefault();
      onReset();
    }
  }

  return (
    <div
      className={
        "workspace-resize-handle" +
        (className ? " " + className : "") +
        (resizing ? " is-resizing" : "")
      }
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={minWidthPx}
      aria-valuemax={maxWidthPx}
      // Only announce a value once one has been chosen — until then the rail
      // is a 1fr share whose pixel width nothing has measured.
      aria-valuenow={widthPx ?? undefined}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
