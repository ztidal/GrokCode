import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listProjectGroups } from "../api";
import type { ProjectGroup, SessionCard } from "../types";
import { projectName } from "../utils/format";

/**
 * Fork-owned key — upstream stores nothing under this prefix (ADR-0003).
 *
 * Holds the **expanded** keys. Storing the open ones rather than the closed ones
 * is what makes "collapsed" the ground state: first run, a wiped entry and a
 * project the entry has never heard of all read the same way.
 */
const EMPTY_PINS: ReadonlySet<string> = new Set();

const EXPANDED_KEY = "ztidalcode.sessions.groups.expanded";

/** The pre-inversion entry, which listed collapsed keys. See `loadExpanded`. */
const LEGACY_COLLAPSED_KEY = "ztidalcode.sessions.groups.collapsed";

/** Nothing to group. A module constant so the walk below sees a stable value. */
export const NO_SESSIONS: SessionCard[] = [];

/** One project header plus the cards from the loaded page that belong to it. */
export interface SessionGroup {
  /** `ProjectGroup.key`, or the card's own normalized cwd when unindexed. */
  key: string;
  /** Folder name, widened by the index when two projects share a basename. */
  label: string;
  /** Full cwd, for the header tooltip. */
  path: string;
  /** Cards the sidebar has actually loaded, in the order it sorted them. */
  sessions: SessionCard[];
  /** Sessions across the whole index — larger than `sessions.length` while paging. */
  totalCount: number;
  /** The project folder itself is gone; its sessions remain readable history. */
  missing: boolean;
  /** Sort value, epoch ms. */
  activityMs: number;
}

/**
 * Mirror of Rust `project_groups::normalize_path_key`, minus its case fold:
 * strip the Windows verbatim prefix, unify separators, drop trailing ones.
 */
export function normalizeGroupKey(cwd: string): string {
  const trimmed = cwd.trim();
  const stripped = trimmed.startsWith("\\\\?\\") ? trimmed.slice(4) : trimmed;
  return stripped.split("/").join("\\").replace(/\\+$/, "");
}

/**
 * The distinct projects the loaded page holds. Only a change here can make an
 * already-fetched index look wrong on screen, so this — not the card list — is
 * what re-triggers the walk: the index costs one read per session on disk.
 */
export function loadedProjectSignature(sessions: SessionCard[]): string {
  const keys = new Set(sessions.map((card) => normalizeGroupKey(card.cwd)));
  return [...keys].sort().join("\n");
}

