import { useCallback, useState } from "react";
import type { PromptQueueState, TimelineItem } from "../types";

/**
 * A prompt you have submitted that has not shown up in the stream yet.
 *
 * Between pressing enter and grok acknowledging, the text exists nowhere: the
 * composer has cleared, grok has not echoed it back, and — mid-turn — its queue
 * has not reported it either. That gap is one round trip long and reads as the
 * message having been swallowed. These stand in for it until the real thing
 * arrives, and are retired the moment it does.
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
 * Without a window, a message sent twice in a session would match the first
 * send's echo and the second placeholder would never appear.
 */
const ECHO_SKEW_MS = 2000;

/**
 * How long a submission may go unacknowledged before we stop claiming it is on
 * its way.
 *
 * `AgentManager::prompt` returns `accepted: true` as soon as it has handed the
 * text to a worker, before the RPC is attempted, so the send's promise resolves
 * whether or not the prompt ever reaches grok — there is no failure to catch.
 * Silence past this point is the only signal a send was lost, and a row that
 * claims to be waiting forever is worse than one that goes away.
 */
const ACK_TIMEOUT_MS = 60_000;

/** Whitespace-insensitive identity; grok re-flows what it echoes. */
export function promptKey(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * The submissions this session is still standing in for.
 *
 * Accounting is per occurrence rather than by presence: sending "continue"
 * while an earlier "continue" is still queued has to leave two rows, so each
 * queue entry, running prompt and echo can settle exactly one placeholder.
 */
export function unresolvedPending(
  pending: PendingPrompt[],
  items: TimelineItem[],
  queue: PromptQueueState | null,
  sessionId: string | null,
  now: number,
): PendingPrompt[] {
  const mine = pending.filter((item) => item.sessionId === sessionId);
  if (!mine.length) return mine;

  const credits = new Map<string, number>();
  const credit = (text: string | null | undefined) => {
    if (!text) return;
    const key = promptKey(text);
    credits.set(key, (credits.get(key) ?? 0) + 1);
  };
  for (const entry of queue?.entries ?? []) {
    credit(entry.text);
    // grok may merge adjacent submissions into one entry; each message it
    // swallowed still has a placeholder waiting to be settled.
    for (const part of entry.combinedTexts ?? []) credit(part);
  }
  credit(queue?.runningText);
  for (const part of queue?.runningCombinedTexts ?? []) credit(part);

  const spentEchoes = new Set<string>();
  const unresolved: PendingPrompt[] = [];
  for (const item of [...mine].sort((a, b) => a.ts - b.ts)) {
    if (now - item.ts > ACK_TIMEOUT_MS) continue;

    const key = promptKey(item.text);
    const owed = credits.get(key) ?? 0;
    if (owed > 0) {
      credits.set(key, owed - 1);
      continue;
    }

    const echo = items.find(
      (candidate) =>
        candidate.kind === "user" &&
        !candidate.pending &&
        !spentEchoes.has(candidate.id) &&
        candidate.ts >= item.ts - ECHO_SKEW_MS &&
        promptKey(candidate.detail ?? candidate.title ?? "") === key,
    );
    if (echo) {
      spentEchoes.add(echo.id);
      continue;
    }

    unresolved.push(item);
  }
  return unresolved;
}

/**
 * The timeline plus everything submitted but not yet run, in the order it will
 * run. Composed for display only — the underlying item list stays untouched so
 * turn status and filters keep counting real events.
 *
 * These rows carry no timestamp. Nothing has happened yet, and a clock on them
 * would have to be sampled per render: the memo above this recomputes on every
 * streamed chunk, so the time would visibly crawl while the agent worked.
 */
export function composeTimelineTail(
  items: TimelineItem[],
  unresolved: PendingPrompt[],
  queue: PromptQueueState | null,
  handleId: string,
  sessionId: string | null,
): TimelineItem[] {
  const entries = queue?.entries ?? [];
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
      ts: 0,
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
      ts: 0,
      pending: { state: item.queued ? "queued" : "sending" },
    });
  }
  return [...items, ...tail];
}

export interface PendingPromptsController {
  pending: PendingPrompt[];
  /** Show this text at the tail until grok accounts for it. */
  remember: (sessionId: string, text: string, queued: boolean) => string;
  /**
   * Forget placeholders that are finished with — settled, timed out, or sent
   * from a path that failed before dispatch.
   *
   * Retiring matters as much as showing: resolution is re-derived from the
   * loaded timeline window, so a placeholder left in the store comes back the
   * moment its echo scrolls out of that window.
   */
  retire: (ids: string[]) => void;
  /**
   * Drop everything this task is still standing in for, because a prompt it
   * dispatched came back an error.
   *
   * Settled placeholders are already gone by the time this runs, so whatever
   * remains is a message that will never be echoed and never be queued.
   */
  retireSession: (sessionId: string) => void;
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

  const retire = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const drop = new Set(ids);
    setPending((previous) => {
      const next = previous.filter((item) => !drop.has(item.id));
      return next.length === previous.length ? previous : next;
    });
  }, []);

  const retireSession = useCallback((sessionId: string) => {
    setPending((previous) => {
      const next = previous.filter((item) => item.sessionId !== sessionId);
      return next.length === previous.length ? previous : next;
    });
  }, []);

  return { pending, remember, retire, retireSession };
}
