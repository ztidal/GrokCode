import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  TimelineFilterKind,
  TimelineItem,
  ManagedAgentInfo,
} from "../types";
import { writeClipboard } from "../utils/clipboard";
import { extractToolPath } from "../utils/paths";
import {
  isFullKeyReplace,
  prependHeightDelta,
  useVirtualWindow,
  type VirtualScrollMetrics,
} from "../hooks/useVirtualWindow";
import { DiffSnippet } from "./DiffSnippet";
import { FilePathLink } from "./FilePathLink";
import { Markdown } from "./Markdown";
import { ShellCard } from "./ShellPanel";
import { TimelineRowChrome, timelineStackClass } from "./TimelineRow";
import { runEndScroll } from "./endScroll";
import { PendingRow, type QueueRowUi } from "./PendingRow";
import type { PromptQueueController } from "../hooks/usePromptQueueController";

const TIMELINE_FILTER_LABELS: Record<string, string> = {
  all: "All",
  user: "User",
  agent: "Agent",
  thought: "Thought",
  tool: "Tool",
  shell: "Shell",
  subagent: "Subagent",
  task: "Task",
  event: "Event",
  unknown: "Other",
};

const TIMELINE_FILTER_ORDER: TimelineFilterKind[] = [
  "all",
  "user",
  "agent",
  "thought",
  "tool",
  "shell",
  "subagent",
  "task",
  "event",
  "unknown",
];

/**
 * The single definition of "near the bottom". Stick-to-bottom and the
 * jump-to-latest button read it from here so they can never disagree — a
 * second threshold would let the button appear over a timeline that is still
 * auto-scrolling under it. Exported for tests.
 */
export function isNearTimelineBottom(m: VirtualScrollMetrics): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight < 64;
}

/**
 * Actually at the bottom, as opposed to near it.
 *
 * Landing here is what gives a reader their pin back, so it has to mean the
 * bottom and not "close enough" — 2px for a fractional device pixel ratio, and
 * nothing more.
 */
export function isAtTimelineBottom(m: VirtualScrollMetrics): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= 2;
}

/**
 * Viewport-top of the list, in list coordinates, for `--timeline-fade-offset`.
 *
 * `tab-body` is shared across sessions, so a leftover `scrollTop` from a
 * longer stream can sit past the new list. Unclamped, the mask's transparent
 * band covers the whole stream — blank until the next `scroll` event, which
 * WebKit often does not fire when content shrinks.
 */
export function timelineMaskOffset(m: VirtualScrollMetrics): number {
  const maxScroll = Math.max(0, m.scrollHeight - m.clientHeight);
  const scrollTop = Math.min(Math.max(0, m.scrollTop), maxScroll);
  return scrollTop - m.listTop;
}

/** Distance from the list top to `key`, using measured or estimated row heights. */
export function offsetBeforeKey(
  keys: readonly string[],
  key: string,
  heightOf: (key: string) => number,
): number | null {
  let y = 0;
  for (const itemKey of keys) {
    if (itemKey === key) return y;
    y += heightOf(itemKey);
  }
  return null;
}

/**
 * `querySelector` for a row's `data-timeline-id`. Quoted so ids that contain
 * `:` (event-… ids) stay one attribute value; only `"` / `\` are escaped.
 */