function cardActivityMs(card: SessionCard): number {
  const parsed = Date.parse(card.lastActiveAt ?? card.updatedAt ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Every spelling a card's cwd might arrive in, mapped to its group.
 *
 * The Rust key is case-folded only on Windows and the frontend cannot ask which
 * target compiled it, so a lookup tries the exact path first and the folded one
 * second rather than guessing whether the host filesystem is case-sensitive.
 * First writer wins, so two case-variant projects on a case-sensitive host keep
 * their own exact-case entries.
 */
function indexGroups(groups: ProjectGroup[]): Map<string, ProjectGroup> {
  const index = new Map<string, ProjectGroup>();
  for (const group of groups) {
    const normalized = normalizeGroupKey(group.path);
    for (const alias of [normalized, group.key, normalized.toLowerCase()]) {
      if (!index.has(alias)) index.set(alias, group);
    }
  }
  return index;
}

/**
 * Fold the loaded cards under their project headers, most recently active first.
 *
 * Cards keep the order they arrive in, so whatever the caller sorted by survives
 * inside each group. A card whose project the index does not know still gets a
 * header built from its own cwd — a card vanishing from the sidebar because two
 * scans disagreed would be worse than a header with an approximate count.
 *
 * `pinnedIds` lifts the projects that hold a pin above the rest. Groups default
 * to collapsed, so a pin buried under the eighth header would be a pin the user
 * cannot see — sorting the header up is what makes the pin reachable.
 */
/**
 * Keys of the groups holding at least one pinned session.
 *
 * Pinning is how someone says "I need to find this again"; with groups collapsed
 * by default, a pin that stays behind a closed header has not answered that.
 */
export function groupsHoldingPins(
  groups: readonly SessionGroup[],
  pinnedIds: ReadonlySet<string>,
): string[] {
  if (pinnedIds.size === 0) return [];
  return groups
    .filter((group) => group.sessions.some((s) => pinnedIds.has(s.id)))
    .map((group) => group.key);
}

export function groupLoadedSessions(
  sessions: SessionCard[],
  groups: ProjectGroup[],
  pinnedIds: ReadonlySet<string> = new Set(),
): SessionGroup[] {
  const index = indexGroups(groups);
  const buckets = new Map<string, SessionGroup>();

  for (const card of sessions) {
    const normalized = normalizeGroupKey(card.cwd);
    const indexed =
      index.get(normalized) ?? index.get(normalized.toLowerCase());
    const key = indexed?.key ?? normalized;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        label: indexed?.label ?? projectName(card.cwd),
        path: indexed?.path ?? card.cwd,
        sessions: [],
        totalCount: indexed?.sessionCount ?? 0,
        // Only the index knows whether a folder is still there; assume it is.
        missing: indexed ? !indexed.exists : false,
        activityMs: indexed?.lastActivityMs ?? 0,
      };
      buckets.set(key, bucket);
    }
    bucket.sessions.push(card);
    if (!indexed) {
      // No index row to sort by, so the newest card on the page stands in.
      bucket.activityMs = Math.max(bucket.activityMs, cardActivityMs(card));
    }
  }

  for (const bucket of buckets.values()) {
    // A group the index has not caught up with still owes an honest count.
    bucket.totalCount = Math.max(bucket.totalCount, bucket.sessions.length);
  }

  const holdsPin = new Map<string, boolean>();
  for (const bucket of buckets.values()) {
    holdsPin.set(
      bucket.key,
      bucket.sessions.some((session) => pinnedIds.has(session.id)),
    );
  }
  const pinRank = (group: SessionGroup) => (holdsPin.get(group.key) ? 0 : 1);

  return [...buckets.values()].sort(
    (a, b) =>
      pinRank(a) - pinRank(b) ||
      b.activityMs - a.activityMs ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/**
 * Header badge. The index total always shows; the loaded share is prefixed while
 * paging has not caught up, so "7" over three cards does not read as a bug.
 */
export function groupCountLabel(group: SessionGroup): string {
  return group.sessions.length < group.totalCount
    ? `${group.sessions.length}/${group.totalCount}`
    : String(group.totalCount);
}

export function groupCountTitle(group: SessionGroup): string {
  if (group.sessions.length < group.totalCount) {
    return `${group.sessions.length} of ${group.totalCount} sessions loaded`;
  }
  return `${group.totalCount} session${group.totalCount === 1 ? "" : "s"}`;
}

/**
 * Decode a stored key set: a JSON array of non-empty keys, anything else meaning
 * "no keys". Named for the collapsed entry it was written for; the payload shape
 * did not change when the entry started listing expanded keys instead. Exported
 * for unit tests.
 */
export function parseStoredCollapsed(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((key): key is string => typeof key === "string" && key !== ""),
    );
  } catch {
    return new Set(); /* corrupt value — same as never having collapsed anything */
  }
}

/** Sorted so an unchanged set never rewrites the entry with a new spelling. */
export function serializeCollapsed(keys: Set<string>): string {
  return JSON.stringify([...keys].sort());
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
    /* storage disabled — collapse is a preference, not state we must keep */
  }
}

function removeStored(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* storage disabled — nothing to clean up */
  }
}

/**
 * The expanded set at mount, migrating a pre-inversion install on the way.
 *
 * The old entry named the *collapsed* projects; "expanded" was everything it did
 * not name — a set that cannot be enumerated here, and that we would not want
 * anyway: a user who had never collapsed anything would translate to every
 * project open, which is exactly the state this inversion removes. So the old
 * entry is dropped rather than translated and everyone starts collapsed once.
 * The one thing that survives the migration is the open task, which the hook
 * re-expands from `selectedId` below.
 */
