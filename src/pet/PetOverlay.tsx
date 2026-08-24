import { listen } from "@tauri-apps/api/event";
import {
  cursorPosition,
  getCurrentWindow,
} from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getPetPrefs,
  listCodexPets,
  readPetSpritesheet,
  setPetPrefs,
} from "../api";
import { initTheme } from "../theme";
import "../styles/tokens.css";
import "../styles/theme-dark.css";
import "../styles/theme-puredark.css";
import "../styles/theme-warmgold.css";
import {
  atlasPixelSize,
  backgroundPosition,
  CELL_H,
  CELL_W,
  frameDurationMs,
  lookBackgroundPosition,
  nextFrame,
  type AtlasRowName,
} from "./petAtlas";
import {
  dragLocomotion,
  lookIndexFromDelta,
  resolveOverlayPresentation,
} from "./petPlay";
import {
  PET_ACTIVITY_EVENT,
  PET_PREFS_EVENT,
  type CodexPet,
  type PetActivity,
  type PetPrefs,
} from "./types";
import "../styles/pet-overlay.css";

const IDLE: PetActivity = { motion: "idle", label: "Idle" };
const DRAG_PX = 4;
const DRAG_END_MS = 160;
const LOOK_MS = 80;

function pickPet(pets: CodexPet[], prefs: PetPrefs): CodexPet | null {
  if (pets.length === 0) return null;
  if (prefs.selectedPetId) {
    const found = pets.find((item) => item.id === prefs.selectedPetId);
    if (found) return found;
  }
  return pets[0] ?? null;
}

