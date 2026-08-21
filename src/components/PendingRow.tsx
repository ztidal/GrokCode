import { memo, useState } from "react";
import type { PromptQueueController } from "../hooks/usePromptQueueController";
import type { TimelineItem } from "../types";
import { moveQueuedPromptIds } from "../utils/promptQueue";
import { TimelineRowChrome } from "./TimelineRow";

/**
 * A message you have submitted that has not run yet, shown in the stream where
 * it will run rather than in a panel underneath it.
 *
 * Until grok reports it there is nothing to act on, so the row is text and a
 * label; once its queue entry arrives the same row gains the controls, and the
 * message never moves or reappears.
 */
export const PendingRow = memo(function PendingRow({
  item,
  stackClass,
  controller,
}: {
  item: TimelineItem;
  stackClass: string;
  controller?: PromptQueueController;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const entry = item.pending?.entry;
  const entries = controller?.queue?.entries ?? [];
  const index = entry ? entries.findIndex((e) => e.id === entry.id) : -1;

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch {
      // App owns the visible error banner; leave the row as it is.
    } finally {
      setBusy(false);
    }
  }

  const editing = draft !== null;
  const label =
    item.pending?.state === "queued"
      ? index >= 0
        ? `Queued · ${index + 1}`
        : "Queued"
      : "Sending…";

  return (
    <TimelineRowChrome kind="user" ts={item.ts} stackClass={stackClass}>
      <div className="tl-pending">
        <span
          className={`tl-pending-badge${entry ? "" : " is-waiting"}`}
          title={
            entry
              ? "Runs after the current turn finishes"
              : "Handing this to the agent…"
          }
        >
          {label}
        </span>
        {editing && entry ? (
          <textarea
            className="tl-pending-edit"
            rows={2}
            value={draft}
            autoFocus
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft(null);
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                const text = draft.trim();
                if (!text || !controller) return;
                void run(async () => {
                  await controller.edit(entry, text);
                  setDraft(null);
                });
              }
            }}
          />
        ) : (
          <div className="tl-pending-text">{item.detail}</div>
        )}
      </div>
      {entry && controller && (
        <div className="tl-pending-actions">
          {editing ? (
            <>
              <button
                type="button"
                className="queue-text-btn"
                disabled={busy || !draft?.trim()}
                onClick={() =>
                  void run(async () => {
                    await controller.edit(entry, draft!.trim());
                    setDraft(null);
                  })
                }
              >
                Save
              </button>
              <button
                type="button"
                className="queue-text-btn"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="queue-icon-btn"
                title="Move up"
                aria-label="Move queued prompt up"
                disabled={busy || index <= 0}
                onClick={() => {
                  const ids = moveQueuedPromptIds(entries, index, -1);
                  if (ids) void run(() => controller.reorder(ids));
                }}
              >
                ↑
              </button>
              <button
                type="button"
                className="queue-icon-btn"
                title="Move down"
                aria-label="Move queued prompt down"
                disabled={busy || index < 0 || index === entries.length - 1}
                onClick={() => {
                  const ids = moveQueuedPromptIds(entries, index, 1);
                  if (ids) void run(() => controller.reorder(ids));
                }}
              >
                ↓
              </button>
              <button
                type="button"
                className="queue-text-btn"
                disabled={busy}
                onClick={() => setDraft(entry.text)}
              >
                Edit
              </button>
              <button
                type="button"
                className="queue-text-btn accent"
                disabled={busy}
                title="Interrupt the current turn and run this now"
                onClick={() => void run(() => controller.interject(entry))}
              >
                Send now
              </button>
              <button
                type="button"
                className="queue-text-btn danger"
                disabled={busy}
                onClick={() => void run(() => controller.remove(entry))}
              >
                Remove
              </button>
            </>
          )}
        </div>
      )}
    </TimelineRowChrome>
  );
});
