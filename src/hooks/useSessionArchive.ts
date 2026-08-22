import { useMemo } from "react";
import { useStoredIdSet } from "./useIdSet";

export interface SessionArchiveApi {
  /** The whole set, for the grouping walk. */
  archivedIds: ReadonlySet<string>;
  isArchived: (id: string) => boolean;
  toggleArchived: (id: string) => void;
  /** Deletion cleanup: clears the flag whether or not this window has loaded it. */
  unarchive: (id: string) => void;
}

/**
 * Sessions the sidebar should stop showing, without touching them.
 *
 * Archiving is the reversible half of the pair the card menu offers: it is a
 * note in the fork's own store that a task is finished with, and the session
 * itself is untouched. Deleting is the other half — that one moves the
 * session's directory (`session_trash`) because it is `grok`'s data.
 *
 * Archived cards are not dropped from the sidebar, they are moved to an
 * `Archived` group at the bottom that starts collapsed. A card that vanishes
 * with no way back would make archiving as frightening as deleting, which is
 * exactly the distinction this pair exists to draw.
 *
 * Host-side, in the pins' document (`~/.ztidalcode/session_flags.json`), and
 * for the same reasons as the pins — see `useSessionPins`.
 */
export function useSessionArchive(): SessionArchiveApi {
  const { ids, has, toggle, remove } = useStoredIdSet("archived");
  return useMemo(
    () => ({
      archivedIds: ids,
      isArchived: has,
      toggleArchived: toggle,
      unarchive: remove,
    }),
    [ids, has, toggle, remove],
  );
}
