/** One installed Codex pet package under `~/.codex/pets`. */
export interface CodexPet {
  id: string;
  displayName: string;
  description: string;
  spriteVersion: number;
  spritesheetPath: string;
}

export interface PetPrefs {
  enabled: boolean;
  selectedPetId?: string | null;
  x?: number | null;
  y?: number | null;
}

export interface PetPrefsPatch {
  enabled?: boolean;
  selectedPetId?: string | null;
  x?: number | null;
  y?: number | null;
}

/** Persistent task motion. Drag / hover / gaze are overlay-local. */
export type PetMotion = "idle" | "running" | "waiting" | "failed" | "review";

export interface PetActivity {
  motion: PetMotion;
  label: string;
  detail?: string;
  title?: string;
}

export const PET_ACTIVITY_EVENT = "pet-activity";
export const PET_PREFS_EVENT = "pet-prefs";
