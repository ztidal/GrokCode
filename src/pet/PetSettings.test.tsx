import { describe, expect, it, vi } from "vitest";
import { render } from "../test/markup";
import { PetSettings } from "./PetSettings";

vi.mock("../api", () => ({
  listCodexPets: async () => [],
  getPetPrefs: async () => ({ enabled: false }),
  setPetPrefs: async () => ({ enabled: false }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));

describe("PetSettings", () => {
  it("renders the Codex pet row in Settings", () => {
    const html = render(<PetSettings />);
    expect(html).toContain("Codex pet");
    expect(html).toContain('class="pet-settings-row"');
  });
});
