import { describe, expect, it } from "vitest";
import { resolveOverride } from "./useSessionTitles";

describe("resolveOverride", () => {
  it("keeps a name that differs from the agent's", () => {
    expect(resolveOverride("My name", "Agent title")).toBe("My name");
  });

  it("trims what it keeps", () => {
    expect(resolveOverride("  My name  ", "Agent title")).toBe("My name");
  });

  it("clears when the field is emptied", () => {
    // Blank is the only way back to the agent's own title, so it must not be
    // stored as a name — a card with no title at all would be unreachable.
    expect(resolveOverride("", "Agent title")).toBeNull();
    expect(resolveOverride("   ", "Agent title")).toBeNull();
  });

  it("clears when the name matches the agent's own", () => {
    // Otherwise the override pins a title the agent may still change, and
    // nothing looks wrong until it does.
    expect(resolveOverride("Agent title", "Agent title")).toBeNull();
    expect(resolveOverride(" Agent title ", "Agent title")).toBeNull();
    expect(resolveOverride("Agent title", "  Agent title  ")).toBeNull();
  });

  it("treats a name that only differs in case as a rename", () => {
    // Capitalising your own task is a rename, not a coincidence.
    expect(resolveOverride("AGENT TITLE", "Agent title")).toBe("AGENT TITLE");
  });
});
