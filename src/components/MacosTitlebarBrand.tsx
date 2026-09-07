import logoMark from "../assets/logo.png";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { UpdateCheckStatus } from "../hooks/useAppUpdate";
import { useAppVersion } from "../hooks/useAppVersion";
import { isMacosDesktop } from "../utils/platform";
import {
  closeDesktopSettings,
  DesktopSettingsPanel,
  SettingsGearIcon,
  toggleDesktopSettings,
} from "./DesktopSettings";

const STATUS_LINE: Partial<Record<UpdateCheckStatus, string>> = {
  checking: "Checking for updates…",
  "up-to-date": "You're up to date",
  error: "Update check failed",
};

type SettingsShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

/** macOS' conventional application-settings shortcut, with no modifier aliases. */
export function isMacosSettingsShortcut(
  event: SettingsShortcutEvent,
): boolean {
  return (
    event.key === "," &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

/** Independently renderable macOS wrapper around the shared Settings body. */
export function MacosSettingsPanel({
  version,
  updateBusy = false,
  onCheckUpdate = () => {},
  onClose = () => {},
  onWindowError = () => {},
  id,
}: {
  version: string | null;
  updateBusy?: boolean;
  onCheckUpdate?: () => void;
  onClose?: () => void;
  onWindowError?: (message: string) => void;
  id?: string;
}) {
  return (
    <DesktopSettingsPanel
      className="macos-settings-panel"
      version={version}
      updateBusy={updateBusy}
      onCheckUpdate={onCheckUpdate}
      onClose={onClose}
      onWindowError={onWindowError}
      id={id}
    />
  );
}

/**
 * macOS-only Overlay chrome: empty traffic-light strip, brand mark below.
 * Brand click runs a manual update check. Not rendered on Windows / Linux.
 */
export function MacosTitlebarBrand({
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
  const macDesktop = isMacosDesktop();
  const version = useAppVersion(macDesktop);
  const closeSettingsAndRestoreFocus = useCallback(
    () =>
      closeDesktopSettings(
        setSettingsOpen,
        () => settingsTriggerRef.current,
      ),
    [],
  );

  useEffect(() => {
    if (!macDesktop) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isMacosSettingsShortcut(event)) {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (event.key === "Escape" && settingsOpen) {
        event.preventDefault();
        closeSettingsAndRestoreFocus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSettingsAndRestoreFocus, macDesktop, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) {
        closeSettingsAndRestoreFocus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [closeSettingsAndRestoreFocus, settingsOpen]);

  if (!macDesktop) return null;

  const statusLine =
    STATUS_LINE[checkStatus] ?? (version ? `v${version}` : null);
  const busy = checkStatus === "checking";

  return (
    <div
      className="macos-titlebar"
      role="banner"
      aria-label={version ? `GrokCode v${version}` : "GrokCode"}
    >
      {/* Native traffic lights sit here; keep clear + draggable */}
      <div className="macos-titlebar-traffic" data-tauri-drag-region />
      <div className="macos-titlebar-controls">
        <button
          type="button"
          className={`macos-titlebar-brand${
            checkStatus !== "idle" ? ` is-${checkStatus}` : ""
          }`}
          onClick={() => {
            if (!busy) onCheckUpdate();
          }}
          disabled={busy}
          title="Check for updates"
          aria-label="Check for updates"
        >
          <img
            className="macos-titlebar-logo"
            src={logoMark}
            alt=""
            width={22}
            height={22}
            draggable={false}
          />
          <div className="macos-titlebar-copy">
            <span className="macos-titlebar-name text-title-gradient">
              GrokCode
            </span>
            <span className="macos-titlebar-subtitle">
              for Grok Build
            </span>
            {statusLine ? (
              <span className="macos-titlebar-version">{statusLine}</span>
            ) : null}
          </div>
        </button>

        <div className="macos-settings" ref={settingsRef}>
          <button
            type="button"
            className="desktop-settings-trigger macos-settings-trigger"
            ref={settingsTriggerRef}
            aria-label="Settings"
            title="Settings (⌘,)"
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            aria-controls={settingsOpen ? settingsPanelId : undefined}
            onClick={() =>
              toggleDesktopSettings(
                settingsOpen,
                setSettingsOpen,
                () => settingsTriggerRef.current,
              )
            }
          >
            <SettingsGearIcon />
          </button>
          {settingsOpen ? (
            <MacosSettingsPanel
              id={settingsPanelId}
              version={version}
              updateBusy={busy}
              onCheckUpdate={onCheckUpdate}
              onClose={closeSettingsAndRestoreFocus}
              onWindowError={onWindowError}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
