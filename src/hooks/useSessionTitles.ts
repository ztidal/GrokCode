import { useCallback, useEffect, useState } from "react";
import { listSessionTitles, setSessionTitle } from "../api";
import type { SessionCard } from "../types";

/**
 * What a typed name resolves to: the name itself, or `null` for "no override".
 *
 * Blank is how the field says "give me the agent's title back", so it clears
 * rather than storing an empty name — a card with no title at all would be
 * unreachable. A name equal to the agent's clears for a different reason: the
 * override would otherwise pin a title the agent is still free to change
 * underneath it, and nothing would look wrong until it did.
 *
 * Exported for unit tests.
 */
export function resolveOverride(name: string, original: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === original.trim()) return null;
  return trimmed;
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
 * The names live host-side (`~/.ztidalcode/session_titles.json`), unlike the
 * pins beside them. A pin is a preference — cheap to lose, cheaper to redo — so
 * localStorage is the right size for it. A name is something someone typed, and
 * localStorage is a cache: it batches to disk, so a window that is killed
 * rather than closed loses the last few writes, and two windows each hold the
 * whole map and overwrite each other. Both were happening.
 *
 * State here is a mirror, updated optimistically so the card repaints on the
 * keystroke, then replaced by the host's answer — which is the whole map, so a
 * rename made in another window arrives with the next one made here.
 */
export function useSessionTitles(): SessionTitlesApi {
  const [titles, setTitles] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    void listSessionTitles()
      .then((map) => {
        if (!cancelled) setTitles(new Map(Object.entries(map)));
      })
      .catch(() => {
        // No names is the honest fallback: every card keeps the agent's title.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const displayTitle = useCallback(
    (card: SessionCard) => titles.get(card.id) ?? card.title,
    [titles],
  );

  const originalTitle = useCallback(
    (card: SessionCard) => (titles.has(card.id) ? card.title : null),
    [titles],
  );

  const rename = useCallback((card: SessionCard, name: string) => {
    const next = resolveOverride(name, card.title);
    setTitles((previous) => {
      const optimistic = new Map(previous);
      if (next === null) optimistic.delete(card.id);
      else optimistic.set(card.id, next);
      return optimistic;
    });
    void setSessionTitle(card.id, next)
      .then((map) => setTitles(new Map(Object.entries(map))))
      .catch(() => {
        // The write failed; the host is the authority, so take its word back.
        void listSessionTitles()
          .then((map) => setTitles(new Map(Object.entries(map))))
          .catch(() => {});
      });
  }, []);

  return { displayTitle, originalTitle, rename };
}
