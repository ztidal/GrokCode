import { memo, useEffect, useRef } from "react";
import type { PromptQueueController } from "../hooks/usePromptQueueController";
import type { TimelineItem } from "../types";
import { moveQueuedPromptIds } from "../utils/promptQueue";
import { TimelineRowChrome } from "./TimelineRow";

/**
 * State the rows share, held by their owner.
 *
 * Queued rows sit at the tail and the virtualiser unmounts them as soon as they
 * scroll out of view, so an edit kept inside a row would be discarded without
 * saying so. The interlock is shared for a different reason: reorder sends a
 * whole-queue ordering, and two rows acting at once would each compute one from
 * the same stale list.
 */
export interface QueueRowUi {
  draft: { id: string; text: string; focused?: boolean } | null;
  setDraft: (
    draft: { id: string; text: string; focused?: boolean } | null,
  ) => void;
  busyKey: string | null;
  setBusyKey: (key: string | null) => void;
}

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
  ui,
}: {
  item: TimelineItem;
  stackClass: string;
  controller?: PromptQueueController;
  ui?: QueueRowUi;
}) {
  const entry = item.pending?.entry;
  const entries = controller?.queue?.entries ?? [];
  const index = entry ? entries.findIndex((e) => e.id === entry.id) : -1;
  const editing = Boolean(entry && ui?.draft && ui.draft.id === entry.id);
  const text = ui?.draft?.text ?? "";
  const locked = Boolean(ui?.busyKey);

  // Focused once, by the draft rather than by the element. The virtualiser
  // remounts this row whenever it scrolls back into view, and `autoFocus` would
  // take the caret away from wherever it had moved on to.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing || !ui?.draft || ui.draft.focused) return;
    inputRef.current?.focus();
    ui.setDraft({ ...ui.draft, focused: true });
  }, [editing, ui]);

  async function run(key: string, action: () => Promise<void>) {
    if (!ui || ui.busyKey) return;
    ui.setBusyKey(key);
    try {
      await action();
      // Deliberately still locked: the owner releases it when grok's queue
      // catches up, so the next action cannot build an ordering from a
      // snapshot that has not caught up yet.
    } catch {
      // App owns the visible error banner; give the controls back.
      ui.setBusyKey(null);
    }
  }

  async function save() {
    const next = text.trim();
    if (!next || !entry || !controller) return;
    await run(entry.id, async () => {
      await controller.edit(entry, next);
      ui?.setDraft(null);
    });
  }

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
            ref={inputRef}
            rows={2}
            value={text}
            disabled={locked}
            onChange={(event) =>
              ui?.setDraft({ id: entry.id, text: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") ui?.setDraft(null);
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void save();
              }
            }}
          />
        ) : (
          <div className="tl-pending-text">{item.detail}</div>
        )}
      </div>
      {entry && controller && ui && (
        <div className="tl-pending-actions">
          {editing ? (
            <>
              <button
                type="button"
                className="queue-text-btn"
                disabled={locked || !text.trim()}
                onClick={() => void save()}
              >
                Save
              </button>
              <button
                type="button"
                className="queue-text-btn"
                onClick={() => ui.setDraft(null)}
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
                disabled={locked || index <= 0}
                onClick={() => {
                  const ids = moveQueuedPromptIds(entries, index, -1);
                  if (ids) void run(entry.id, () => controller.reorder(ids));
                }}
              >
                ↑
              </button>
              <button
                type="button"
                className="queue-icon-btn"
                title="Move down"
                aria-label="Move queued prompt down"
                disabled={locked || index < 0 || index === entries.length - 1}
                onClick={() => {
                  const ids = moveQueuedPromptIds(entries, index, 1);
                  if (ids) void run(entry.id, () => controller.reorder(ids));
                }}
              >
                ↓
              </button>
              <button
                type="button"
                className="queue-text-btn"
                disabled={locked}
                onClick={() => ui.setDraft({ id: entry.id, text: entry.text })}
              >
                Edit
              </button>
              <button
                type="button"
                className="queue-text-btn accent"
                disabled={locked}
                title="Interrupt the current turn and run this now"
                onClick={() => void run(entry.id, () => controller.interject(entry))}
              >
                Send now
              </button>
              <button
                type="button"
                className="queue-text-btn danger"
                disabled={locked}
                onClick={() => void run(entry.id, () => controller.remove(entry))}
              >
                Remove
              </button>
              {/* Emptying a long queue one round trip at a time is its own
                  chore, so the first row carries the bulk action. */}
              {index === 0 && entries.length > 1 && (
                <button
                  type="button"
                  className="queue-text-btn danger"
                  title={`Remove all ${entries.length} queued prompts`}
                  disabled={locked}
                  onClick={() => void run("clear", () => controller.clear())}
                >
                  Clear all
                </button>
              )}
            </>
          )}
        </div>
      )}
    </TimelineRowChrome>
  );
});
