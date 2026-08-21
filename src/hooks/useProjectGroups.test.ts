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
  PINNED_GROUP_KEY,
  ARCHIVED_GROUP_KEY,
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
      loadedCount: loaded,
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

describe("the pinned group", () => {
  const card = (id: string, cwd: string, updatedAt: string): SessionCard =>
    ({ id, cwd, title: id, updatedAt, numMessages: 1 }) as SessionCard;

  const cards = [
    card("busy", "D:/proj/active", "2026-08-20T10:00:00Z"),
    card("old", "D:/proj/dusty", "2026-01-01T00:00:00Z"),
  ];

  it("does not exist while nothing on the page is pinned", () => {
    const groups = groupLoadedSessions(cards, [], new Set());
    expect(groups.map((g) => g.label)).toEqual(["active", "dusty"]);
    expect(groups.some((g) => g.special)).toBeFalsy();
  });

  it("ignores a pin whose session is not on the loaded page", () => {
    const groups = groupLoadedSessions(cards, [], new Set(["elsewhere"]));
    expect(groups.some((g) => g.special)).toBeFalsy();
  });

  it("comes first, ahead of the busiest project", () => {
    const groups = groupLoadedSessions(cards, [], new Set(["old"]));
    expect(groups[0].key).toBe(PINNED_GROUP_KEY);
    expect(groups[0].label).toBe("Pinned");
    expect(groups[0].special).toBe("pinned");
  });

  it("moves the card out of its project rather than copying it", () => {
    const groups = groupLoadedSessions(cards, [], new Set(["busy"]));
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["busy"]);
    // "busy" was the only card under `active`, so that header is gone entirely.
    expect(groups.map((g) => g.label)).toEqual(["Pinned", "dusty"]);
  });

  it("leaves a project that still has something to show", () => {
    const two = [
      card("one", "D:/proj/active", "2026-08-20T10:00:00Z"),
      card("two", "D:/proj/active", "2026-08-19T10:00:00Z"),
    ];
    const groups = groupLoadedSessions(two, [], new Set(["one"]));
    expect(groups.map((g) => g.label)).toEqual(["Pinned", "active"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["two"]);
  });

  it("still counts a moved card as loaded by its project", () => {
    const two = [
      card("one", "D:/proj/active", "2026-08-20T10:00:00Z"),
      card("two", "D:/proj/active", "2026-08-19T10:00:00Z"),
    ];
    // Both cards are loaded; one is just being shown a group up. A badge of
    // "1/2" would read as paging that is never going to finish.
    const [, project] = groupLoadedSessions(two, [], new Set(["one"]));
    expect(project.loadedCount).toBe(2);
    expect(groupCountLabel(project)).toBe("2");
  });

  it("keeps the caller's order among the pinned cards", () => {
    const groups = groupLoadedSessions(cards, [], new Set(["busy", "old"]));
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["busy", "old"]);
    expect(groups).toHaveLength(1);
  });
});

describe("the archived group", () => {
  const card = (id: string, cwd: string, updatedAt: string): SessionCard =>
    ({ id, cwd, title: id, updatedAt, numMessages: 1 }) as SessionCard;

  const cards = [
    card("busy", "D:/proj/active", "2026-08-20T10:00:00Z"),
    card("old", "D:/proj/dusty", "2026-01-01T00:00:00Z"),
  ];
  const none = new Set<string>();

  it("does not exist while nothing on the page is archived", () => {
    const groups = groupLoadedSessions(cards, [], none, none);
    expect(groups.map((g) => g.label)).toEqual(["active", "dusty"]);
  });

  it("comes last, below every project", () => {
    const groups = groupLoadedSessions(cards, [], none, new Set(["busy"]));
    const last = groups[groups.length - 1];
    expect(last.key).toBe(ARCHIVED_GROUP_KEY);
    expect(last.label).toBe("Archived");
    expect(last.special).toBe("archived");
    expect(last.sessions.map((s) => s.id)).toEqual(["busy"]);
  });

  it("brackets the projects when something is pinned too", () => {
    const groups = groupLoadedSessions(
      cards,
      [],
      new Set(["old"]),
      new Set(["busy"]),
    );
    expect(groups.map((g) => g.label)).toEqual(["Pinned", "Archived"]);
    expect(groups[0].key).toBe(PINNED_GROUP_KEY);
    expect(groups[1].key).toBe(ARCHIVED_GROUP_KEY);
  });

  it("wins over a pin on the same card, being the later word", () => {
    const both = new Set(["busy"]);
    const groups = groupLoadedSessions(cards, [], both, both);
    expect(groups.some((g) => g.key === PINNED_GROUP_KEY)).toBe(false);
    const archived = groups.find((g) => g.key === ARCHIVED_GROUP_KEY);
    expect(archived?.sessions.map((s) => s.id)).toEqual(["busy"]);
  });

  it("still counts an archived card as loaded by its project", () => {
    const two = [
      card("one", "D:/proj/active", "2026-08-20T10:00:00Z"),
      card("two", "D:/proj/active", "2026-08-19T10:00:00Z"),
    ];
    const groups = groupLoadedSessions(two, [], none, new Set(["one"]));
    const project = groups.find((g) => g.label === "active");
    expect(project?.sessions.map((s) => s.id)).toEqual(["two"]);
    expect(project?.loadedCount).toBe(2);
    expect(groupCountLabel(project as SessionGroup)).toBe("2");
  });

  it("drops a project whose every loaded card is archived", () => {
    const groups = groupLoadedSessions(cards, [], none, new Set(["busy"]));
    expect(groups.map((g) => g.label)).toEqual(["dusty", "Archived"]);
  });
});
