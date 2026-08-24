import React from "react";
import ReactDOM from "react-dom/client";
import { initTheme } from "./theme";
import { isMacosDesktop } from "./utils/platform";

// Before anything renders: a stamp that lands after first paint flashes the OS
// theme at anyone whose choice disagrees with it.
initTheme();

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error('Missing root element: expected <div id="root"> in index.html');
}
const root: HTMLElement = rootEl;

async function isPetOverlayWindow(): Promise<boolean> {
  if (new URLSearchParams(window.location.search).get("overlay") === "pet") {
    return true;
  }
  // Query string can be dropped when Tauri resolves WebviewUrl::App; the
  // window label is the durable signal.
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label === "pet";
  } catch {
    return false;
  }
}

async function boot() {
  if (await isPetOverlayWindow()) {
    document.getElementById("boot-splash")?.remove();
    document.documentElement.classList.add("pet-overlay");
    const { PetOverlay } = await import("./pet/PetOverlay");
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <PetOverlay />
      </React.StrictMode>,
    );
    return;
  }

  // macOS Overlay titlebar: pad left rail for traffic lights + drag strip.
  if (isMacosDesktop()) {
    document.documentElement.classList.add("platform-macos-desktop");
  }

  const { default: App } = await import("./App");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  // Drop the HTML boot splash once React has painted the shell.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const splash = document.getElementById("boot-splash");
      if (!splash) return;
      splash.classList.add("done");
      window.setTimeout(() => splash.remove(), 220);
    });
  });
}

void boot();
