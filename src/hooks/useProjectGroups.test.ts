import { describe, expect, it } from "vitest";
import type { ProjectGroup, SessionCard } from "../types";
import {
  groupCountLabel,
  groupCountTitle,
  groupLoadedSessions,
  loadedProjectSignature,
  normalizeGroupKey,
  parseStoredCollapsed,
  serializeCollapsed,
  type SessionGroup,
  groupsHoldingPins,
} from "./useProjectGroups";

function card(
  id: string,
  cwd: string,
  lastActiveAt: string | null = null,
): SessionCard {
  return {
    id,
    cwd,
    title: id,
    numMessages: 0,
    isActive: false,
    status: "idle",
    lastActiveAt,
    contextTokensUsed: 0,
    contextWindowTokens: 0,
    contextWindowUsage: 0,
    totalTokens: 0,
    tokenUsageIncomplete: false,
    tokenUsageAvailable: true,
    tokenUsagePending: false,
    toolCallCount: 0,
    turnCount: 0,
    toolsUsed: [],
    agentLinesAdded: 0,
    agentLinesRemoved: 0,
    agentFilesTouched: 0,
    sessionDurationSeconds: 0,
    errorCount: 0,
  };
}

function group(
  key: string,
  path: string,
  sessionCount: number,
  lastActivityMs: number,
  exists = true,
): ProjectGroup {
  return {
    key,
    path,
    label: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    sessionCount,
    lastActivityMs,
    exists,
  };
}

describe("normalizeGroupKey", () => {
  it("mirrors the Rust key: verbatim prefix, separators, trailing slash", () => {
    expect(normalizeGroupKey("\\\\?\\D:\\000_project")).toBe("D:\\000_project");
    expect(normalizeGroupKey("D:/000_project")).toBe("D:\\000_project");
    expect(normalizeGroupKey("D:\\000_project\\\\")).toBe("D:\\000_project");
    expect(normalizeGroupKey("  D:\\000_project  ")).toBe("D:\\000_project");
    expect(normalizeGroupKey("/home/me/proj/")).toBe("\\home\\me\\proj");
  });

  it("keeps case, because only the host knows whether it matters", () => {
    expect(normalizeGroupKey("D:\\Proj")).toBe("D:\\Proj");
  });
});

describe("loadedProjectSignature", () => {
  it("is the distinct project set, order- and duplicate-independent", () => {
    const a = [card("1", "D:\\a"), card("2", "D:\\b"), card("3", "D:\\a")];
    const b = [card("9", "D:/b/"), card("8", "D:\\a")];
    expect(loadedProjectSignature(a)).toBe(loadedProjectSignature(b));
  });

  it("changes when the page pulls in a project it did not have", () => {
    const before = loadedProjectSignature([card("1", "D:\\a")]);
    const after = loadedProjectSignature([card("1", "D:\\a"), card("2", "D:\\c")]);
    expect(after).not.toBe(before);
  });

  it("is empty when there is nothing to group", () => {
    expect(loadedProjectSignature([])).toBe("");
  });
});

describe("groupLoadedSessions", () => {
  const groups = [
    group("d:\\000_project", "D:\\000_project", 7, 3_000),
    group("d:\\000_project\\000_tmp", "D:\\000_project\\000_tmp", 1, 5_000),
    group("d:\\gone", "D:\\gone", 2, 1_000, false),
  ];

  it("keeps the caller's card order inside each group", () => {
    const [project] = groupLoadedSessions(
      [
        card("second", "D:\\000_project"),
        card("first", "D:\\000_project\\000_tmp"),
        card("third", "D:\\000_project"),
      ],
      groups,
    ).filter((g) => g.key === "d:\\000_project");
    expect(project.sessions.map((s) => s.id)).toEqual(["second", "third"]);
  });

  it("orders groups by index activity, not by the loaded page", () => {
    const ordered = groupLoadedSessions(
      [
        card("a", "D:\\gone"),
        card("b", "D:\\000_project"),
        card("c", "D:\\000_project\\000_tmp"),
      ],
      groups,
    );
    expect(ordered.map((g) => g.key)).toEqual([
      "d:\\000_project\\000_tmp",
      "d:\\000_project",
      "d:\\gone",
    ]);
  });

  it("reports the index count, not the number of cards on the page", () => {
    const [project] = groupLoadedSessions([card("a", "D:\\000_project")], groups);
    expect(project.totalCount).toBe(7);
    expect(project.sessions).toHaveLength(1);
  });

  it("never claims fewer sessions than it is showing", () => {
    const stale = [group("d:\\000_project", "D:\\000_project", 1, 3_000)];
    const [project] = groupLoadedSessions(
      [card("a", "D:\\000_project"), card("b", "D:\\000_project")],
      stale,
    );
    expect(project.totalCount).toBe(2);
  });

  it("matches a cwd spelled differently from the indexed path", () => {
    const [project] = groupLoadedSessions(
      [card("a", "\\\\?\\D:\\000_PROJECT\\"), card("b", "D:/000_project")],
      groups,
    );
    expect(project.key).toBe("d:\\000_project");
    expect(project.sessions).toHaveLength(2);
  });

  it("carries the missing-folder flag through from the index", () => {
    const [gone] = groupLoadedSessions([card("a", "D:\\gone")], groups);
    expect(gone.missing).toBe(true);
  });

  it("still shows a card whose project the index does not know", () => {
    const [orphan] = groupLoadedSessions(
      [card("a", "D:\\unindexed", "2026-08-20T10:00:00Z")],
      groups,
    );
    expect(orphan.key).toBe("D:\\unindexed");
    expect(orphan.label).toBe("unindexed");
    expect(orphan.missing).toBe(false);
    expect(orphan.totalCount).toBe(1);
  });

  it("sorts an unindexed group by its newest loaded card", () => {
    const ordered = groupLoadedSessions(
      [
        card("old", "D:\\stale", "2020-01-01T00:00:00Z"),
        card("new", "D:\\fresh", "2030-01-01T00:00:00Z"),
      ],
      [],
    );
    expect(ordered.map((g) => g.key)).toEqual(["D:\\fresh", "D:\\stale"]);
  });

  it("produces nothing at all with no cards", () => {
    expect(groupLoadedSessions([], groups)).toEqual([]);
  });
});

