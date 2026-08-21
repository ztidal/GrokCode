/**
 * Light / dark / pure dark / follow-the-OS, persisted.
 *
 * The paint lives entirely in CSS (tokens.css + theme-dark.css +
 * theme-puredark.css); this module only decides which activation selector is
 * armed. 'system' deliberately writes *no* attribute and lets
 * `prefers-color-scheme` decide, so the page is already the right colour before
 * any of this runs — the app's CSP (`script-src 'self'`) forbids the inline
 * <script> that would otherwise be the usual pre-paint hook.
 *
 * 'puredark' and 'warmgold' are choices the OS can never make for you: no
 * `prefers-color-scheme` value means "pure black" (warmgold is that black with
 * warm accents), so they exist only as stamped attributes and never come back
 * out of `resolveTheme('system', …)`.
 */

/** Fork-owned key — upstream stores nothing under this prefix (ADR-0003). */
const THEME_KEY = "ztidalcode.theme";

export const THEME_CHOICES = [
  "light",
  "dark",
  "puredark",
  "warmgold",
  "system",
] as const;

/**
 * What an unconfigured install paints. Not 'system': the app is a long-running
 * console that sits beside a terminal, and following an OS that is usually
 * light put it at odds with everything around it. Any other choice is one
 * click, and is then persisted like any other choice.
 *
 * The default is the one theme the boot splash cannot pre-empt, since no
 * `prefers-color-scheme` value matches it — a fresh install under a light OS
 * therefore shows one Dawn frame before this lands. The CSP (`script-src
 * 'self'`) forbids the inline <script> that would otherwise read the stored
 * choice before first paint, so that frame is the price of the default and not
 * a bug to chase.
 */
export const DEFAULT_CHOICE: ThemeChoice = "puredark";
export type ThemeChoice = (typeof THEME_CHOICES)[number];
/** What the page actually paints — 'system' has already been decided. */
export type ResolvedTheme = Exclude<ThemeChoice, "system">;
export type ThemeListener = (theme: ResolvedTheme) => void;

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Persisted value → choice. Anything unrecognised falls back to [`DEFAULT_CHOICE`]
 * rather than to a guess, so a corrupt value is invisible.
 * Exported for unit tests.
 */
export function parseStoredChoice(raw: string | null): ThemeChoice {
  return (THEME_CHOICES as readonly string[]).includes(raw ?? "")
    ? (raw as ThemeChoice)
    : DEFAULT_CHOICE;
}

/** Exported for unit tests. */
export function resolveTheme(
  choice: ThemeChoice,
  prefersDark: boolean,
): ResolvedTheme {
  return choice === "system" ? (prefersDark ? "dark" : "light") : choice;
}

/**
 * The `data-theme` value for a choice. null means *remove* the attribute:
 * stamping a resolved 'system' would race the media query and pin whatever the
 * OS happened to be at boot.
 * Exported for unit tests.
 */
export function themeAttribute(choice: ThemeChoice): ResolvedTheme | null {
  return choice === "system" ? null : choice;
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(THEME_KEY);
  } catch {
    return null; /* storage disabled */
  }
}

function writeStored(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* storage disabled — the theme is a preference, not state we must keep */
  }
}

function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY)
    : null;
}

let choice: ThemeChoice = "system";
let started = false;
const listeners = new Set<ThemeListener>();

function stamp(): void {
  const attr = themeAttribute(choice);
  if (attr == null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", attr);
}

function notify(): void {
  const theme = getResolvedTheme();
  for (const listener of listeners) listener(theme);
}

export function getThemeChoice(): ThemeChoice {
  return choice;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(choice, darkQuery()?.matches ?? false);
}

export function setThemeChoice(next: ThemeChoice): void {
  if (next === choice) return;
  choice = next;
  writeStored(next);
  stamp();
  notify();
}

/** Subscribe to the *resolved* theme; returns the unsubscribe. */
export function onThemeChange(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Read the stored choice and stamp it. Call once, before the first render —
 * a stamp that lands after first paint flashes the OS theme instead.
 */
export function initTheme(): void {
  if (started) return;
  started = true;
  choice = parseStoredChoice(readStored());
  stamp();
  // CSS re-resolves 'system' on its own; subscribers still need telling.
  darkQuery()?.addEventListener("change", () => {
    if (choice === "system") notify();
  });
}
