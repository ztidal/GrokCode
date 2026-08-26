import { useMemo } from "react";
import {
  parseIdSet,
  serializeIdSet,
  toggleId,
  useStoredIdSet,
} from "./useIdSet";

/**
 * The stored-set primitives, re-exported under the names this module has always
 * used. Pins and the archive keep one implementation between them; only what
 * the sidebar does with membership differs.
 */
export {
  parseIdSet as parseStoredPins,
  serializeIdSet as serializePins,
  toggleId as togglePin,
};

/**
 * Pinned items first, in the pin-set's own order (pin time: first pinned
 * stays first). `compare` ranks only the unpinned half — a pin is the user's
 * ordering, and must not reshuffle when a card goes idle.
 */
export function sortPinnedFirst<T extends { id: string }>(
  items: readonly T[],
  pinned: ReadonlySet<string>,
  compare?: (a: T, b: T) => number,
): T[] {
  const pinRank = new Map([...pinned].map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ar = pinRank.get(a.id);
    const br = pinRank.get(b.id);
    if (ar !== undefined && br !== undefined) return ar - br;
    if (ar !== undefined) return -1;
    if (br !== undefined) return 1;
    return compare ? compare(a, b) : 0;
  });
}

export interface SessionPinsApi {
  /** The whole set, for callers that sort or group by it. */
  pinnedIds: ReadonlySet<string>;
  isPinned: (id: string) => boolean;
  togglePinned: (id: string) => void;
  /** Unpin whatever its state, for callers that are moving a card elsewhere. */
  unpin: (id: string) => void;
}

/**
 * Session pins for the sidebar.
 *
 * Pins are **global**: one flat set of session ids, not a set per project. A
 * session is pinned or it is not, so the same answer serves the flat search
 * list and the project groups, and a card cannot be pinned in one view while
 * looking unpinned in another.
 *
 * The set lives host-side (`~/.ztidalcode/session_flags.json`), in the
 * document it shares with the archive. It started in localStorage as a
 * "per-machine preference", but that argument answered cross-machine sync,
 * not same-machine durability: localStorage batches its writes, so a killed
 * window lost its last few pins, and two windows — first-class here — each
 * held the whole set and overwrote each other. Still nothing of the agent's
 * (ADR-0001): a pin is our note about `grok`'s session, never a write to it.
 */
export function useSessionPins(): SessionPinsApi {
  const { ids, has, toggle, remove } = useStoredIdSet("pinned");
  return useMemo(
    () => ({
      pinnedIds: ids,
      isPinned: has,
      togglePinned: toggle,
      unpin: remove,
    }),
    [ids, has, toggle, remove],
  );
}
