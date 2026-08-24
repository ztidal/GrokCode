import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { getPetPrefs, listCodexPets, setPetPrefs } from "../api";
import { PET_PREFS_EVENT, type CodexPet, type PetPrefs } from "./types";

/**
 * Settings row for the Codex pet overlay. Self-contained, like ThemeToggle:
 * it talks to the host, so the title-bar Settings panel stays a dumb shell.
 *
 * Pets are buttons, not a native <select>: the Settings menu closes on
 * pointerdown outside itself, and the OS combobox is outside the menu.
 */
export function PetSettings() {
  const [pets, setPets] = useState<CodexPet[]>([]);
  const [prefs, setPrefs] = useState<PetPrefs>({ enabled: true });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([listCodexPets(), getPetPrefs()])
      .then(([nextPets, nextPrefs]) => {
        if (cancelled) return;
        setPets(nextPets);
        setPrefs(nextPrefs);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    let unlisten: (() => void) | undefined;
    void listen<PetPrefs>(PET_PREFS_EVENT, ({ payload }) => {
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

  const apply = (patch: Partial<PetPrefs>) => {
    void setPetPrefs(patch)
      .then((next) => setPrefs(next))
      .catch(() => {
        /* overlay failure is reported by the pet simply not appearing */
      });
  };

  const selected =
    prefs.selectedPetId && pets.some((pet) => pet.id === prefs.selectedPetId)
      ? prefs.selectedPetId
      : (pets[0]?.id ?? "");

  return (
    <div className="pet-settings-row">
      <button
        className="desktop-settings-item"
        type="button"
        disabled={!ready || pets.length === 0}
        onClick={() => apply({ enabled: !prefs.enabled })}
      >
        <span>Codex pet</span>
        <span className="desktop-settings-item-status">
          {pets.length === 0 ? "None installed" : prefs.enabled ? "On" : "Off"}
        </span>
      </button>
      {pets.length > 0 ? (
        <div className="pet-settings-pick">
          <span className="pet-settings-pick-label">Pet</span>
          <div
            className="pet-settings-options"
            role="radiogroup"
            aria-label="Pet"
          >
            {pets.map((pet) => (
              <button
                key={pet.id}
                type="button"
                role="radio"
                aria-checked={selected === pet.id}
                className="pet-settings-option"
                disabled={!prefs.enabled}
                onClick={() => apply({ selectedPetId: pet.id })}
              >
                {pet.displayName}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="pet-settings-hint">
          Install a package under ~/.codex/pets to float it over the desktop.
        </p>
      )}
    </div>
  );
}
