import { useCallback, useEffect, useMemo, useState } from "react";
import { listProjectGroups } from "../api";
import type { ProjectGroup, SessionCard } from "../types";
import { projectName } from "../utils/format";

/** Fork-owned key — upstream stores nothing under this prefix (ADR-0003). */
const COLLAPSED_KEY = "ztidalcode.sessions.groups.collapsed";

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
 */
export function groupLoadedSessions(
  sessions: SessionCard[],
  groups: ProjectGroup[],
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

  return [...buckets.values()].sort(
    (a, b) => b.activityMs - a.activityMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
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
 * Only collapsed keys are stored, so first run and a wiped entry both mean
 * "everything open" and the entry stays small. Exported for unit tests.
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
export function useProjectGroups(sessions: SessionCard[]): ProjectGroupsApi {
  const [index, setIndex] = useState<ProjectGroup[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    parseStoredCollapsed(readStored(COLLAPSED_KEY)),
  );

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
    writeStored(COLLAPSED_KEY, serializeCollapsed(collapsed));
  }, [collapsed]);

  const isCollapsed = useCallback(
    (key: string) => collapsed.has(key),
    [collapsed],
  );

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const groups = useMemo(
    () => groupLoadedSessions(sessions, index),
    [sessions, index],
  );

  return { groups, indexed: index.length > 0, isCollapsed, toggleCollapsed };
}