describe("group count chrome", () => {
  function sized(loaded: number, total: number): SessionGroup {
    return {
      key: "k",
      label: "k",
      path: "D:\\k",
      sessions: Array.from({ length: loaded }, (_, i) => card(String(i), "D:\\k")),
      totalCount: total,
      missing: false,
      activityMs: 0,
    };
  }

  it("shows the bare total once the page holds everything", () => {
    expect(groupCountLabel(sized(7, 7))).toBe("7");
    expect(groupCountTitle(sized(7, 7))).toBe("7 sessions");
    expect(groupCountTitle(sized(1, 1))).toBe("1 session");
  });

  it("shows the loaded share while paging is behind", () => {
    expect(groupCountLabel(sized(3, 7))).toBe("3/7");
    expect(groupCountTitle(sized(3, 7))).toBe("3 of 7 sessions loaded");
  });
});

describe("collapse persistence", () => {
  it("round-trips a set of keys", () => {
    const keys = new Set(["d:\\b", "d:\\a"]);
    expect(parseStoredCollapsed(serializeCollapsed(keys))).toEqual(keys);
  });

  it("writes a stable spelling for an unchanged set", () => {
    expect(serializeCollapsed(new Set(["d:\\b", "d:\\a"]))).toBe(
      serializeCollapsed(new Set(["d:\\a", "d:\\b"])),
    );
  });

  it("treats an absent or unusable value as nothing collapsed", () => {
    expect(parseStoredCollapsed(null)).toEqual(new Set());
    expect(parseStoredCollapsed("")).toEqual(new Set());
    expect(parseStoredCollapsed("{oops")).toEqual(new Set());
    expect(parseStoredCollapsed('{"d:\\\\a":true}')).toEqual(new Set());
  });

  it("drops entries that are not usable keys", () => {
    expect(parseStoredCollapsed('["d:\\\\a", 3, null, ""]')).toEqual(
      new Set(["d:\\a"]),
    );
  });
});

describe("groupsHoldingPins", () => {
  const group = (key: string, ids: string[]): SessionGroup => ({
    key,
    label: key,
    path: key,
    sessions: ids.map((id) => ({ id }) as SessionGroup["sessions"][number]),
    totalCount: ids.length,
    missing: false,
  });

  it("returns nothing when nothing is pinned", () => {
    expect(groupsHoldingPins([group("a", ["1"])], new Set())).toEqual([]);
  });

  it("names only the groups that hold a pin", () => {
    const groups = [group("a", ["1", "2"]), group("b", ["3"]), group("c", [])];
    expect(groupsHoldingPins(groups, new Set(["3"]))).toEqual(["b"]);
  });

  it("names every holder when pins span projects", () => {
    const groups = [group("a", ["1"]), group("b", ["2"]), group("c", ["3"])];
    expect(groupsHoldingPins(groups, new Set(["1", "3"]))).toEqual(["a", "c"]);
  });

  it("ignores pins whose session is not on the loaded page", () => {
    expect(groupsHoldingPins([group("a", ["1"])], new Set(["missing"]))).toEqual(
      [],
    );
  });
});
