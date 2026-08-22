import { useState } from "react";
import { openNewWindow } from "../api";
import { ThemeToggle } from "./ThemeToggle";

/** One icon implementation for every desktop Settings entry point. */
export function SettingsGearIcon() {
  return (
    <svg
      className="settings-gear-icon"
      viewBox="0 0 20 20"
      width="17"
      height="17"
      aria-hidden
    >
      <path d="M8.7 2.1h2.6l.5 1.8c.4.2.8.4 1.2.7l1.8-.5 1.3 2.2-1.3 1.3c.1.5.1.9 0 1.4l1.3 1.3-1.3 2.2-1.8-.5c-.4.3-.8.5-1.2.7l-.5 1.8H8.7l-.5-1.8c-.4-.2-.8-.4-1.2-.7l-1.8.5-1.3-2.2L5.2 9c-.1-.5-.1-.9 0-1.4L3.9 6.3l1.3-2.2 1.8.5c.4-.3.8-.5 1.2-.7l.5-1.8Z" />
      <circle cx="10" cy="8.3" r="2.3" />
    </svg>
  );
}

export interface DesktopSettingsPanelProps {
  version: string | null;
  updateBusy: boolean;
  onCheckUpdate: () => void;
  onClose: () => void;
  onWindowError: (message: string) => void;
  className?: string;
  id?: string;
}

/** The shared Settings menu body used by both macOS and Windows chrome. */
export function DesktopSettingsPanel({
  version,
  updateBusy,
  onCheckUpdate,
  onClose,
  onWindowError,
  className,
  id,
}: DesktopSettingsPanelProps) {
  const [openingWindow, setOpeningWindow] = useState(false);

  const openWindow = async () => {
    setOpeningWindow(true);
    try {
      await openNewWindow();
      onClose();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      onWindowError(`Failed to open a new window: ${detail}`);
    } finally {
      setOpeningWindow(false);
    }
  };

  return (
    <div
      className={`desktop-settings-panel${className ? ` ${className}` : ""}`}
      id={id}
      role="dialog"
      aria-label="Settings"
    >
      <button
        className="desktop-settings-item"
        type="button"
        autoFocus
        disabled={openingWindow}
        onClick={() => {
          void openWindow();
        }}
      >
        <span>New Window</span>
        {openingWindow ? (
          <span className="desktop-settings-item-status">Opening…</span>
        ) : null}
      </button>
      <div className="desktop-settings-separator" aria-hidden />
      <button
        className="desktop-settings-item"
        type="button"
        disabled={updateBusy}
        onClick={() => {
          onCheckUpdate();
          onClose();
        }}
      >
        <span>Check for Updates</span>
      </button>
      <div className="desktop-settings-separator" aria-hidden />
      <ThemeToggle />
      <div className="desktop-settings-separator" aria-hidden />
      <div className="desktop-settings-version">
        <span>Current version</span>
        <span>{version ? `v${version}` : "—"}</span>
      </div>
    </div>
  );
}
