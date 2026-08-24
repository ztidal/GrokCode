import { describe, expect, it } from "vitest";
import type {
  ManagedAgentInfo,
  PendingPermission,
  TimelineItem,
} from "../types";
import { resolvePetActivity } from "./petActivity";

function managed(
  status: ManagedAgentInfo["status"],
): ManagedAgentInfo {
  return {
    handleId: "h1",
    cwd: "/tmp",
    status,
    permissionMode: "default",
    alwaysApprove: false,
    createdAt: new Date().toISOString(),
  };
}

function item(
  partial: Partial<TimelineItem> & Pick<TimelineItem, "kind" | "title">,
): TimelineItem {
  return {
    id: partial.id ?? `${partial.kind}-${partial.title}`,
    handleId: "h1",
    ts: partial.ts ?? Date.now(),
    kind: partial.kind,
    title: partial.title,
    detail: partial.detail,
    streaming: partial.streaming,
    toolCallId: partial.toolCallId,
    toolBase: partial.toolBase,
    toolStatus: partial.toolStatus,
  };
}

function planPermission(): PendingPermission {
  return {
    requestKey: "plan-1",
    handleId: "h1",
    requestId: 1,
    kind: "planApproval",
    method: "x.ai/plan/approve",
    title: "Plan",
    detail: "",
    risk: "low",
    options: [],
    rawParams: {},
    createdAtMs: Date.now(),
  };
}

describe("resolvePetActivity", () => {
  it("is idle when nothing is attached", () => {
    expect(resolvePetActivity(null, []).motion).toBe("idle");
    expect(resolvePetActivity(managed("ready"), []).motion).toBe("idle");
  });

  it("maps mid-turn work to running", () => {
    expect(resolvePetActivity(managed("starting"), []).motion).toBe("running");
    expect(
      resolvePetActivity(managed("running"), [
        item({ kind: "thought", title: "hmm", streaming: true }),
      ]).motion,
    ).toBe("running");
    expect(resolvePetActivity(managed("stopping"), []).motion).toBe("running");
  });

  it("maps a tool permission to waiting, and a plan to review", () => {
    expect(resolvePetActivity(managed("awaitingPermission"), []).motion).toBe(
      "waiting",
    );
    expect(
      resolvePetActivity(managed("awaitingPermission"), [], {
        pendingPermissions: [planPermission()],
      }).motion,
    ).toBe("review");
  });

  it("keeps a failed turn on the pet after the attach goes idle", () => {
    expect(
      resolvePetActivity(managed("ready"), [
        item({ kind: "event", title: "Turn failed" }),
      ]).motion,
    ).toBe("failed");
    expect(resolvePetActivity(managed("error"), []).motion).toBe("failed");
  });

  it("maps a finished turn to review, not idle", () => {
    expect(
      resolvePetActivity(managed("ready"), [
        item({ kind: "event", title: "Worked for 12s" }),
      ]).motion,
    ).toBe("review");
    expect(
      resolvePetActivity(managed("ready"), [
        item({ kind: "event", title: "Turn completed" }),
      ]).label,
    ).toBe("Ready for review");
  });

  it("does not treat a cancelled turn as review", () => {
    expect(
      resolvePetActivity(managed("ready"), [
        item({ kind: "event", title: "Turn cancelled" }),
      ]).motion,
    ).toBe("idle");
  });

  it("carries the focused task title on every state", () => {
    const activity = resolvePetActivity(managed("ready"), [], {
      sessionTitle: "Fix the updater",
    });
    expect(activity.title).toBe("Fix the updater");
    expect(activity.motion).toBe("idle");
  });
});
