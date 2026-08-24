import { emit } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import type { ManagedAgentInfo, PendingPermission, TimelineItem } from "../types";
import { resolvePetActivity } from "./petActivity";
import { PET_ACTIVITY_EVENT, type PetActivity } from "./types";

function sameActivity(a: PetActivity | null, b: PetActivity): boolean {
  return (
    a != null &&
    a.motion === b.motion &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.title === b.title
  );
}

/**
 * Push the focused task's Codex-pet motion to the overlay window.
 * The overlay is a second webview; this is the only seam that feeds it.
 */
export function usePetActivityBridge(opts: {
  managed: ManagedAgentInfo | null;
  timelineItems: TimelineItem[];
  sessionIsActive: boolean;
  sessionTitle: string | null;
  pendingPermissions: PendingPermission[];
}) {
  const last = useRef<PetActivity | null>(null);
  const { managed, timelineItems, sessionIsActive, sessionTitle, pendingPermissions } =
    opts;

  useEffect(() => {
    const activity = resolvePetActivity(managed, timelineItems, {
      sessionIsActive,
      sessionTitle,
      pendingPermissions,
    });
    if (sameActivity(last.current, activity)) return;
    last.current = activity;
    void emit(PET_ACTIVITY_EVENT, activity).catch(() => {
      /* vite preview / tests: no tauri event bus */
    });
  }, [managed, timelineItems, sessionIsActive, sessionTitle, pendingPermissions]);
}
