import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

/** Arrow-key step on the handle; Shift jumps in coarser increments. */
const NUDGE_PX = 16;
const NUDGE_COARSE_PX = 64;

interface Props {
  /** null while the rail is still the CSS 1fr share. */
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
 * Drag handle on the workspace rail's left edge.
 * Not to be confused with `.workspace-split`, the decorative hairline between
 * the panel's two halves — that one is inert and lives inside the panel.
 */
export function WorkspaceSplitter({
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
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onNudge(step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onNudge(-step);
    } else if (e.key === "Home") {
      e.preventDefault();
      onReset();
    }
  }

  return (
    <div
      className={"workspace-resize-handle" + (resizing ? " is-resizing" : "")}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize workspace panel"
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
