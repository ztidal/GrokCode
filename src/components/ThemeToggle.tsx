import { useEffect, useState } from "react";
import {
  THEME_CHOICES,
  getResolvedTheme,
  getThemeChoice,
  onThemeChange,
  setThemeChoice,
  type ThemeChoice,
} from "../theme";

const LABELS: Record<ThemeChoice, string> = {
  light: "Light",
  dark: "Dark",
  puredark: "Pure Dark",
  warmgold: "Warm Gold",
  system: "System",
};

/**
 * Segmented Light / Dark / Pure Dark / System control for the Settings menu.
 *
 * Subscribes to `onThemeChange` rather than owning the choice: with `system`
 * selected the effective theme moves without anyone clicking, and the row has to
 * follow the OS.
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice);
  const [resolved, setResolved] = useState(getResolvedTheme);

  useEffect(
    () =>
      onThemeChange((next) => {
        setChoice(getThemeChoice());
        setResolved(next);
      }),
    [],
  );

  return (
    <div className="theme-toggle-row">
      <span className="theme-toggle-label">
        Theme
        {choice === "system" ? (
          <span className="theme-toggle-hint"> · {LABELS[resolved]}</span>
        ) : null}
      </span>
      <div className="theme-toggle" role="radiogroup" aria-label="Theme">
        {THEME_CHOICES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={choice === option}
            className="theme-toggle-option"
            onClick={() => {
              setThemeChoice(option);
              setChoice(option);
              setResolved(getResolvedTheme());
            }}
          >
            {LABELS[option]}
          </button>
        ))}
      </div>
    </div>
  );
}
