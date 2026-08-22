import { useCallback, useEffect, useRef, useState } from "react";
import { listSessionFlags, mergeSessionFlags, setSessionFlag } from "../api";
import type { SessionFlag, SessionFlagsState } from "../api";

/**
 * A persisted set of session ids.
 *
 * Pins and the archive are the same shape — a flat set of ids — and differ
 * only in what the sidebar does with membership. This holds the part that is
 * the same, so the two cannot drift on how a load, a toggle, or the one-time
 * migration is spelled.
 *
 * The sets live host-side (`~/.ztidalcode/session_flags.json`), moved out of
 * localStorage the way the titles were and for the same reason: that store is
 * a write-behind cache, so a killed window loses its last batched writes, and
 * each window holds the whole set and overwrites the others' — a real path
 * here, where "open in new window" is a first-class feature. "Per-machine
 * preference", the old justification, answered cross-machine sync, which was
 * never the risk.
 *
 * Ids are never pruned against the loaded page: the sidebar pages, so an id
 * for a session that has not been fetched yet is still a live id.
 */

/**
 * Decode a stored set: a JSON array of non-empty ids, anything else meaning
 * "empty". A corrupt entry costs the preference and nothing else — the
 * sessions on disk never learn about any of this. Reads the legacy
 * localStorage entries now, but keeps its shape from when it read the live
 * ones.
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

/** Sorted, so one set has exactly one spelling. */
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

function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* storage disabled — then there is nothing to migrate either */
  }
}

/**
 * Fork-owned keys (ADR-0003) the two sets lived under before they moved
 * host-side. Read only by the migration; nothing writes them any more.
 */
const LEGACY_KEYS = {
  pinned: "ztidalcode.sessions.pinned",
  archived: "ztidalcode.sessions.archived",
} as const;

/**
 * What a pre-upgrade localStorage still holds, ready for one merge call —
 * `null` when there is nothing worth carrying over. Both stores in one answer
 * so both migrate in one command. Exported for unit tests.
 */
export function legacyCarryOver(
  rawPinned: string | null,
  rawArchived: string | null,
): { pinned: string[]; archived: string[] } | null {
  const pinned = parseIdSet(rawPinned);
  const archived = parseIdSet(rawArchived);
  if (pinned.size === 0 && archived.size === 0) return null;
  return { pinned: [...pinned].sort(), archived: [...archived].sort() };
}

let migrated: Promise<void> | null = null;

/**
 * Fold what localStorage held into the host's store — once per window at most,
 * and once ever in practice, because the keys are removed on success. The host
 * applies the merge as a union under its lock, so two windows migrating the
 * same profile at the same time cannot lose each other's half.
 */
function migrateOnce(): Promise<void> {
  migrated ??= (async () => {
    const carry = legacyCarryOver(
      readStored(LEGACY_KEYS.pinned),
      readStored(LEGACY_KEYS.archived),
    );
    if (carry) await mergeSessionFlags(carry.pinned, carry.archived);
    // Removal only past the merge: a failed one must leave the keys for the
    // next launch to retry. Empty leftovers encode nothing and go either way.
    removeStored(LEGACY_KEYS.pinned);
    removeStored(LEGACY_KEYS.archived);
  })();
  return migrated;
}

async function loadFlags(): Promise<SessionFlagsState> {
  // Migration first, so the first paint after an upgrade already includes
  // what this window's localStorage held. A migration failure is not a load
  // failure: the host's current state is still worth showing, and the legacy
  // keys stay put for the next launch.
  await migrateOnce().catch(() => {});
  return listSessionFlags();
}

/** The set with `id`'s membership as told, always a new set. */
function withMembership(
  ids: ReadonlySet<string>,
  id: string,
  member: boolean,
): Set<string> {
  const next = new Set(ids);
  if (member) next.add(id);
  else next.delete(id);
  return next;
}

export interface IdSetApi {
  /** The whole set, for callers that sort or group by it. */
  ids: ReadonlySet<string>;
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Drop an id whatever its current state, for callers that mean "not this". */
  remove: (id: string) => void;
}

/** The set stored under `flag`, mirrored from the host's store. */
export function useStoredIdSet(flag: SessionFlag): IdSetApi {
  // Empty until the host answers, so a flagged card can paint unflagged for
  // the moment the first list takes. Accepted: the alternative is holding the
  // whole sidebar's first paint on a preference read.
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    void loadFlags()
      .then((state) => {
        if (!cancelled) setIds(new Set(state[flag]));
      })
      .catch(() => {
        // Empty is the honest fallback; a preference read is not worth an
        // error surface of its own.
      });
    return () => {
      cancelled = true;
    };
  }, [flag]);

  const has = useCallback((id: string) => ids.has(id), [ids]);

  /**
   * Optimistic write-through: paint now, reconcile with the host's answer.
   *
   * Every answer is the whole store, so only the newest in-flight request may
   * reconcile: two quick toggles answer in either order, and the older answer
   * would erase the newer toggle until the next load. Failure re-reads rather
   * than inverting, because inversion composes wrongly when the same id was
   * toggled again while the failed request was in flight.
   */
  const requestSeq = useRef(0);
  const apply = useCallback(
    (id: string, value: boolean) => {
      const seq = ++requestSeq.current;
      setIds((previous) => withMembership(previous, id, value));
      void setSessionFlag(id, flag, value)
        .then((state) => {
          if (seq === requestSeq.current) setIds(new Set(state[flag]));
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          void loadFlags()
            .then((state) => {
              if (seq === requestSeq.current) setIds(new Set(state[flag]));
            })
            .catch(() => {
              // Host unreachable for the read too; inverting is the honest
              // remainder.
              setIds((current) => withMembership(current, id, !value));
            });
        });
    },
    [flag],
  );

  const toggle = useCallback(
    (id: string) => {
      // The host refuses an empty id; painting it first would only flash.
      if (id === "") return;
      apply(id, !ids.has(id));
    },
    [ids, apply],
  );

  const remove = useCallback(
    (id: string) => {
      // Unconditional: before the first load the mirror is empty, and a
      // delete's cleanup must still clear a flag the host may be holding.
      if (id !== "") apply(id, false);
    },
    [apply],
  );

  return { ids, has, toggle, remove };
}
