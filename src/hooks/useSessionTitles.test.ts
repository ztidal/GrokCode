import { describe, expect, it } from "vitest";
import {
  parseStoredTitles,
  serializeTitles,
  setTitleOverride,
} from "./useSessionTitles";

describe("rename persistence", () => {
  it("round-trips a map of names", () => {
    const titles = new Map([
      ["b", "Second"],
      ["a", "First"],
    ]);
    expect(parseStoredTitles(serializeTitles(titles))).toEqual(titles);
  });

  it("writes a stable spelling for an unchanged map", () => {
    expect(
      serializeTitles(
        new Map([
          ["b", "Second"],
          ["a", "First"],
        ]),
      ),
    ).toBe(
      serializeTitles(
        new Map([
          ["a", "First"],
          ["b", "Second"],
        ]),
      ),
    );
  });

  it("treats an absent or unusable value as nothing renamed", () => {
    expect(parseStoredTitles(null)).toEqual(new Map());
    expect(parseStoredTitles("")).toEqual(new Map());
    expect(parseStoredTitles("{oops")).toEqual(new Map());
    // An array parses as JSON but is not the shape this ever wrote.
    expect(parseStoredTitles('["a"]')).toEqual(new Map());
    expect(parseStoredTitles("null")).toEqual(new Map());
  });

  it("drops entries that are not a usable id and name", () => {
    expect(
      parseStoredTitles('{"a":"Kept","b":3,"c":null,"":"Nameless","d":"  "}'),
    ).toEqual(new Map([["a", "Kept"]]));
  });

  it("trims stored names, so a rename cannot be pure whitespace", () => {
    expect(parseStoredTitles('{"a":"  Padded  "}')).toEqual(
      new Map([["a", "Padded"]]),
    );
  });
});

describe("setTitleOverride", () => {
  const none = new Map<string, string>();

  it("stores a name that differs from the agent's", () => {
    expect(setTitleOverride(none, "a", "My name", "Agent title")).toEqual(
      new Map([["a", "My name"]]),
    );
  });

  it("trims what it stores", () => {
    expect(setTitleOverride(none, "a", "  My name  ", "x").get("a")).toBe(
      "My name",
    );
  });

  it("drops the override when the field is cleared", () => {
    const one = new Map([["a", "My name"]]);
    expect(setTitleOverride(one, "a", "", "Agent title")).toEqual(none);
    expect(setTitleOverride(one, "a", "   ", "Agent title")).toEqual(none);
  });

  it("stores nothing when the name matches the agent's own", () => {
    // Otherwise the override silently pins a title the agent may still change,
    // and there would be no way to tell a rename from a coincidence.
    expect(setTitleOverride(none, "a", "Agent title", "Agent title")).toEqual(
      none,
    );
    expect(setTitleOverride(none, "a", " Agent title ", "Agent title")).toEqual(
      none,
    );
  });

  it("removes an existing override that is renamed back to the original", () => {
    const one = new Map([["a", "My name"]]);
    expect(setTitleOverride(one, "a", "Agent title", "Agent title")).toEqual(
      none,
    );
  });

  it("never mutates the map it was given", () => {
    const one = new Map([["a", "My name"]]);
    setTitleOverride(one, "a", "", "Agent title");
    setTitleOverride(one, "b", "Another", "x");
    expect(one).toEqual(new Map([["a", "My name"]]));
  });

  it("refuses an empty id, which could not survive a reload anyway", () => {
    expect(setTitleOverride(none, "", "My name", "x")).toEqual(none);
  });

  it("leaves other sessions alone", () => {
    const two = new Map([
      ["a", "First"],
      ["b", "Second"],
    ]);
    expect(setTitleOverride(two, "a", "Changed", "x")).toEqual(
      new Map([
        ["a", "Changed"],
        ["b", "Second"],
      ]),
    );
  });
});
