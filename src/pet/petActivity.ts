import type { ManagedAgentInfo, PendingPermission, TimelineItem } from "../types";
import {
  resolveTurnActivity,
  type ResolvedTurnActivity,
} from "../utils/turnActivity";
import type { PetActivity, PetMotion } from "./types";

function lastTerminal(items: TimelineItem[]): "failed" | "completed" | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || item.kind !== "event") continue;
    const title = (item.title || "").toLowerCase();
    if (title.startsWith("turn failed") || title.startsWith("rate limited")) {
      return "failed";
    }
    if (title.startsWith("turn cancelled")) {
      return null;
    }
    if (title.startsWith("turn completed") || title.startsWith("worked for")) {
      return "completed";
    }
  }
  return null;
}

function isOpenPlanApproval(pending: PendingPermission[] | undefined): boolean {
  return Boolean(pending?.some((item) => item.kind === "planApproval"));
}

function isBlockedOnUser(
  activity: ResolvedTurnActivity | null,
  managed: ManagedAgentInfo | null | undefined,
  pending: PendingPermission[] | undefined,
): boolean {
  if (pending && pending.length > 0) return true;
  if (managed?.status === "awaitingPermission") return true;
  return activity?.kind === "waitingUser";
}

function activityLabel(activity: ResolvedTurnActivity | null): {
  label: string;
  detail?: string;
} {
  if (!activity) return { label: "Idle" };
  const label = activity.detail
    ? `${activity.label}${activity.detail}`
    : activity.label;
  return { label, detail: activity.hint };
}

/**
 * Map the focused task onto the Codex pet rows.
 *
 * waiting = blocked on the human (permission, question, approval).
 * review  = plan in front of the human, or the last turn finished and is
 *           sitting there to be looked at (Codex "ready for review").
 * running = the agent is doing something, including thinking / tools.
 * failed  = the last settled turn failed, or the attach is in error.
 * idle    = nothing in flight.
 */
export function resolvePetActivity(
  managed: ManagedAgentInfo | null | undefined,
  items: TimelineItem[],
  opts?: {
    sessionIsActive?: boolean;
    sessionTitle?: string | null;
    pendingPermissions?: PendingPermission[];
  },
): PetActivity {
  const activity = resolveTurnActivity(managed, items, {
    sessionIsActive: opts?.sessionIsActive,
  });
  const title = opts?.sessionTitle?.trim() || undefined;
  const pending = opts?.pendingPermissions;
  const { label, detail } = activityLabel(
    activity?.kind === "external" ? null : activity,
  );

  const withMeta = (motion: PetMotion, text: string, extra?: string): PetActivity => ({
    motion,
    label: text,
    detail: extra ?? detail,
    title,
  });

  if (isOpenPlanApproval(pending)) {
    return withMeta("review", "Review the plan");
  }
  if (isBlockedOnUser(activity, managed, pending)) {
    return withMeta("waiting", activity?.label ?? "Waiting for you");
  }
  if (managed?.status === "error") {
    return withMeta("failed", managed.lastError?.trim() || "Error");
  }
  if (activity && activity.kind !== "external") {
    if (activity.tone === "danger" && activity.kind === "cancelling") {
      return withMeta("running", activity.label);
    }
    return withMeta("running", label);
  }
  if (lastTerminal(items) === "failed" && !activity) {
    return withMeta("failed", "Turn failed");
  }
  if (lastTerminal(items) === "completed" && !activity) {
    return withMeta("review", "Ready for review");
  }
  return withMeta("idle", "Idle");
}
