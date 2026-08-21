import { useMemo } from "react";
import {
  parseIdSet,
  serializeIdSet,
  toggleId,
  useStoredIdSet,
} from "./useIdSet";

/** Fork-owned key — upstream stores nothing under this prefix (ADR-0003). */
const PINNED_KEY = "ztidalcode.sessions.pinned";

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
 * Per-machine UI preference, so localStorage rather than a Rust command —
 * nothing about a pin belongs in agent state (ADR-0001: no new subsystem for
 * something a key/value entry already holds).
 */
export function useSessionPins(): SessionPinsApi {
  const { ids, has, toggle, remove } = useStoredIdSet(PINNED_KEY);
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
