import { useCallback, useEffect, useState } from "react";
import type { SessionCard } from "../types";

/** Fork-owned key — upstream stores nothing under this prefix (ADR-0003). */
const TITLES_KEY = "ztidalcode.sessions.titles";

/**
 * Decode the stored overrides: a JSON object of session id → non-empty name,
 * anything else meaning "nothing renamed". A corrupt entry costs the names and
 * nothing else — the sessions on disk never learn about any of this.
 */
export function parseStoredTitles(raw: string | null): Map<string, string> {
  if (!raw) return new Map();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map();
    }
    const out = new Map<string, string>();
    for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (id !== "" && typeof name === "string" && name.trim() !== "") {
        out.set(id, name.trim());
      }
    }
    return out;
  } catch {
    return new Map(); /* corrupt value — same as never having renamed anything */
  }
}

/** Key-sorted so an unchanged map never rewrites the entry with a new spelling. */
export function serializeTitles(titles: ReadonlyMap<string, string>): string {
  const out: Record<string, string> = {};
  for (const id of [...titles.keys()].sort()) out[id] = titles.get(id) as string;
  return JSON.stringify(out);
}

/**
 * Apply one rename, always a new map so React sees the change.
 *
 * Clearing the field is how you undo a rename, so blank input **removes** the
 * override rather than storing an empty name — a card with no title at all
 * would be unreachable, and there would be no way back to the agent's own.
 * A name equal to the original is stored as nothing for the same reason: the
 * override would then silently pin a title that the agent is still free to
 * change underneath it.
 */
export function setTitleOverride(
  titles: ReadonlyMap<string, string>,
  id: string,
  name: string,
  original: string,
): Map<string, string> {
  const next = new Map(titles);
  if (id === "") return next;
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === original.trim()) next.delete(id);
  else next.set(id, trimmed);
  return next;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; /* storage disabled */
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage disabled — a name is a preference, not state we must keep */
  }
}

export interface SessionTitlesApi {
  /** The card's name as the sidebar should show it: the override, else its own. */
  displayTitle: (card: SessionCard) => string;
  /** The agent's own title, when a rename is hiding it. Else null. */
  originalTitle: (card: SessionCard) => string | null;
  /** Store, replace, or (with a blank name) drop one override. */
  rename: (card: SessionCard, name: string) => void;
}

/**
 * User-chosen names for sessions in the sidebar.
 *
 * A rename is a **label over** the agent's title, never a write to it: the
 * session on disk is `grok`'s (ADR-0001), and the title it generates keeps
 * updating underneath whatever we show. Clearing the name brings it back.
 *
 * Per-machine, so localStorage rather than a Rust command — the same call the
 * pins made, and for the same reason: nothing about what one person calls a
 * card belongs in agent state. The store outlives updates (it sits in the
 * WebView2 profile, not in the install directory) but not a new machine, which
 * is the trade a label is worth and a session is not.
 *
 * Ids are never pruned against the loaded page: the sidebar pages, so a name
 * for a session that has not been fetched yet is still a live name.
 */
export function useSessionTitles(): SessionTitlesApi {
  const [titles, setTitles] = useState<Map<string, string>>(() =>
    parseStoredTitles(readStored(TITLES_KEY)),
  );

  useEffect(() => {
    writeStored(TITLES_KEY, serializeTitles(titles));
  }, [titles]);

  const displayTitle = useCallback(
    (card: SessionCard) => titles.get(card.id) ?? card.title,
    [titles],
  );

  const originalTitle = useCallback(
    (card: SessionCard) => (titles.has(card.id) ? card.title : null),
    [titles],
  );

  const rename = useCallback((card: SessionCard, name: string) => {
    setTitles((previous) =>
      setTitleOverride(previous, card.id, name, card.title),
    );
  }, []);

  return { displayTitle, originalTitle, rename };
}
