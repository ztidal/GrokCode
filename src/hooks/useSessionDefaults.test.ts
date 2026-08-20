import { describe, expect, it } from "vitest";
import type { AvailableModelInfo } from "../types";
import {
  highestReasoningEffort,
  newestAdvertisedModel,
  sessionDefaultPush,
} from "./useSessionDefaults";

/** One catalog entry; every field the decision reads is optional on the wire. */
function model(
  modelId: string,
  extra: Partial<AvailableModelInfo> = {},
): AvailableModelInfo {
  return { modelId, ...extra };
}

/** Rungs as the agent sends them: best first, `default` on the sensible one. */
const GROK_RUNGS: AvailableModelInfo["reasoningEfforts"] = [
  { value: "xhigh", label: "Extra High Effort" },
  { value: "high", label: "High Effort", default: true },
  { value: "medium", label: "Medium Effort" },
  { value: "low", label: "Low Effort" },
];

describe("newestAdvertisedModel", () => {
  it("has no answer before the catalog arrives", () => {
    expect(newestAdvertisedModel([])).toBeNull();
    expect(newestAdvertisedModel(undefined)).toBeNull();
  });

  it("takes the model the agent lists first", () => {
    expect(
      newestAdvertisedModel([model("grok-4.6"), model("grok-4.5")]),
    ).toBe("grok-4.6");
  });

  it("keeps trusting the order when a later id looks newer", () => {
    // The rule is the agent's ordering, not arithmetic on the id: an agent that
    // lists a preview build first means it, and `grok-4.10` must not be read
    // as older than `grok-4.9` by a version parser we do not have.
    expect(
      newestAdvertisedModel([model("grok-4.6-preview"), model("grok-9")]),
    ).toBe("grok-4.6-preview");
  });

  it("skips entries with no usable id", () => {
    expect(newestAdvertisedModel([model("  "), model("grok-4.5")])).toBe(
      "grok-4.5",
    );
  });

  it("answers with the only model on offer", () => {
    expect(newestAdvertisedModel([model("grok-4.5")])).toBe("grok-4.5");
  });
});

describe("highestReasoningEffort", () => {
  it("takes the head of the agent's own list, not its default", () => {
    expect(
      highestReasoningEffort("grok-4.6", [
        model("grok-4.6", {
          supportsReasoningEffort: true,
          reasoningEffort: "high",
          reasoningEfforts: GROK_RUNGS,
        }),
      ]),
    ).toBe("xhigh");
  });

  it("uses rung names it has never seen", () => {
    // The app ranks nothing itself — an agent that ships new level names still
    // gets its best one chosen.
    expect(
      highestReasoningEffort("grok-next", [
        model("grok-next", {
          supportsReasoningEffort: true,
          reasoningEfforts: [
            { value: "ludicrous", label: "Ludicrous" },
            { value: "brisk", label: "Brisk", default: true },
          ],
        }),
      ]),
    ).toBe("ludicrous");
  });

  it("falls back to the known rungs when the catalog omits them", () => {
    expect(highestReasoningEffort("grok-4.6", [model("grok-4.6")])).toBe(
      "xhigh",
    );
    expect(highestReasoningEffort("grok-4.5", [model("grok-4.5")])).toBe(
      "high",
    );
  });

  it("has no answer for a model that does not think in levels", () => {
    expect(highestReasoningEffort("grok-4-fast", [model("grok-4-fast")])).toBe(
      null,
    );
    expect(highestReasoningEffort("", [model("grok-4.6")])).toBeNull();
  });
});

describe("sessionDefaultPush", () => {
  it("waits rather than guessing while the catalog is empty", () => {
    expect(
      sessionDefaultPush({ modelId: "grok-4.5", availableModels: [] }),
    ).toBeNull();
    expect(sessionDefaultPush({ modelId: "grok-4.5" })).toBeNull();
  });

  it("moves an older session model to the newest at its best level", () => {
    expect(
      sessionDefaultPush({
        modelId: "grok-4.5",
        reasoningEffort: "high",
        availableModels: [
          model("grok-4.6", {
            supportsReasoningEffort: true,
            reasoningEffort: "high",
            reasoningEfforts: GROK_RUNGS,
          }),
          model("grok-4.5", { supportsReasoningEffort: true }),
        ],
      }),
    ).toEqual({ modelId: "grok-4.6", reasoningEffort: "xhigh" });
  });

  it("raises the level when the agent already picked the newest model", () => {
    expect(
      sessionDefaultPush({
        modelId: "grok-4.6",
        reasoningEffort: "high",
        availableModels: [
          model("grok-4.6", {
            supportsReasoningEffort: true,
            reasoningEfforts: GROK_RUNGS,
          }),
        ],
      }),
    ).toEqual({ modelId: "grok-4.6", reasoningEffort: "xhigh" });
  });

  it("stays quiet when the agent's own default is already the best", () => {
    // The common case for a fresh session — and the one that must not cost a
    // round trip.
    expect(
      sessionDefaultPush({
        modelId: "grok-4.6",
        reasoningEffort: "xhigh",
        availableModels: [
          model("grok-4.6", {
            supportsReasoningEffort: true,
            reasoningEffort: "xhigh",
            reasoningEfforts: GROK_RUNGS,
          }),
        ],
      }),
    ).toBeNull();
  });

  it("replaces a level the model does not list", () => {
    expect(
      sessionDefaultPush({
        modelId: "grok-4.6",
        reasoningEffort: "banana",
        availableModels: [
          model("grok-4.6", {
            supportsReasoningEffort: true,
            reasoningEfforts: GROK_RUNGS,
          }),
        ],
      }),
    ).toEqual({ modelId: "grok-4.6", reasoningEffort: "xhigh" });
  });

  it("switches to a model without levels without naming one", () => {
    // Sending the previous model's level to a model that has none would be
    // asking the agent for something it never advertised.
    expect(
      sessionDefaultPush({
        modelId: "grok-4.5",
        reasoningEffort: "high",
        availableModels: [model("grok-4-fast"), model("grok-4.5")],
      }),
    ).toEqual({ modelId: "grok-4-fast" });
  });

  it("stays quiet on a levelless model that is already current", () => {
    expect(
      sessionDefaultPush({
        modelId: "grok-4-fast",
        reasoningEffort: "high",
        availableModels: [model("grok-4-fast")],
      }),
    ).toBeNull();
  });

  it("does not push a session that has not reported a model yet", () => {
    expect(
      sessionDefaultPush({
        modelId: null,
        availableModels: [
          model("grok-4.6", {
            supportsReasoningEffort: true,
            reasoningEfforts: GROK_RUNGS,
          }),
        ],
      }),
    ).toEqual({ modelId: "grok-4.6", reasoningEffort: "xhigh" });
  });

  it("reads padded values as the values they are", () => {
    expect(
      sessionDefaultPush({
        modelId: " grok-4.6 ",
        reasoningEffort: " xhigh ",
        availableModels: [
          model(" grok-4.6 ", {
            supportsReasoningEffort: true,
            reasoningEfforts: GROK_RUNGS,
          }),
        ],
      }),
    ).toBeNull();
  });
});