function loadExpanded(): Set<string> {
  const stored = readStored(EXPANDED_KEY);
  if (stored !== null) return parseStoredCollapsed(stored);
  removeStored(LEGACY_COLLAPSED_KEY);
  return new Set();
}

export interface ProjectGroupsOptions {
  /**
   * The open task. Its project is expanded once per selection, so launching into
   * an all-collapsed sidebar still shows the user where they were. Expanded once
   * — not forced — so the group can still be collapsed afterwards.
   */
  selectedId?: string | null;
  /** Sorts the projects holding a pin above the rest. */
  pinnedIds?: ReadonlySet<string>;
}

export interface ProjectGroupsApi {
  /** Loaded cards under their project header, most recently active first. */
  groups: SessionGroup[];
  /**
   * False until a walk returns at least one group. Callers keep their flat list
   * until then, so a backend without the index degrades to today's behaviour.
   */
  indexed: boolean;
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
}

/**
 * Rolls the sidebar's loaded cards up by project, against the Rust project-group
 * index. Pass an empty list to switch grouping off (search results are flat).
 */
export function useProjectGroups(
  sessions: SessionCard[],
  options: ProjectGroupsOptions = {},
): ProjectGroupsApi {
  const { selectedId = null, pinnedIds } = options;
  const [index, setIndex] = useState<ProjectGroup[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);

  const signature = useMemo(() => loadedProjectSignature(sessions), [sessions]);

  useEffect(() => {
    if (!signature) return;
    let cancelled = false;
    void listProjectGroups()
      .then((groups) => {
        if (!cancelled) setIndex(groups);
      })
      .catch(() => {
        // No index: the caller keeps its flat list rather than inventing groups.
      });
    return () => {
      cancelled = true;
    };
  }, [signature]);

  useEffect(() => {
    writeStored(EXPANDED_KEY, serializeCollapsed(expanded));
  }, [expanded]);

  const isCollapsed = useCallback(
    (key: string) => !expanded.has(key),
    [expanded],
  );

  const toggleCollapsed = useCallback((key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const groups = useMemo(
    () => groupLoadedSessions(sessions, index, pinnedIds),
    [sessions, index, pinnedIds],
  );

  /**
   * Reveal the open task's project, once per selection. Keyed on the id rather
   * than on `groups` so a later collapse of that same group sticks — the reveal
   * only fires again when the selection moves somewhere else.
   */
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId) return;
    const holder = groups.find((group) =>
      group.sessions.some((session) => session.id === selectedId),
    );
    // The card may not be on the loaded page yet; try again when it is.
    if (!holder || revealedFor.current === selectedId) return;
    revealedFor.current = selectedId;
    setExpanded((previous) =>
      previous.has(holder.key) ? previous : new Set(previous).add(holder.key),
    );
  }, [selectedId, groups]);

  /**
   * Reveal the projects holding a pin, once per pin set. Same one-shot shape as
   * the selection reveal above: collapsing such a group afterwards sticks, and
   * it opens again only when the pins themselves change — or on the next launch,
   * which is the case that matters, since every group starts collapsed.
   */
  const revealedPins = useRef<string | null>(null);
  useEffect(() => {
    const pins = pinnedIds ?? EMPTY_PINS;
    const holders = groupsHoldingPins(groups, pins);
    // Nothing loaded yet: the pinned card may not be on this page. Try again.
    if (holders.length === 0) return;
    const signature = JSON.stringify([...pins].sort());
    if (revealedPins.current === signature) return;
    revealedPins.current = signature;
    setExpanded((previous) => {
      const next = new Set(previous);
      const before = next.size;
      for (const key of holders) next.add(key);
      return next.size === before ? previous : next;
    });
  }, [pinnedIds, groups]);

  return { groups, indexed: index.length > 0, isCollapsed, toggleCollapsed };
}
