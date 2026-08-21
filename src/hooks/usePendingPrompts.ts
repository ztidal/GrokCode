import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import type {
  AgentUpdateEvent,
  PromptQueueState,
  TimelineItem,
} from "../types";

/**
 * The message you have just submitted, until grok says something about it.
 *
 * Between pressing enter and grok acknowledging, the text exists nowhere: the
 * composer has cleared, grok has not echoed it back, and — mid-turn — its queue
 * has not reported it either. That gap is one round trip long and reads as the
 * message having been swallowed.
 *
 * There is at most one of these per task, and it is deliberately dumb: it does
 * not try to work out *which* message grok is talking about. An earlier version
 * matched placeholders to queue entries and echoes by text, with per-occurrence
 * accounting and recency windows, and every one of those rules had a way to
 * settle the wrong message or the same one twice. Any word from grok about this
 * task means the round trip is over and the real rows have taken over, which is
 * the only thing this needs to know.
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
 * How long a submission may go unacknowledged before we stop claiming it is on
 * its way.
 *
 * `AgentManager::prompt` answers `accepted: true` as soon as it has handed the
 * text to a worker, before the RPC is attempted, so the send's promise resolves
 * whether or not the prompt reaches grok. When the transport dies mid-dispatch
 * not even a failure event is emitted. Silence past this point is the only
 * signal left, and a row that claims to be waiting forever is worse than none.
 */
export const ACK_TIMEOUT_MS = 45_000;

/**
 * Whether this submission is still the only sign of itself.
 *
 * `ackAt` is when grok last said anything about this task's queue; an echoed
 * user message is the other way a submission stops being invisible. Either one
 * means the real rows are carrying the message now.
 */
export function isStillPending(
  pending: PendingPrompt | null,
  items: TimelineItem[],
  ackAt: number,
  now: number,
): boolean {
  if (!pending) return false;
  if (now - pending.ts > ACK_TIMEOUT_MS) return false;
  if (ackAt > pending.ts) return false;
  return !items.some(
    (item) => item.kind === "user" && !item.pending && item.ts > pending.ts,
  );
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
  pending: PendingPrompt | null,
  queue: PromptQueueState | null,
  handleId: string,
  sessionId: string | null,
): TimelineItem[] {
  const entries = queue?.entries ?? [];
  if (!entries.length && !pending) return items;

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
  if (pending) {
    tail.push({
      id: `pending-${pending.id}`,
      handleId,
      sessionId,
      kind: "user",
      title: "",
      detail: pending.text,
      ts: 0,
      pending: { state: pending.queued ? "queued" : "sending" },
    });
  }
  return [...items, ...tail];
}

export interface PendingPromptsController {
  /** The outstanding submission per task, and when grok last spoke about it. */
  pendingFor: (sessionId: string | null) => PendingPrompt | null;
  ackFor: (sessionId: string | null) => number;
  /** Show this text at the tail until grok says anything about this task. */
  remember: (sessionId: string, text: string, queued: boolean) => void;
  /** Drop this task's placeholder — settled, timed out, or never dispatched. */
  retire: (sessionId: string | null) => void;
}

export function usePendingPrompts(): PendingPromptsController {
  const [pending, setPending] = useState<Map<string, PendingPrompt>>(
    () => new Map(),
  );
  const [acks, setAcks] = useState<Map<string, number>>(() => new Map());

  // Any queue update is grok speaking about this task, whatever it says.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<AgentUpdateEvent>("agent-notification", ({ payload }) => {
      if (cancelled || payload.method !== "x.ai/queue/changed") return;
      const sessionId =
        payload.sessionId ?? (payload.params?.sessionId as string | undefined);
      if (!sessionId) return;
      setAcks((previous) => new Map(previous).set(sessionId, Date.now()));
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const remember = useCallback(
    (sessionId: string, text: string, queued: boolean) => {
      setPending((previous) =>
        new Map(previous).set(sessionId, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId,
          text,
          ts: Date.now(),
          queued,
        }),
      );
    },
    [],
  );

  const retire = useCallback((sessionId: string | null) => {
    if (!sessionId) return;
    setPending((previous) => {
      if (!previous.has(sessionId)) return previous;
      const next = new Map(previous);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const pendingFor = useCallback(
    (sessionId: string | null) =>
      sessionId ? (pending.get(sessionId) ?? null) : null,
    [pending],
  );
  const ackFor = useCallback(
    (sessionId: string | null) => (sessionId ? (acks.get(sessionId) ?? 0) : 0),
    [acks],
  );

  return { pendingFor, ackFor, remember, retire };
}
