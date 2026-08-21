import { useCallback, useEffect, useState } from "react";

/**
 * A persisted set of session ids.
 *
 * Pins and the archive are the same shape — a flat set of ids, per machine,
 * stored under a fork-owned key (ADR-0003) — and differ only in what the
 * sidebar does with membership. This holds the part that is the same, so the
 * two cannot drift on how a corrupt entry is read or how a write is spelled.
 *
 * Ids are never pruned against the loaded page: the sidebar pages, so an id for
 * a session that has not been fetched yet is still a live id.
 */

/**
 * Decode a stored set: a JSON array of non-empty ids, anything else meaning
 * "empty". A corrupt entry costs the preference and nothing else — the sessions
 * on disk never learn about any of this.
 */
export function parseIdSet(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((id): id is string => typeof id === "string" && id !== ""),
    );
  } catch {
    return new Set(); /* corrupt value — same as an empty set */
  }
}

/** Sorted so an unchanged set never rewrites the entry with a new spelling. */
export function serializeIdSet(ids: ReadonlySet<string>): string {
  return JSON.stringify([...ids].sort());
}

/** Add or drop one id, always a new set so React sees the change. */
export function toggleId(ids: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(ids);
  // An empty id cannot survive parseIdSet, so never let one in.
  if (id === "") return next;
  if (!next.delete(id)) next.add(id);
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
    /* storage disabled — these are preferences, not state we must keep */
  }
}

export interface IdSetApi {
  /** The whole set, for callers that sort or group by it. */
  ids: ReadonlySet<string>;
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Drop an id whatever its current state, for callers that mean "not this". */
  remove: (id: string) => void;
}

/** The set stored under `key`, kept in localStorage as it changes. */
export function useStoredIdSet(key: string): IdSetApi {
  const [ids, setIds] = useState<Set<string>>(() =>
    parseIdSet(readStored(key)),
  );

  useEffect(() => {
    writeStored(key, serializeIdSet(ids));
  }, [key, ids]);

  const has = useCallback((id: string) => ids.has(id), [ids]);

  const toggle = useCallback((id: string) => {
    setIds((previous) => toggleId(previous, id));
  }, []);

  const remove = useCallback((id: string) => {
    setIds((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }, []);

  return { ids, has, toggle, remove };
}
