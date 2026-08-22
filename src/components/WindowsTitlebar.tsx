import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useId, useRef, useState } from "react";
import logoMark from "../assets/logo.png";
import type { UpdateCheckStatus } from "../hooks/useAppUpdate";
import { useAppVersion } from "../hooks/useAppVersion";
import { isWindowsDesktop } from "../utils/platform";
import {
  runWindowCommand,
  windowsUpdateStatusLabel,
  type WindowCommand,
} from "../utils/windowsTitlebar";
import {
  DesktopSettingsPanel,
  SettingsGearIcon,
} from "./DesktopSettings";

/** Windows-only custom chrome so Settings sits in the title bar, not below it. */
export function WindowsTitlebar({
  onCheckUpdate,
  checkStatus,
  onWindowError,
}: {
  onCheckUpdate: () => void;
  checkStatus: UpdateCheckStatus;
  onWindowError: (message: string) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsPanelId = useId();
  const windowsDesktop = isWindowsDesktop();
  const version = useAppVersion(windowsDesktop);

  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) {
        setSettingsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSettingsOpen(false);
        settingsTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsOpen]);

  if (!windowsDesktop) return null;

  const busy = checkStatus === "checking";
  const status = windowsUpdateStatusLabel(checkStatus);
  const closeSettingsAndRestoreFocus = () => {
    setSettingsOpen(false);
    settingsTriggerRef.current?.focus();
  };
  const invokeWindowCommand = (
    command: WindowCommand,
    invoke: () => Promise<void>,
  ) => {
    void runWindowCommand(command, invoke, onWindowError);
  };

  return (
    <header className="windows-titlebar" aria-label="ZtidalCode window controls">
      <div className="windows-titlebar-drag" data-tauri-drag-region>
        <img
          className="windows-titlebar-logo"
          src={logoMark}
          alt=""
          width={16}
          height={16}
          draggable={false}
        />
        <span className="windows-titlebar-name">ZtidalCode</span>
        {/* What it is for, beside what it is called. The product name
            deliberately does not carry xAI's mark; saying which agent it
            drives is a description, and belongs here rather than in the
            name. */}
        <span className="windows-titlebar-tag">for Grok Build</span>
      </div>

      <div className="windows-settings" ref={settingsRef}>
        <button
          className="desktop-settings-trigger windows-settings-trigger"
          type="button"
          ref={settingsTriggerRef}
          aria-label="Settings"
          title="Settings"
          aria-expanded={settingsOpen}
          aria-haspopup="dialog"
          aria-controls={settingsOpen ? settingsPanelId : undefined}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <SettingsGearIcon />
        </button>
        {settingsOpen ? (
          <DesktopSettingsPanel
            className="windows-settings-menu"
            id={settingsPanelId}
            version={version}
            updateBusy={busy}
            onCheckUpdate={onCheckUpdate}
            onClose={closeSettingsAndRestoreFocus}
            onWindowError={onWindowError}
          />
        ) : null}
      </div>

      {status ? (
        <span
          className={`windows-update-status is-${checkStatus}`}
          role="status"
          aria-live="polite"
        >
          {status}
        </span>
      ) : null}

      <div className="windows-titlebar-spacer" data-tauri-drag-region />

      <div className="windows-titlebar-actions">
        <div className="windows-window-controls" aria-label="Window controls">
          <button
            type="button"
            className="windows-window-control"
            aria-label="Minimize"
            onClick={() =>
              invokeWindowCommand("minimize", () =>
                getCurrentWindow().minimize(),
              )
            }
          >
            <span className="windows-control-minimize" aria-hidden />
          </button>
          <button
            type="button"
            className="windows-window-control"
            aria-label="Maximize or restore"
            onClick={() =>
              invokeWindowCommand("maximize", () =>
                getCurrentWindow().toggleMaximize(),
              )
            }
          >
            <span className="windows-control-maximize" aria-hidden />
          </button>
          <button
            type="button"
            className="windows-window-control windows-window-control-close"
            aria-label="Close"
            onClick={() =>
              invokeWindowCommand("close", () => getCurrentWindow().close())
            }
          >
            <span className="windows-control-close" aria-hidden />
          </button>
        </div>
      </div>
    </header>
  );
}
