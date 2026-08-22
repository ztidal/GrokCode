import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = new URL("./release.mjs", import.meta.url);

describe("cross-platform release handoff", () => {
  it("lets the Windows builder stage a draft but not publish it", () => {
    const result = spawnSync(process.execPath, [script.pathname, "--help"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--draft");
    expect(result.stdout).not.toContain("--publish");
    expect(result.stdout).toContain("Mac-side release owner");
  });
});