export function PetOverlay() {
  const [pets, setPets] = useState<CodexPet[]>([]);
  const [prefs, setPrefs] = useState<PetPrefs>({ enabled: true });
  const [sheet, setSheet] = useState<string | null>(null);
  const [activity, setActivity] = useState<PetActivity>(IDLE);
  const [oneshot, setOneshot] = useState<AtlasRowName | null>(null);
  const [frame, setFrame] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dragRow, setDragRow] = useState<
    Extract<AtlasRowName, "running-left" | "running-right"> | null
  >(null);
  const [lookIndex, setLookIndex] = useState<number | null>(null);
  const [failedConsumed, setFailedConsumed] = useState(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const dragEndTimer = useRef<number | null>(null);
  const dismissing = useRef(false);

  const pet = pickPet(pets, prefs);
  const version = pet?.spriteVersion ?? 1;
  const atlas = atlasPixelSize(version);
  const presentation = useMemo(
    () =>
      resolveOverlayPresentation({
        motion: activity.motion,
        dragging,
        dragRow,
        oneshot,
        lookIndex,
        spriteVersion: version,
        failedConsumed,
      }),
    [
      activity.motion,
      dragging,
      dragRow,
      oneshot,
      lookIndex,
      version,
      failedConsumed,
    ],
  );

  useEffect(() => {
    initTheme();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [nextPets, nextPrefs] = await Promise.all([
          listCodexPets(),
          getPetPrefs(),
        ]);
        if (cancelled) return;
        setPets(nextPets);
        setPrefs(nextPrefs);
      } catch {
        /* overlay is ornamental; a failed list just shows nothing */
      }
    };
    void load();
    let unlisten: (() => void) | undefined;
    void listen<PetPrefs>(PET_PREFS_EVENT, ({ payload }) => {
      dismissing.current = !payload.enabled;
      setPrefs(payload);
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!pet) {
      setSheet(null);
      return;
    }
    let cancelled = false;
    void readPetSpritesheet(pet.id)
      .then((url) => {
        if (cancelled) return;
        setSheet(url);
        setOneshot("waving");
        setFrame(0);
      })
      .catch(() => {
        if (!cancelled) setSheet(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pet?.id]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<PetActivity>(PET_ACTIVITY_EVENT, ({ payload }) => {
      if (cancelled || !payload?.motion) return;
      setActivity(payload);
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (activity.motion !== "failed") {
      setFailedConsumed(false);
      return;
    }
    if (!failedConsumed && !oneshot && !dragging) {
      setOneshot("failed");
      setFrame(0);
    }
  }, [activity.motion, failedConsumed, oneshot, dragging]);

  const playKey =
    presentation.kind === "look"
      ? `look:${presentation.index}`
      : presentation.row;
  useEffect(() => {
    setFrame(0);
  }, [playKey]);

  useEffect(() => {
    if (presentation.kind === "look") return;
    const row = presentation.row;
    const delay = frameDurationMs(row, frame);
    const id = window.setTimeout(() => {
      if (oneshot && presentation.row === oneshot) {
        const next = nextFrame(row, frame);
        if (next === 0 && frame > 0) {
          if (oneshot === "failed") setFailedConsumed(true);
          setOneshot(null);
          setFrame(0);
          return;
        }
        setFrame(next);
        return;
      }
      setFrame((current) => nextFrame(row, current));
    }, delay);
    return () => window.clearTimeout(id);
  }, [presentation, frame, oneshot]);

  useEffect(() => {
    const win = getCurrentWindow();
    let saveTimer: number | null = null;
    let unlisten: (() => void) | undefined;
    const finishDrag = () => {
      setDragging(false);
      setDragRow(null);
      setOneshot("jumping");
      setFrame(0);
    };
    const flush = (x: number, y: number) => {
      if (saveTimer != null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        void setPetPrefs({ x, y }).catch(() => {});
      }, 400);
    };
    void win
      .onMoved(({ payload }) => {
        if (dismissing.current) return;
        const prev = lastPos.current;
        lastPos.current = { x: payload.x, y: payload.y };
        if (!prev) {
          flush(payload.x, payload.y);
          return;
        }
        const dx = payload.x - prev.x;
        const walk = Math.abs(dx) >= DRAG_PX ? dragLocomotion(dx) : null;
        if (walk) {
          setDragging(true);
          setDragRow(walk);
          setOneshot(null);
          if (dragEndTimer.current != null) {
            window.clearTimeout(dragEndTimer.current);
          }
          dragEndTimer.current = window.setTimeout(finishDrag, DRAG_END_MS);
        }
        flush(payload.x, payload.y);
      })
      .then((dispose) => {
        unlisten = dispose;
      });
    return () => {
      unlisten?.();
      if (saveTimer != null) window.clearTimeout(saveTimer);
      if (dragEndTimer.current != null) window.clearTimeout(dragEndTimer.current);
    };
  }, []);

  useEffect(() => {
    if (
      !prefs.enabled ||
      version < 2 ||
      activity.motion !== "idle" ||
      dragging ||
      oneshot
    ) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const win = getCurrentWindow();
        const [cursor, origin, size] = await Promise.all([
          cursorPosition(),
          win.outerPosition(),
          win.outerSize(),
        ]);
        if (cancelled) return;
        const cx = origin.x + size.width / 2;
        const cy = origin.y + Math.min(size.height / 2, 12 + CELL_H / 2);
        setLookIndex(lookIndexFromDelta(cursor.x - cx, cursor.y - cy));
      } catch {
        /* no cursor permission / vite preview */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), LOOK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [prefs.enabled, version, activity.motion, dragging, oneshot]);

  const playOneshot = (next: AtlasRowName) => {
    if (dragging) return;
    setOneshot(next);
    setFrame(0);
  };

  const hide = () => {
    dismissing.current = true;
    if (dragEndTimer.current != null) {
      window.clearTimeout(dragEndTimer.current);
      dragEndTimer.current = null;
    }
    void setPetPrefs({ enabled: false }).catch(() => {});
  };

  const chipLabel = activity.detail
    ? activity.label
    : activity.label.replace(/…$/, "");
  const chipTitle = activity.title;
  const spritePos =
    presentation.kind === "look"
      ? lookBackgroundPosition(presentation.index)
      : backgroundPosition(presentation.row, frame);

  return (
    <div
      className="pet-overlay-root"
      onMouseEnter={() => playOneshot("jumping")}
    >
      <div
        className="pet-overlay-sprite"
        data-tauri-drag-region
        role="img"
        aria-label={pet?.displayName ?? "Codex pet"}
        style={
          sheet
            ? {
                width: CELL_W,
                height: CELL_H,
                backgroundImage: `url("${sheet}")`,
                backgroundRepeat: "no-repeat",
                backgroundSize: `${atlas.width}px ${atlas.height}px`,
                backgroundPosition: spritePos,
              }
            : { width: CELL_W, height: CELL_H }
        }
      />
      <div className="pet-overlay-dock">
        <div className="pet-overlay-chip" data-tauri-drag-region>
          <span className={`pet-overlay-dot is-${activity.motion}`} />
          <span className="pet-overlay-copy">
            <span className="pet-overlay-label">{chipLabel}</span>
            {chipTitle ? (
              <span className="pet-overlay-title">{chipTitle}</span>
            ) : null}
          </span>
        </div>
        <button
          type="button"
          className="pet-overlay-close"
          aria-label="Hide pet"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            hide();
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
