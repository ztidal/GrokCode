import type { AvailableModelInfo, ReasoningEffortOption } from "../types";

const EFFORT_XHIGH: ReasoningEffortOption = {
  value: "xhigh",
  label: "Extra High Effort",
  description: "Highest effort and reasoning level",
};

const EFFORT_HIGH: ReasoningEffortOption = {
  value: "high",
  label: "High Effort",
  description: "Higher implementation quality with extensive reasoning",
  default: true,
};

const EFFORT_MEDIUM: ReasoningEffortOption = {
  value: "medium",
  label: "Medium Effort",
  description: "Balanced effort with standard implementation and testing",
};

const EFFORT_LOW: ReasoningEffortOption = {
  value: "low",
  label: "Low Effort",
  description: "Quick, fast implementations",
};

/** grok-4.6 catalog: xhigh + high/medium/low, default high. */
export const GROK_46_EFFORTS: ReasoningEffortOption[] = [
  EFFORT_XHIGH,
  EFFORT_HIGH,
  EFFORT_MEDIUM,
  EFFORT_LOW,
];

/** grok-4.5 catalog: no xhigh. */
export const GROK_45_EFFORTS: ReasoningEffortOption[] = [
  EFFORT_HIGH,
  EFFORT_MEDIUM,
  EFFORT_LOW,
];

/** grok-build `legacy_effort_options` — same rungs, no catalog default. */
export const LEGACY_EFFORTS: ReasoningEffortOption[] = GROK_46_EFFORTS.map(
  (option) => ({ ...option, default: false }),
);


function fallbackEffortsFor(
  modelId: string,
): ReasoningEffortOption[] | null {
  const id = modelId.trim().toLowerCase();
  if (!id) return null;
  if (id.startsWith("grok-4.6") || /^grok-4\.[7-9]/.test(id)) {
    return GROK_46_EFFORTS;
  }
  if (id.startsWith("grok-4.5")) return GROK_45_EFFORTS;
  if (id === "grok-4" || id.startsWith("grok-4-")) {
    if (id.includes("mini") || id.includes("fast")) return null;
    return GROK_45_EFFORTS;
  }
  return null;
}

/**
 * Menu for the Thinking chip.
 *
 * Catalog list wins. A support flag with an empty list falls back the same
 * way grok-build does. Known Grok models still get a menu when the catalog
 * is empty or arrived without `_meta` (the idle-session / first-send case).
 */
export function resolveReasoningOptions(
  modelId: string,
  available: AvailableModelInfo[],
): ReasoningEffortOption[] {
  const id = modelId.trim();
  if (!id) return [];
  const model = available.find((item) => item.modelId === id);
  const listed = model?.reasoningEfforts?.filter((option) =>
    option.value.trim(),
  );
  if (listed && listed.length > 0) return listed;

  const known = fallbackEffortsFor(id);
  if (model?.supportsReasoningEffort) return known ?? LEGACY_EFFORTS;
  return known ?? [];
}

/**
 * Effort a new session should start on: Extra High when the menu lists it,
 * otherwise the first rung (Grok's own default is High; we do not follow that).
 */
export function preferredNewSessionEffort(
  options: ReasoningEffortOption[],
): string | null {
  if (options.length === 0) return null;
  const extraHigh = options.find((option) => option.value.trim() === "xhigh");
  if (extraHigh) return extraHigh.value;
  return options[0]?.value.trim() || null;
}

export function selectedReasoningEffort(
  options: ReasoningEffortOption[],
  reasoningEffort?: string | null,
): ReasoningEffortOption | null {
  if (options.length === 0) return null;
  const selected = reasoningEffort?.trim();
  if (selected) {
    const match = options.find((option) => option.value === selected);
    if (match) return match;
  }
  const preferred = preferredNewSessionEffort(options);
  return (
    options.find((option) => option.value === preferred) ??
    options[0] ??
    null
  );
}

