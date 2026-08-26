import { describe, expect, it } from "vitest";
import {
  parseStoredPins,
  serializePins,
  sortPinnedFirst,
  togglePin,
} from "./useSessionPins";

/** Only `id` matters to the sort; the sidebar's card shape is irrelevant here. */
function item(id: string, rank = 0): { id: string; rank: number } {
  return { id, rank };
}

describe("pin persistence", () => {
  it("round-trips a set of ids", () => {
    const ids = new Set(["s-b", "s-a"]);
    expect(parseStoredPins(serializePins(ids))).toEqual(ids);
  });

  it("keeps insertion order, which is pin time", () => {
    expect(serializePins(new Set(["s-b", "s-a"]))).toBe('["s-b","s-a"]');
    expect([...parseStoredPins('["s-b","s-a"]')]).toEqual(["s-b", "s-a"]);
  });

  it("treats an absent or unusable value as nothing pinned", () => {
    expect(parseStoredPins(null)).toEqual(new Set());
    expect(parseStoredPins("")).toEqual(new Set());
    expect(parseStoredPins("{oops")).toEqual(new Set());
    expect(parseStoredPins('{"s-a":true}')).toEqual(new Set());
  });

  it("drops entries that are not usable ids", () => {
    expect(parseStoredPins('["s-a", 7, null, ""]')).toEqual(new Set(["s-a"]));
  });
});

describe("togglePin", () => {
  it("adds an id that is not pinned yet", () => {
    expect(togglePin(new Set(), "s-a")).toEqual(new Set(["s-a"]));
  });

  it("removes an id that is already pinned", () => {
    expect(togglePin(new Set(["s-a", "s-b"]), "s-a")).toEqual(new Set(["s-b"]));
  });

  it("never mutates the set it was given", () => {
    const before = new Set(["s-a"]);
    togglePin(before, "s-b");
    expect(before).toEqual(new Set(["s-a"]));
  });

  it("returns a fresh set even when nothing changed", () => {
    const before = new Set(["s-a"]);
    const after = togglePin(before, "");
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
  });
});

describe("sortPinnedFirst", () => {
  it("lifts pinned items above everything else", () => {
    const sorted = sortPinnedFirst(
      [item("a"), item("b"), item("c")],
      new Set(["c"]),
    );
    expect(sorted.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps the caller's order inside each half", () => {
    const sorted = sortPinnedFirst(
      [item("a"), item("b"), item("c"), item("d")],
      new Set(["b", "d"]),
    );
    expect(sorted.map((i) => i.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("ranks by the tiebreak only after the pin split", () => {
    // "a" outranks every pin candidate, and still loses to one.
    const sorted = sortPinnedFirst(
      [item("a", 0), item("b", 5), item("c", 3)],
      new Set(["b"]),
      (x, y) => x.rank - y.rank,
    );
    expect(sorted.map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("does not let the tiebreak reshuffle two pins", () => {
    // Pin time is b then a; compare would put a first.
    const sorted = sortPinnedFirst(
      [item("a", 0), item("b", 5)],
      new Set(["b", "a"]),
      (x, y) => x.rank - y.rank,
    );
    expect(sorted.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("falls back to the tiebreak alone when nothing is pinned", () => {
    const sorted = sortPinnedFirst(
      [item("a", 2), item("b", 1)],
      new Set(),
      (x, y) => x.rank - y.rank,
    );
    expect(sorted.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("ignores pins for ids that are not on the page", () => {
    const sorted = sortPinnedFirst([item("a"), item("b")], new Set(["gone"]));
    expect(sorted.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("copies rather than sorting the caller's array", () => {
    const input = [item("a"), item("b")];
    const sorted = sortPinnedFirst(input, new Set(["b"]));
    expect(sorted).not.toBe(input);
    expect(input.map((i) => i.id)).toEqual(["a", "b"]);
  });
});
