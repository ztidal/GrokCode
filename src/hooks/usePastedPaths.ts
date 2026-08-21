import { useCallback } from "react";
import { clipboardFilePaths, savePastedImage } from "../api";

/**
 * A path the agent will read, written so a shell-shaped prompt survives it.
 *
 * Quoted only when it has to be: an unquoted path is easier to read, and most
 * of them have no spaces. Double quotes rather than single, because Windows
 * paths are what this handles and `cmd` does not know single ones.
 */
export function quotePath(path: string): string {
  return /[\s"]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

/** One or more paths as they should land in the composer. */
export function formatPathsForPrompt(paths: readonly string[]): string {
  return paths.map(quotePath).join(" ");
}

/** Base64 without a per-byte string concat, which chokes on a full screenshot. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Whether a paste carries files rather than text.
 *
 * Has to be answerable synchronously: `preventDefault` cannot wait for an
 * `await`, and the DataTransfer is not valid after one either. The browser will
 * say *that* there are files while refusing to say *which* — which is the whole
 * reason the host is asked next.
 */
export function pasteCarriesFiles(data: DataTransfer | null): boolean {
  if (!data) return false;
  return Array.from(data.types ?? []).includes("Files");
}

/**
 * Paste files and screenshots into the composer as paths.
 *
 * Files copied in Explorer are **not** copied again: they already exist, and
 * the agent reads outside the working directory, so their own path is the whole
 * job. A screenshot is the one case with no file behind it — only then is
 * anything written, and then into our own directory rather than a project.
 *
 * Text pastes are left entirely alone; the textarea has always handled those
 * and intercepting them would only add a way to get it wrong.
 */
export function usePastedPaths(insert: (snippet: string) => void) {
  return useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const data = event.clipboardData;
      if (!pasteCarriesFiles(data)) return;
      event.preventDefault();

      // Read the blob now: after the first await this DataTransfer is empty.
      const image =
        Array.from(data.items ?? []).find(
          (item) => item.kind === "file" && item.type.startsWith("image/"),
        ) ?? null;
      const file = image?.getAsFile() ?? null;

      void (async () => {
        // Explorer files first — a screenshot has no paths, so an empty answer
        // is what tells the two apart.
        const paths = await clipboardFilePaths().catch(() => [] as string[]);
        if (paths.length > 0) {
          insert(formatPathsForPrompt(paths));
          return;
        }
        if (!file) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const saved = await savePastedImage(
          toBase64(bytes),
          file.type || "image/png",
        ).catch(() => null);
        if (saved) insert(quotePath(saved));
      })();
    },
    [insert],
  );
}
