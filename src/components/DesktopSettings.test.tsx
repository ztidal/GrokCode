import { describe, expect, it } from "vitest";
import {
  closeDesktopSettings,
  toggleDesktopSettings,
} from "./DesktopSettings";

type SettingsFocusTarget = { focus: () => void };

describe("desktop Settings focus lifecycle", () => {
  it("closes immediately, then restores the current gear after pointer event work", async () => {
    const events: string[] = [];
    let trigger: SettingsFocusTarget = {
      focus: () => events.push("focus:stale"),
    };

    closeDesktopSettings(
      (open) => events.push(`open:${open}`),
      () => trigger,
    );

    expect(events).toEqual(["open:false"]);

    trigger = { focus: () => events.push("focus:current") };
    await Promise.resolve();
    expect(events).toEqual(["open:false", "focus:current"]);
  });

  it("opens without moving focus and uses the close contract for an open toggle", () => {
    const events: string[] = [];
    const scheduled: Array<() => void> = [];
    const setOpen = (open: boolean) => events.push(`open:${open}`);
    const getTrigger = () => ({
      focus: () => events.push("focus:gear"),
    });
    const scheduleFocus = (restoreFocus: () => void) =>
      scheduled.push(restoreFocus);

    toggleDesktopSettings(false, setOpen, getTrigger, scheduleFocus);
    expect(events).toEqual(["open:true"]);
    expect(scheduled).toHaveLength(0);

    toggleDesktopSettings(true, setOpen, getTrigger, scheduleFocus);
    expect(events).toEqual(["open:true", "open:false"]);
    expect(scheduled).toHaveLength(1);

    scheduled[0]!();
    expect(events).toEqual(["open:true", "open:false", "focus:gear"]);
  });
});
