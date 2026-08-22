import { describe, expect, it } from "vitest";
import { legacyCarryOver } from "./useIdSet";

describe("legacyCarryOver", () => {
  it("answers null when neither store held anything", () => {
    expect(legacyCarryOver(null, null)).toBeNull();
    expect(legacyCarryOver("[]", "[]")).toBeNull();
  });

  it("treats a corrupt store as empty rather than blocking the other one", () => {
    expect(legacyCarryOver("{oops", '["s-a"]')).toEqual({
      pinned: [],
      archived: ["s-a"],
    });
  });

  it("carries one store even when the other never existed", () => {
    expect(legacyCarryOver('["s-a"]', null)).toEqual({
      pinned: ["s-a"],
      archived: [],
    });
    expect(legacyCarryOver(null, '["s-b"]')).toEqual({
      pinned: [],
      archived: ["s-b"],
    });
  });

  it("spells each set sorted and deduplicated", () => {
    expect(legacyCarryOver('["s-b","s-a","s-b"]', null)).toEqual({
      pinned: ["s-a", "s-b"],
      archived: [],
    });
  });

  it("drops entries that were never usable ids", () => {
    expect(legacyCarryOver('["s-a", 7, null, ""]', "[]")).toEqual({
      pinned: ["s-a"],
      archived: [],
    });
  });

  it("answers null when the stores held only unusable entries", () => {
    // Nothing worth a merge call — and nothing worth keeping the keys for.
    expect(legacyCarryOver('[7, null, ""]', "{oops")).toBeNull();
  });
});
