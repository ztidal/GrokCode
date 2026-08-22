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
 * Pinned items first, the rest in `compare` order.
 *
 * `Array.prototype.sort` is stable, so anything `compare` calls equal keeps the
 * order it arrived in — the caller's paging order survives inside each half.
 */
export function sortPinnedFirst<T extends { id: string }>(
  items: readonly T[],
  pinned: ReadonlySet<string>,
  compare?: (a: T, b: T) => number,
): T[] {
  return [...items].sort((a, b) => {
    const ap = pinned.has(a.id) ? 0 : 1;
    const bp = pinned.has(b.id) ? 0 : 1;
    return ap - bp || (compare ? compare(a, b) : 0);
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
