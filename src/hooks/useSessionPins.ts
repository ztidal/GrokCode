import { useCallback, useEffect, useState } from "react";

/** Fork-owned key — upstream stores nothing under this prefix (ADR-0003). */
const PINNED_KEY = "ztidalcode.sessions.pinned";

/**
 * Decode the stored pin set: a JSON array of non-empty session ids, anything
 * else meaning "nothing pinned". A corrupt entry costs the pins and nothing
 * else — sessions on disk never learn about this.
 */
export function parseStoredPins(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((id): id is string => typeof id === "string" && id !== ""),
    );
  } catch {
    return new Set(); /* corrupt value — same as never having pinned anything */
  }
}

/** Sorted so an unchanged set never rewrites the entry with a new spelling. */
export function serializePins(ids: ReadonlySet<string>): string {
  return JSON.stringify([...ids].sort());
}

/** Add or drop one id, always a new set so React sees the change. */
export function togglePin(
  pinned: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(pinned);
  // An empty id cannot survive parseStoredPins, so never let one in.
  if (id === "") return next;
  if (!next.delete(id)) next.add(id);
  return next;
}

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
    /* storage disabled — a pin is a preference, not state we must keep */
  }
}

export interface SessionPinsApi {
  /** The whole set, for callers that sort or group by it. */
  pinnedIds: ReadonlySet<string>;
  isPinned: (id: string) => boolean;
  togglePinned: (id: string) => void;
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
 *
 * Ids are never pruned against the loaded page: the sidebar pages, so a pin on
 * a session that has not been fetched yet is still a live pin.
 */
export function useSessionPins(): SessionPinsApi {
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() =>
    parseStoredPins(readStored(PINNED_KEY)),
  );

  useEffect(() => {
    writeStored(PINNED_KEY, serializePins(pinnedIds));
  }, [pinnedIds]);

  const isPinned = useCallback((id: string) => pinnedIds.has(id), [pinnedIds]);

  const togglePinned = useCallback((id: string) => {
    setPinnedIds((previous) => togglePin(previous, id));
  }, []);

  return { pinnedIds, isPinned, togglePinned };
}
