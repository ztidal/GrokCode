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
const EXPANDED_KEY = "ztidalcode.sessions.groups.expanded";

/**
 * Key of the synthetic group that holds every pinned card, above the projects.
 *
 * Led by NUL, written as an escape so it is visible in review: no filesystem on
 * any host allows that byte in a path, so no project can ever produce this key
 * and collide with the group. The collapse state is keyed by this string too,
 * and a project that could claim it would inherit the pinned group's.
 */
export const PINNED_GROUP_KEY = "\u0000pinned";

/**
 * Key of the synthetic group holding archived cards, below the projects. Same
 * NUL-led spelling and the same reason as [`PINNED_GROUP_KEY`], but this one is
 * an ordinary collapsible group, so it does keep a collapse state under its key.
 */
export const ARCHIVED_GROUP_KEY = "\u0000archived";

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
  /** Cards to render under this header, in the order the caller sorted them. */
  sessions: SessionCard[];
  /**
   * Cards the page holds for this project, including any the pinned group took.
   * `sessions.length` is what renders; this is what the header may honestly
   * claim to have loaded.
   */
  loadedCount: number;
  /** Sessions across the whole index — larger than `loadedCount` while paging. */
  totalCount: number;
  /** The project folder itself is gone; its sessions remain readable history. */
  missing: boolean;
  /** Sort value, epoch ms. */
  activityMs: number;
  /**
   * A built group rather than a project. Neither has a folder, so neither can
   * be started in or reported missing; `pinned` additionally cannot be
   * collapsed, because a pin behind a closed header defeats itself.
   */
  special?: "pinned" | "archived";
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
 * Fold the loaded cards under their headers: the pinned group, then the projects
 * most recently active first.
 *
 * Cards keep the order they arrive in, so whatever the caller sorted by survives
 * inside each group. A card whose project the index does not know still gets a
 * header built from its own cwd — a card vanishing from the sidebar because two
 * scans disagreed would be worse than a header with an approximate count.
 *
 * A pinned or archived card is **moved**, not copied: it renders once, under its
 * own header, and its project stops listing it. Pinning is how someone says "I
 * need to find this again", and with projects collapsed by default the only
 * answer that always holds is a card that is not behind a project header at all;
 * archiving is the opposite errand and gets the same treatment at the bottom.
 * Either way the project still counts the card as loaded, so its badge does not
 * read as paging that never finishes.
 *
 * Archived wins over pinned for a card that is somehow both: someone who has
 * archived a task has said they are done with it, which is the later word.
 */
export function groupLoadedSessions(
  sessions: SessionCard[],
  groups: ProjectGroup[],
  pinnedIds: ReadonlySet<string> = new Set(),
  archivedIds: ReadonlySet<string> = new Set(),
): SessionGroup[] {
  const index = indexGroups(groups);
  const buckets = new Map<string, SessionGroup>();
  const pinnedCards: SessionCard[] = [];
  const archivedCards: SessionCard[] = [];

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
        loadedCount: 0,
        totalCount: indexed?.sessionCount ?? 0,
        // Only the index knows whether a folder is still there; assume it is.
        missing: indexed ? !indexed.exists : false,
        activityMs: indexed?.lastActivityMs ?? 0,
      };
      buckets.set(key, bucket);
    }
    bucket.loadedCount += 1;
    if (archivedIds.has(card.id)) archivedCards.push(card);
    else if (pinnedIds.has(card.id)) pinnedCards.push(card);
    else bucket.sessions.push(card);
    if (!indexed) {
      // No index row to sort by, so the newest card on the page stands in.
      bucket.activityMs = Math.max(bucket.activityMs, cardActivityMs(card));
    }
  }

  for (const bucket of buckets.values()) {
    // A group the index has not caught up with still owes an honest count.
    bucket.totalCount = Math.max(bucket.totalCount, bucket.loadedCount);
  }

  const projects = [...buckets.values()]
    // A project whose every loaded card was taken has nothing left to show, and
    // an empty header is worse than no header — its cards are one group away.
    .filter((group) => group.sessions.length > 0)
    .sort(
      (a, b) =>
        b.activityMs - a.activityMs ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );

  /** A header that is built rather than indexed: no folder, no count to page. */
  const built = (
    key: string,
    label: string,
    cards: SessionCard[],
    special: "pinned" | "archived",
    activityMs: number,
  ): SessionGroup => ({
    key,
    label,
    path: "",
    sessions: cards,
    loadedCount: cards.length,
    totalCount: cards.length,
    missing: false,
    activityMs,
    special,
  });

  return [
    // Infinity and -Infinity rather than a sort key: these two are not competing
    // with the projects on recency, they bracket them.
    ...(pinnedCards.length
      ? [
          built(
            PINNED_GROUP_KEY,
            "Pinned",
            pinnedCards,
            "pinned",
            Number.POSITIVE_INFINITY,
          ),
        ]
      : []),
    ...projects,
    ...(archivedCards.length
      ? [
          built(
            ARCHIVED_GROUP_KEY,
            "Archived",
            archivedCards,
            "archived",
            Number.NEGATIVE_INFINITY,
          ),
        ]
      : []),
  ];
}

/**
 * Header badge. The index total always shows; the loaded share is prefixed while
 * paging has not caught up, so "7" over three cards does not read as a bug.
 */
export function groupCountLabel(group: SessionGroup): string {
  return group.loadedCount < group.totalCount
    ? `${group.loadedCount}/${group.totalCount}`
    : String(group.totalCount);
}

export function groupCountTitle(group: SessionGroup): string {
  if (group.loadedCount < group.totalCount) {
    return `${group.loadedCount} of ${group.totalCount} sessions loaded`;
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
  /** Cards to lift out of their projects and into the `Pinned` group on top. */
  pinnedIds?: ReadonlySet<string>;
  /** Cards to move out of their projects and into `Archived` at the bottom. */
  archivedIds?: ReadonlySet<string>;
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
  const { selectedId = null, pinnedIds, archivedIds } = options;
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

  // A pin behind a closed header defeats its own purpose, so the pinned group is
  // never collapsed. Archived is the opposite errand and behaves like a project:
  // collapsed until asked for, which is what the stored set already does.
  const isCollapsed = useCallback(
    (key: string) => key !== PINNED_GROUP_KEY && !expanded.has(key),
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
    () => groupLoadedSessions(sessions, index, pinnedIds, archivedIds),
    [sessions, index, pinnedIds, archivedIds],
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

  return { groups, indexed: index.length > 0, isCollapsed, toggleCollapsed };
}
