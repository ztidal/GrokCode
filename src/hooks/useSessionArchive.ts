import { useMemo } from "react";
import { useStoredIdSet } from "./useIdSet";

/** Fork-owned key — upstream stores nothing under this prefix (ADR-0003). */
const ARCHIVED_KEY = "ztidalcode.sessions.archived";

export interface SessionArchiveApi {
  /** The whole set, for the grouping walk. */
  archivedIds: ReadonlySet<string>;
  isArchived: (id: string) => boolean;
  toggleArchived: (id: string) => void;
}

/**
 * Sessions the sidebar should stop showing, without touching them.
 *
 * Archiving is the reversible half of the pair the card menu offers: it is a
 * note in this window's storage that a task is finished with, and nothing on
 * disk changes. Deleting is the other half — that one moves the session's
 * directory, and lives in Rust (`session_trash`) because it is `grok`'s data.
 *
 * Archived cards are not dropped from the sidebar, they are moved to an
 * `Archived` group at the bottom that starts collapsed. A card that vanishes
 * with no way back would make archiving as frightening as deleting, which is
 * exactly the distinction this pair exists to draw.
 *
 * Per-machine, in localStorage, for the same reason as the pins.
 */
export function useSessionArchive(): SessionArchiveApi {
  const { ids, has, toggle } = useStoredIdSet(ARCHIVED_KEY);
  return useMemo(
    () => ({ archivedIds: ids, isArchived: has, toggleArchived: toggle }),
    [ids, has, toggle],
  );
}
