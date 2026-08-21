import { useCallback, useState } from "react";
import type { PromptQueueState, TimelineItem } from "../types";

/**
 * A prompt you have submitted that has not shown up in the stream yet.
 *
 * Between pressing enter and grok acknowledging, the text exists nowhere: the
 * composer has cleared, grok has not echoed it back, and — mid-turn — its queue
 * has not reported it either. That gap is one round trip long and reads as the
 * message having been swallowed. These stand in for it until the real thing
 * arrives, and are dropped the moment it does.
 */
export interface PendingPrompt {
  id: string;
  sessionId: string;
  text: string;
  ts: number;
  /** True when a turn was already running, so grok will queue rather than run it. */
  queued: boolean;
}

/**
 * How far back an echo may sit and still be read as this prompt's own.
 *
 * Without a window, sending the same text twice in a session would match the
 * first send's echo and the second placeholder would never appear.
 */
const ECHO_SKEW_MS = 2000;

/** Whitespace-insensitive identity; grok re-flows what it echoes. */
export function promptKey(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** True once the stream or the queue accounts for this prompt. */
export function isPendingResolved(
  pending: PendingPrompt,
  items: TimelineItem[],
  queue: PromptQueueState | null,
): boolean {
  const key = promptKey(pending.text);
  if ((queue?.entries ?? []).some((entry) => promptKey(entry.text) === key)) {
    return true;
  }
  if (queue?.runningText && promptKey(queue.runningText) === key) return true;
  return items.some(
    (item) =>
      item.kind === "user" &&
      item.ts >= pending.ts - ECHO_SKEW_MS &&
      promptKey(item.detail ?? item.title ?? "") === key,
  );
}

/**
 * The timeline plus everything submitted but not yet run, in the order it will
 * run. Composed for display only — the underlying item list stays untouched so
 * turn status and filters keep counting real events.
 */
export function composeTimelineTail(
  items: TimelineItem[],
  pending: PendingPrompt[],
  queue: PromptQueueState | null,
  handleId: string,
  sessionId: string | null,
  now: number,
): TimelineItem[] {
  const entries = queue?.entries ?? [];
  const unresolved = pending.filter(
    (item) => !isPendingResolved(item, items, queue),
  );
  if (!entries.length && !unresolved.length) return items;

  const tail: TimelineItem[] = [];
  for (const entry of entries) {
    tail.push({
      id: `queued-${entry.id}`,
      handleId,
      sessionId,
      kind: "user",
      title: "",
      detail: entry.text,
      ts: now + tail.length,
      pending: { state: "queued", entry },
    });
  }
  for (const item of unresolved) {
    tail.push({
      id: `pending-${item.id}`,
      handleId,
      sessionId,
      kind: "user",
      title: "",
      detail: item.text,
      ts: now + tail.length,
      pending: { state: item.queued ? "queued" : "sending" },
    });
  }
  return [...items, ...tail];
}

export interface PendingPromptsController {
  pending: PendingPrompt[];
  /** Show this text at the tail until grok accounts for it. */
  remember: (sessionId: string, text: string, queued: boolean) => string;
  /** Drop a placeholder whose send failed — nothing will ever echo it. */
  forget: (id: string) => void;
}

export function usePendingPrompts(): PendingPromptsController {
  const [pending, setPending] = useState<PendingPrompt[]>([]);

  const remember = useCallback(
    (sessionId: string, text: string, queued: boolean) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setPending((previous) => [
        ...previous.slice(-16),
        { id, sessionId, text, ts: Date.now(), queued },
      ]);
      return id;
    },
    [],
  );

  const forget = useCallback((id: string) => {
    setPending((previous) => previous.filter((item) => item.id !== id));
  }, []);

  return { pending, remember, forget };
}
