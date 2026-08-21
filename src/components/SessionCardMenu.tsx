import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface CardMenuItem {
  label: string;
  onSelect: () => void;
  /** Sets it apart and puts it last: the one item you cannot undo by repeating. */
  danger?: boolean;
  /** A separator is drawn above this item. */
  separated?: boolean;
}

interface Props {
  /** Where the menu was opened — a click point, in viewport coordinates. */
  at: { x: number; y: number };
  items: CardMenuItem[];
  onClose: () => void;
  /** Names the card, for screen readers that announce the menu on open. */
  label: string;
}

/** Keeps the menu on screen when it opens near an edge. */
function clamp(value: number, size: number, limit: number): number {
  const margin = 8;
  return Math.max(margin, Math.min(value, limit - size - margin));
}

/**
 * The per-card action menu, opened by the card's ⋮ or by right-clicking it.
 *
 * In a portal on `body`, not inside the card: the session rail scrolls and clips
 * its overflow, and a menu that is cut off by the list it belongs to is worse
 * than no menu. `position: fixed` alone would not be enough — any transformed
 * ancestor would capture it — so the DOM position is what guarantees this.
 */
export function SessionCardMenu({ at, items, onClose, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  // Measure after paint but before the browser shows it, so a menu opened near
  // the bottom of the screen never appears in the wrong place first.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: clamp(at.x, width, window.innerWidth),
      y: clamp(at.y, height, window.innerHeight),
    });
    el.querySelector<HTMLButtonElement>("button")?.focus();
  }, [at.x, at.y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture, and on pointerdown rather than click: the card underneath opens a
    // session on click, and a dismissing click must not also do that.
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    // A menu anchored to a point cannot follow the list it was opened over.
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="session-card-menu"
      role="menu"
      aria-label={`Actions for ${label}`}
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={[
            "session-card-menu-item",
            item.danger ? "danger" : "",
            item.separated ? "separated" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