export function timelineItemSelector(id: string): string {
  const escaped = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[data-timeline-id="${escaped}"]`;
}

/** The geometry a previous report left behind. */
export interface StreamGeometry {
  scrollTop: number;
  scrollHeight: number;
}

/** Where the view is, and whether the reader put it there. */
export interface StickState {
  pinned: boolean;
  /** The reader left the bottom on purpose and has not come back. */
  escaped: boolean;
}

/**
 * What one metrics report means for following the stream.
 *
 * `useVirtualWindow` reports for two different events — the view moved, or the
 * content resized — and does not say which. Distinguishing them is the whole
 * job here, because a reply being written into pushes the bottom out of reach
 * *before* anything scrolls. Reading that as "they scrolled away" unpins the
 * timeline the instant its own output arrives, and nothing pins it again,
 * because the pin is what does the pinning.
 *
 * Two flags rather than one, because position and intent are different facts
 * and conflating them had a cost: with a single pin re-derived from geometry,
 * scrolling up a little to re-read the last sentence left the view inside the
 * near-bottom band, so it counted as still pinned and the next chunk pulled the
 * reader back down. Re-reading the thing you just watched arrive was not
 * possible. Now any deliberate move up latches `escaped`, the near-bottom band
 * can keep an unescaped pin alive but can never clear an escape, and only
 * landing on the bottom — or asking to go there — gives the pin back.
 *
 * Exported for unit tests: this repository has no DOM to drive, and the rule is
 * worth more than the wiring around it.
 */
export function readStickIntent(
  m: VirtualScrollMetrics,
  previous: StreamGeometry,
  state: StickState,
): StickState & { follow: boolean } {
  const grew = m.scrollHeight > previous.scrollHeight;
  // 1px, because a fractional scroll position is not a decision.
  const movedUp = m.scrollTop < previous.scrollTop - 1;
  // Only under a height that did not change. Content settling shorter clamps
  // scrollTop down and is indistinguishable from a reader scrolling up.
  const settled = m.scrollHeight === previous.scrollHeight;
  const atBottom = isAtTimelineBottom(m);

  const escaped = atBottom ? false : state.escaped || (movedUp && settled);
  const pinned = !escaped && (isNearTimelineBottom(m) || state.pinned);
  return { pinned, escaped, follow: grew && pinned };
}

export function TimelinePanel({
  items,
  managed,
  pinBottomSeq = 0,
  onOpenFile,
  hasMore,
  loadingOlder,
  onLoadOlder,
  queue,
  queueUi,
}: {
  items: TimelineItem[];
  managed: ManagedAgentInfo | null;
  pinBottomSeq?: number;
  onOpenFile?: (path: string) => void;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => Promise<void>;
  /** Present so a submitted-but-not-run row can be edited, moved or run now. */
  queue?: PromptQueueController;
  /** Lifted out of the rows, which the virtualiser unmounts as they scroll away. */
  queueUi?: QueueRowUi;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /** Set when the reader leaves the bottom deliberately; see `readStickIntent`. */
  const escaped = useRef(false);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const filterBarRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<TimelineFilterKind>("all");
  // Rendered mirror of stickToBottom — the ref drives scrolling, this drives paint.
  const [atBottom, setAtBottom] = useState(true);
  const prevKeysRef = useRef<string[]>([]);
  const pendingLocateId = useRef<string | null>(null);
  const itemKeysRef = useRef<string[]>([]);
  const heightOfRef = useRef<(key: string) => number>(() => 0);
  const [locateGen, setLocateGen] = useState(0);
  const [locatedId, setLocatedId] = useState<string | null>(null);

  // Counts describe what happened, so a message still waiting to run is not
  // one of them — it is appended to `items` for display only.
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (item.pending) continue;
      const k = item.kind || "unknown";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const filterChips = useMemo(() => {
    const present = TIMELINE_FILTER_ORDER.filter(
      (k) => k === "all" || (kindCounts.get(k) ?? 0) > 0,
    );
    for (const k of kindCounts.keys()) {
      if (!present.includes(k as TimelineFilterKind)) {
        present.push(k as TimelineFilterKind);
      }
    }
    return present;
  }, [kindCounts]);

  const syncFilterIndicator = useCallback(() => {
    const bar = filterBarRef.current;
    const activeChip = bar?.querySelector<HTMLElement>(
      `[data-filter-kind="${filter}"]`,
    );
    if (!bar || !activeChip) return;

    const activeStyle = getComputedStyle(activeChip);
    bar.style.setProperty("--filter-x", `${activeChip.offsetLeft}px`);
    bar.style.setProperty("--filter-y", `${activeChip.offsetTop}px`);
    bar.style.setProperty("--filter-width", `${activeChip.offsetWidth}px`);
    bar.style.setProperty("--filter-height", `${activeChip.offsetHeight}px`);
    bar.style.setProperty(
      "--filter-indicator-bg",
      activeStyle.getPropertyValue("--chip-bg-active"),
    );
    bar.classList.add("is-indicator-ready");
  }, [filter]);

  useLayoutEffect(() => {
    syncFilterIndicator();
    const bar = filterBarRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncFilterIndicator);
    observer.observe(bar);
    for (const chip of bar.querySelectorAll(".timeline-filter-chip")) {
      observer.observe(chip);
    }
    return () => observer.disconnect();
  }, [filterChips, syncFilterIndicator]);

  useEffect(() => {
    if (filter === "all") return;
    if ((kindCounts.get(filter) ?? 0) === 0) setFilter("all");
  }, [filter, kindCounts]);

  const filtered = useMemo(() => {
    const indexed = items.map((item, sourceIndex) => ({ item, sourceIndex }));
    if (filter === "all") return indexed;
    // A message that has not run survives every filter. It is not history to
    // be sifted, it is the tail of the composer — and its controls are the only
    // way to reorder or cancel it, which a filter should not be able to hide.
    return indexed.filter(
      ({ item }) => Boolean(item.pending) || (item.kind || "unknown") === filter,
    );
  }, [items, filter]);

  const itemKeys = useMemo(
    () => filtered.map(({ item }) => item.id),
    [filtered],
  );

  /**
   * The ref drives scrolling and the state drives paint, so they move together.
   * Writing the ref alone left the jump-to-latest button showing the opposite
   * of the truth, and unrecoverably: the next metrics report found the ref
   * already equal to its own conclusion and skipped the mirror.
   */
  const applyStick = useCallback((next: StickState) => {
    stickToBottom.current = next.pinned;
    escaped.current = next.escaped;
    setAtBottom(next.pinned);
  }, []);

  /**
   * An explicit answer to "should this follow the stream", from a reader who
   * asked — sending, jumping to latest, or paging backwards. Those settle the
   * intent too, which is why they can hand a pin back that a scroll cannot.
   */
  const setStick = useCallback((next: boolean) => {
    stickToBottom.current = next;
    escaped.current = !next;
    setAtBottom(next);
  }, []);

  /*
   * One scroll is not enough, and that is not a bug in the caller.
   *
   * A virtualized list's height is measured rows plus an estimate for every row
   * that has never been rendered — and scrolling is what renders them. So the
   * scroll lands, the rows below get measured, the total grows, and the bottom
   * is now further down than where we stopped. That is why jump-to-latest took
   * several clicks: the convergence was real, the reader was driving it.
   */
  const endScrollStop = useRef<(() => void) | null>(null);
  const scrollToEnd = useCallback((behavior: ScrollBehavior = "auto") => {
    endScrollStop.current?.();
    endScrollStop.current = runEndScroll(
      {
        scrollHeight: () => scrollParentRef.current?.scrollHeight ?? 0,
        scrollToEnd: (pass) => {
          const end = endRef.current;
          const parent = scrollParentRef.current;
          if (end) end.scrollIntoView({ block: "end", behavior: pass });
          else if (parent) parent.scrollTop = parent.scrollHeight;
        },
        stillWanted: () =>
          stickToBottom.current && Boolean(scrollParentRef.current),
        schedule: (step) => window.requestAnimationFrame(step),
        cancel: (handle) => window.cancelAnimationFrame(handle),
      },
      behavior,
    );
  }, []);

  useEffect(() => () => endScrollStop.current?.(), []);

  /** Last reported geometry, to tell a scroll from the content growing. */
  const lastScrollTop = useRef(0);
  const lastScrollHeight = useRef(0);

  /*
   * `useVirtualWindow` owns the single scroll listener, and reports here for two
   * different events: the view moved, or the content resized. It observes the
   * list as well as the scroll parent, so a reply being written into produces a
   * report with nothing scrolled.
   *
   * Telling them apart is the whole job. Growth pushes the bottom out of reach
   * before anything has moved, so reading that as "they scrolled up" unpinned
   * the timeline the instant its own output arrived — and then nothing pinned it
   * again, because the pin was off. Only a view that actually moved up may
   * unpin; growth under a pinned view is followed instead.
   */
  const onScrollMetrics = useCallback((m: VirtualScrollMetrics) => {
    const intent = readStickIntent(
      m,
      { scrollTop: lastScrollTop.current, scrollHeight: lastScrollHeight.current },
      { pinned: stickToBottom.current, escaped: escaped.current },
    );
    lastScrollTop.current = m.scrollTop;
    lastScrollHeight.current = m.scrollHeight;

    applyStick(intent);

    // The report that says the content got taller is also where following it
    // belongs; a second observer for the same event would only race this one.
    if (intent.follow) scrollToEnd("auto");

    const root = rootRef.current;
    if (root) {
      root.style.setProperty(
        "--timeline-fade-offset",
        `${timelineMaskOffset(m)}px`,
      );
    }
  }, [applyStick, scrollToEnd]);

  const virtual = useVirtualWindow(itemKeys, rootRef, scrollParent, {
    onScrollMetrics,
  });
  itemKeysRef.current = itemKeys;
  heightOfRef.current = virtual.heightOf;

  // Keep scroll anchored when older pages prepend above the viewport.
  // A full replace is a different session: leftover scrollTop / mask offset
  // hide the new stream until a wheel event (and WebKit often will not fire
  // one when the content shrinks).
  useLayoutEffect(() => {
    const prev = prevKeysRef.current;
    const next = itemKeys;
    const parent = scrollParentRef.current;
    if (parent && prev.length > 0) {
      if (isFullKeyReplace(prev, next)) {
        setStick(true);
        lastScrollTop.current = 0;
        lastScrollHeight.current = 0;
        const root = rootRef.current;
        if (root) root.style.setProperty("--timeline-fade-offset", "-42px");
        parent.scrollTop = 0;
        scrollToEnd("auto");
      } else {
        const delta = prependHeightDelta(prev, next, virtual.heightOf);
        if (delta > 0) parent.scrollTop += delta;
      }
    }
    prevKeysRef.current = next;
  }, [itemKeys, virtual.heightOf, setStick, scrollToEnd]);

  const locateInAll = useCallback(
    (id: string) => {
      pendingLocateId.current = id;
      setStick(false);
      setFilter("all");
      setLocateGen((n) => n + 1);
    },
    [setStick],
  );

  // Scroll + flash after User → All. Depends on locateGen, not itemKeys:
  // streaming updates rewrite keys and would otherwise cancel the highlight.
  useLayoutEffect(() => {
    const id = pendingLocateId.current;
    if (filter !== "all" || !id) return;
    pendingLocateId.current = null;
    setLocatedId(id);

    const tryScroll = (): boolean => {
      const parent = scrollParentRef.current;
      const list = rootRef.current;
      if (!parent || !list) return false;
      const el = list.querySelector(timelineItemSelector(id));
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: "center", behavior: "auto" });
        return true;
      }
      const y = offsetBeforeKey(itemKeysRef.current, id, heightOfRef.current);
      if (y == null) return true;
      const listTop =
        list.getBoundingClientRect().top -
        parent.getBoundingClientRect().top +
        parent.scrollTop;
      parent.scrollTop = listTop + y - parent.clientHeight * 0.28;
      return false;
    };

    tryScroll();
    let passes = 0;
    const interval = window.setInterval(() => {
      passes += 1;
      if (tryScroll() || passes >= 12) window.clearInterval(interval);
    }, 50);
    const highlight = window.setTimeout(() => setLocatedId(null), 1600);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(highlight);
    };
  }, [filter, locateGen]);

  const jumpToLatest = () => {
    // Re-arm stick before scrolling, as the pinBottomSeq path does, so content
    // arriving mid-animation does not fight the jump.
    setStick(true);
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    scrollToEnd(reduced ? "auto" : "smooth");
  };

  // Discover scroll parent once the list mounts (ownership stays here; virtual window consumes it).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let parent: HTMLElement | null = root.parentElement;
    while (parent) {
      const { overflowY } = getComputedStyle(parent);
      if (overflowY === "auto" || overflowY === "scroll") break;
      parent = parent.parentElement;
    }
    if (!parent) return;
    scrollParentRef.current = parent;
    setScrollParent(parent);
  }, [filtered.length > 0, filterChips.length]);

  /*
   * Where the intent comes from.
   *
   * Geometry cannot tell a reader scrolling back from the content settling
   * shorter underneath them — both move `scrollTop` down by the same amount —
   * and the report that says so arrives after the fact either way. A wheel or a
   * dragging finger is the reader, unambiguously and at the moment it happens.
   *
   * Passive, because none of this cancels anything; and only while there is
   * somewhere to scroll, so a flick on a short list is not read as leaving.
   */
  useEffect(() => {
    const parent = scrollParent;
    if (!parent) return;

    const leaveBottom = () => {
      if (parent.scrollHeight <= parent.clientHeight) return;
      if (escaped.current && !stickToBottom.current) return;
      escaped.current = true;
      stickToBottom.current = false;
      setAtBottom(false);
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) leaveBottom();
    };
    let lastTouchY = 0;
    const onTouchStart = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? 0;
      // A finger travelling down drags the content down, which is backwards.
      if (y > lastTouchY + 1) leaveBottom();
      lastTouchY = y;
    };

    parent.addEventListener("wheel", onWheel, { passive: true });
    parent.addEventListener("touchstart", onTouchStart, { passive: true });
    parent.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      parent.removeEventListener("wheel", onWheel);
      parent.removeEventListener("touchstart", onTouchStart);
      parent.removeEventListener("touchmove", onTouchMove);
    };
  }, [scrollParent]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    scrollToEnd("auto");
  }, [filtered]);

  useEffect(() => {
    if (!stickToBottom.current || !virtual.active) return;
    scrollToEnd("auto");
  }, [virtual.totalHeight, virtual.active]);

  useEffect(() => {
    if (!pinBottomSeq) return;
    setStick(true);
    const t0 = window.requestAnimationFrame(() => scrollToEnd("smooth"));
    // One late retry still earns its place: markdown, diffs and images lay out
    // after the frames the convergence pass covers.
    const t1 = window.setTimeout(() => scrollToEnd("auto"), 320);
    return () => {
      window.cancelAnimationFrame(t0);
      window.clearTimeout(t1);
    };
  }, [pinBottomSeq, setStick, scrollToEnd]);

  if (items.length === 0 && !hasMore) {
    return (
      <div className="empty-hint">
        {managed
          ? "Waiting for ACP stream… send a prompt or wait for the agent."
          : "No stream yet. Timeline mirrors Grok Build on disk; send a message to connect live."}
      </div>
    );
  }

  const windowed = virtual.active
    ? filtered.slice(virtual.start, virtual.end)
    : filtered;

  return (
    <div className="timeline-panel-wrap">
      {hasMore && (
        <div className="timeline-history-control">
          <button
            type="button"
            className="btn"
            disabled={loadingOlder}
            onClick={() => {
              setStick(false);
              void onLoadOlder();
            }}
          >
            {loadingOlder ? "Loading…" : "Load earlier activity"}
          </button>
        </div>
      )}
      <div
        ref={filterBarRef}
        className="timeline-filters"
        role="toolbar"
        aria-label="Timeline content filter"
      >
        <span className="timeline-filter-indicator" aria-hidden />
        {filterChips.map((k) => {
          const count =
            k === "all"
              ? items.reduce((n, item) => (item.pending ? n : n + 1), 0)
              : (kindCounts.get(k) ?? 0);
          const label = TIMELINE_FILTER_LABELS[k] ?? k;
          return (
            <button
              key={k}
              type="button"
              data-filter-kind={k}
              className={`timeline-filter-chip filter-${k}${
                filter === k ? " active" : ""
              }`}
              onClick={() => setFilter(k)}
              aria-pressed={filter === k}
            >
              {label}
              <span className="timeline-filter-count">{count}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-hint">
          No <strong>{TIMELINE_FILTER_LABELS[filter] ?? filter}</strong> items in
          this stream.
        </div>
      ) : (
        <div
          className={`timeline stream-timeline${
            filter === "all" ? "" : " is-filtered"
          }${virtual.active ? " is-virtualized" : ""}`}
          ref={rootRef}
          style={
            virtual.active
              ? { position: "relative", height: virtual.totalHeight }
              : undefined
          }
        >
          <div
            className={virtual.active ? "timeline-virtual-window" : undefined}
            style={
              virtual.active
                ? {
                    position: "absolute",
                    top: virtual.offsetTop,
                    left: 0,
                    right: 0,
                  }
                : undefined
            }
          >
            {windowed.map(({ item, sourceIndex }) => {
              const stackClass = timelineStackClass(
                items[sourceIndex - 1]?.kind,
                item.kind,
                items[sourceIndex + 1]?.kind,
              );
              const row = item.pending ? (
                <PendingRow
                  item={item}
                  stackClass={stackClass}
                  controller={queue}
                  ui={queueUi}
                />
              ) : (
                <LiveItemRow
                  item={item}
                  stackClass={stackClass}
                  onOpenFile={onOpenFile}
                  onLocateInAll={
                    filter === "user" && item.kind === "user"
                      ? () => locateInAll(item.id)
                      : undefined
                  }
                  located={locatedId === item.id}
                />
              );
              if (!virtual.active) {
                return <Fragment key={item.id}>{row}</Fragment>;
              }
              return (
                <div
                  key={item.id}
                  className="tl-row-measure"
                  ref={(el) => virtual.measureKey(item.id, el)}
                >
                  {row}
                </div>
              );
            })}
          </div>
          <div ref={endRef} className="timeline-panel-end" aria-hidden />
        </div>
      )}

      {filtered.length > 0 && (
        // Always mounted so showing the button never reflows the stream; the
        // anchor is a zero-height sticky line the button hangs above.
        <div className="timeline-jump-anchor">
          {!atBottom && (
            <button
              type="button"
              className="btn timeline-jump-latest"
              aria-label="Jump to latest activity"
              onClick={jumpToLatest}
            >
              <svg
                width={13}
                height={13}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M8 3v8.5M4.5 8 8 11.5 11.5 8" />
              </svg>
              Latest
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One Timeline row. Memoized so streaming updates to the tail card do not
 * re-parse Markdown / re-layout every prior item.
 */
const LiveItemRow = memo(function LiveItemRow({
  item,
  stackClass,
  onOpenFile,
  onLocateInAll,
  located = false,
}: {
  item: TimelineItem;
  stackClass: string;
  onOpenFile?: (path: string) => void;
  onLocateInAll?: () => void;
  located?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const isMdKind =
    item.kind === "agent" || item.kind === "user" || item.kind === "thought";
  const useMarkdown = isMdKind && Boolean(item.detail) && !item.streaming;
  const toolPath =
    item.kind === "tool" && onOpenFile
      ? extractToolPath(item.detail, item.title)
      : null;

  const canCopy =
    (item.kind === "agent" || item.kind === "user") &&
    Boolean(item.detail?.trim()) &&
    !item.streaming;
  const isConversationBody = item.kind === "user" || item.kind === "agent";
  const copyAriaLabel =
    item.kind === "user" ? "Copy user message" : "Copy agent output";
  const displayTitle =
    item.kind === "thought"
      ? item.streaming && !item.detail?.trim()
        ? "Thinking…"
        : null
      : item.title;

  const copyDetail = useCallback(async () => {
    const text = item.detail?.trim();
    if (!text) return;
    try {
      await writeClipboard(text);
      setCopied(true);
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 600);
    } catch {
      setCopied(false);
    }
  }, [item.detail]);

  return (
    <TimelineRowChrome
      kind={item.kind}
      ts={item.ts}
      stackClass={stackClass}
      itemId={item.id}
      className={
        [
          onLocateInAll ? "is-locatable" : "",
          located ? "is-located" : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined
      }
      onActivate={onLocateInAll}
    >
      {item.kind === "shell" && item.shell ? (
        <ShellCard shell={item.shell} />
      ) : (
        <>
          {isConversationBody || !displayTitle ? null : toolPath ? (
            <FilePathLink
              path={toolPath}
              onOpen={onOpenFile}
              className="tl-title"
            >
              {displayTitle}
            </FilePathLink>
          ) : (
            <div className="tl-title">{displayTitle}</div>
          )}
          {item.detail && (
            <div
              className={
                "tl-detail" +
                (isConversationBody ? " tl-conversation-body" : "") +
                (canCopy ? " has-copy" : "")
              }
            >
              {useMarkdown ? (
                <Markdown onOpenFile={onOpenFile}>{item.detail}</Markdown>
              ) : isMdKind ? (
                <pre className="tl-stream-plain">{item.detail}</pre>
              ) : item.isEdit && item.detail ? (
                <DiffSnippet patch={item.detail} />
              ) : toolPath && item.detail === toolPath ? (
                <FilePathLink
                  path={toolPath}
                  onOpen={onOpenFile}
                  className="tl-detail-path"
                >
                  {item.detail}
                </FilePathLink>
              ) : (
                item.detail
              )}
              {canCopy && (
                <div className="tl-detail-footer">
                  <button
                    type="button"
                    className={
                      "tl-copy-btn" + (copied ? " is-copied" : "")
                    }
                    title={copied ? "Copied" : copyAriaLabel}
                    aria-label={copied ? "Copied" : copyAriaLabel}
                    onClick={(e) => {
                      e.stopPropagation();
                      void copyDetail();
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </TimelineRowChrome>
  );
});
