import { useCallback, useState } from "react";
import { clipboardFilePaths, readImagePreview, savePastedImage } from "../api";

/** One thing waiting to be sent with the next prompt. */
export interface Attachment {
  /** Stable across re-renders so a removal cannot take the wrong chip. */
  id: string;
  /** What the agent will be pointed at. */
  path: string;
  /** Basename, for the chip. */
  name: string;
  /** A `data:` URL when there is a picture to show, else null. */
  preview: string | null;
}

/**
 * A path the agent will read, written so a shell-shaped prompt survives it.
 *
 * Quoted only when it has to be: an unquoted path is easier to read, and most
 * have no spaces. Double quotes rather than single, because these are Windows
 * paths and `cmd` does not know single ones.
 */
export function quotePath(path: string): string {
  return /[\s"]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

/** The last segment of a path, whichever separator it uses. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The text that actually goes to the agent.
 *
 * The paths are appended rather than left inline, because the chips are now the
 * interface: someone who removes a chip expects the file to be gone from the
 * message, and a path they never typed sitting in their sentence is a path they
 * would have to delete by hand.
 */
export function composePrompt(
  text: string,
  attachments: readonly Attachment[],
): string {
  const trimmed = text.trim();
  if (attachments.length === 0) return trimmed;
  const header = attachments.length === 1 ? "Attached file:" : "Attached files:";
  const list = attachments.map((a) => `- ${quotePath(a.path)}`).join("\n");
  return trimmed ? `${trimmed}\n\n${header}\n${list}` : `${header}\n${list}`;
}

/**
 * Whether a paste carries files rather than text.
 *
 * Has to be answerable synchronously: `preventDefault` cannot wait for an
 * `await`, and the DataTransfer is empty after one. The browser will say *that*
 * there are files while refusing to say *which* — which is the whole reason the
 * host is asked next.
 */
export function pasteCarriesFiles(data: DataTransfer | null): boolean {
  if (!data) return false;
  return Array.from(data.types ?? []).includes("Files");
}

/**
 * Paths to add that are not already in the list, in the order they arrived.
 * Explorer can drop the same file twice; the chip is unique per path.
 */
export function mergeAttachmentPaths(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  const seen = new Set(existing);
  const extra: string[] = [];
  for (const raw of incoming) {
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    extra.push(path);
  }
  return extra;
}

/** CSS-pixel hit test. Tauri drop coordinates are physical; divide by DPR. */
export function pointInRect(
  x: number,
  y: number,
  rect: { left: number; top: number; right: number; bottom: number },
): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function physicalPointInElement(
  position: { x: number; y: number },
  element: Pick<Element, "getBoundingClientRect"> | null,
  devicePixelRatio = 1,
): boolean {
  if (!element) return false;
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const rect = element.getBoundingClientRect();
  return pointInRect(position.x / scale, position.y / scale, rect);
}

/** Base64 without a per-byte concat, which chokes on a full screenshot. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

let nextId = 0;
const makeId = () => `att-${++nextId}`;

export interface AttachmentsApi {
  items: Attachment[];
  /** Paste handler for the composer's textarea. */
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Absolute paths from an OS file drop (Explorer → composer). */
  addPaths: (paths: readonly string[]) => void;
  remove: (id: string) => void;
  clear: () => void;
}

/**
 * Files and screenshots waiting to go with the next prompt.
 *
 * Files copied in Explorer are **not** copied again: they exist already, and
 * the agent reads outside the working directory, so their own path is the whole
 * job. A screenshot is the one case with no file behind it, so it is the only
 * one that writes anything — into our own directory, never a project.
 *
 * Thumbnails come from two places for one reason: a pasted screenshot is
 * already in hand as bytes, so it costs nothing to show, while a file on disk
 * has to be read by the host — the webview cannot open a path it was never
 * given.
 */
export function useAttachments(): AttachmentsApi {
  const [items, setItems] = useState<Attachment[]>([]);

  const remove = useCallback((id: string) => {
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const addPaths = useCallback((paths: readonly string[]) => {
    void (async () => {
      const unique = mergeAttachmentPaths([], paths);
      if (unique.length === 0) return;
      const added = await Promise.all(
        unique.map(async (path) => ({
          id: makeId(),
          path,
          name: baseName(path),
          preview: await readImagePreview(path).catch(() => null),
        })),
      );
      setItems((previous) => {
        const extra = mergeAttachmentPaths(
          previous.map((item) => item.path),
          added.map((item) => item.path),
        );
        if (extra.length === 0) return previous;
        const byPath = new Map(added.map((item) => [item.path, item]));
        return [
          ...previous,
          ...extra.map((path) => byPath.get(path)!),
        ];
      });
    })();
  }, []);

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const data = event.clipboardData;
      if (!pasteCarriesFiles(data)) return;
      event.preventDefault();

      // Read the blob now: after the first await this DataTransfer is empty.
      const item =
        Array.from(data.items ?? []).find(
          (i) => i.kind === "file" && i.type.startsWith("image/"),
        ) ?? null;
      const file = item?.getAsFile() ?? null;

      void (async () => {
        // Explorer files first — a screenshot has no paths, so an empty answer
        // is what tells the two apart.
        const paths = await clipboardFilePaths().catch(() => [] as string[]);
        if (paths.length > 0) {
          const added = await Promise.all(
            paths.map(async (path) => ({
              id: makeId(),
              path,
              name: baseName(path),
              preview: await readImagePreview(path).catch(() => null),
            })),
          );
          setItems((previous) => [...previous, ...added]);
          return;
        }

        if (!file) return;
        const bytes = new Uint8Array(await file.arrayBuffer());
        const base64 = toBase64(bytes);
        const mime = file.type || "image/png";
        const path = await savePastedImage(base64, mime).catch(() => null);
        if (!path) return;
        setItems((previous) => [
          ...previous,
          {
            id: makeId(),
            path,
            name: baseName(path),
            // Already in hand — no reason to ask the host to read it back.
            preview: `data:${mime};base64,${base64}`,
          },
        ]);
      })();
    },
    [],
  );

  return { items, onPaste, addPaths, remove, clear };
}
