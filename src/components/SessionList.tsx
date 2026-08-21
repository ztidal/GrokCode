import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ManagedStatus, SessionCard } from "../types";
import {
  contextPct,
  formatRelative,
  formatTokens,
  projectName,
} from "../utils/format";
import {
  isPinkcodeAttached,
  rankManagedCard,
  resolveCardState,
  stateLabel,
  stateTitle,
} from "../utils/managedChrome";
import { NO_SESSIONS, useProjectGroups } from "../hooks/useProjectGroups";
import { sortPinnedFirst, useSessionPins } from "../hooks/useSessionPins";
import { useSessionTitles } from "../hooks/useSessionTitles";
import { useSessionArchive } from "../hooks/useSessionArchive";
import { openNewWindow, trashSession } from "../api";
import { SessionCardMenu, type CardMenuItem } from "./SessionCardMenu";
import { applyOverflowTitle, cardTitleTooltip } from "../utils/overflowTitle";
import { ProjectGroupList } from "./ProjectGroupList";

/**
 * Filled when pinned, outlined when not — the state has to survive a theme with
 * no colour to spare, so it is carried by the shape as well as the tint.
 */
function PinGlyph({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden focusable="false">
      <path
        d="M6 1.1a3.5 3.5 0 0 0-3.5 3.5c0 2.5 3.5 6.3 3.5 6.3s3.5-3.8 3.5-6.3A3.5 3.5 0 0 0 6 1.1Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      {!filled && <circle cx="6" cy="4.6" r="1.15" fill="currentColor" />}
    </svg>
  );
}

/** Vertical ellipsis. The card's one control; everything else is in its menu. */
function MenuGlyph() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden focusable="false">
      <circle cx="6" cy="2.4" r="1.05" fill="currentColor" />
      <circle cx="6" cy="6" r="1.05" fill="currentColor" />
      <circle cx="6" cy="9.6" r="1.05" fill="currentColor" />
    </svg>
  );
}

interface Props {
  sessions: SessionCard[];
  selectedId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  /**
   * sessionId → PinkCode managed status (any non-terminal attach state,
   * including `starting`). Sort + card chrome derive from this alone.
   */
  managedStatuses?: Record<string, ManagedStatus>;
  /** sessionId → live process pid (managed agent, else active_sessions). */
  managedPids?: Record<string, number>;
  /**
   * Single NeedsInput projection from useAgentEvents (permissions + pending_interaction).
   * Passed into resolveCardState / rankManagedCard — no local special-case.
   */
  needsInputSessionIds?: ReadonlySet<string>;
  onNewTask?: () => void;
  /** Same modal as `onNewTask`, seeded with one project's path. */
  onNewTaskInProject?: (cwd: string) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  /**
   * A task was moved to the trash and is no longer on disk.
   *
   * The card cannot wait for the filesystem watcher to notice: deleting renames
   * the session's *directory*, and `classify_path` only recognises the files
   * inside one (`summary.json`, `updates.jsonl`, …), so a vanished session
   * produces no event at all. The list has to be told.
   */
  onDeleted?: (sessionId: string) => void;
}

export function SessionList({
  sessions,
  selectedId,
  query,
  onQuery,
  onSelect,
  managedStatuses,
  managedPids,
  needsInputSessionIds,
  onNewTask,
  onNewTaskInProject,
  hasMore,
  onLoadMore,
  onDeleted,
}: Props) {
  const { pinnedIds, isPinned, togglePinned, unpin } = useSessionPins();
  const { archivedIds, isArchived, toggleArchived } = useSessionArchive();
  const { displayTitle, originalTitle, rename } = useSessionTitles();

  /** The card whose menu is open, and where it was opened. */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  /** The card a delete was asked for, held until it is confirmed. */
  const [pendingDelete, setPendingDelete] = useState<SessionCard | null>(null);
  /** What went wrong with the last delete, if anything. */
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  /** The card whose name is being edited, if any. One at a time. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /** Escape unmounts the input, which also blurs it; blur must not then save. */
  const abandonRename = useRef(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? sessions.filter(
          (s) =>
            // Both names: searching for what you called it has to work, and so
            // does searching for what it was called before you renamed it.
            displayTitle(s).toLowerCase().includes(q) ||
            s.title.toLowerCase().includes(q) ||
            s.cwd.toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q) ||
            (s.headBranch ?? "").toLowerCase().includes(q),
        )
      : sessions.slice();

    // Pins outrank run state: a pin is the user's own ordering, and a card that
    // sank the moment its agent went idle would not be worth pinning.
    return sortPinnedFirst(list, pinnedIds, (a, b) => {
      const ar = rankManagedCard(
        managedStatuses?.[a.id],
        a.isActive,
        needsInputSessionIds?.has(a.id) ?? false,
      );
      const br = rankManagedCard(
        managedStatuses?.[b.id],
        b.isActive,
        needsInputSessionIds?.has(b.id) ?? false,
      );
      return ar - br;
    });
  }, [
    sessions,
    query,
    managedStatuses,
    needsInputSessionIds,
    pinnedIds,
    displayTitle,
  ]);

  const searching = query.trim().length > 0;
  // A search already spans every project, so grouping its hits would only nest
  // one-card headers. Feeding the hook nothing also keeps it from re-walking the
  // session tree on each keystroke.
  const { groups, indexed, isCollapsed, toggleCollapsed } = useProjectGroups(
    searching ? NO_SESSIONS : visible,
    { selectedId, pinnedIds, archivedIds },
  );
  const grouped = !searching && indexed && groups.length > 0;

  /**
   * What the card menu offers, in the order a hand reaches for it: the two ways
   * to open it, then the two ways to label it, then the two ways to put it away
   * — reversible first, and the one that touches disk last and marked.
   */
  function menuItems(s: SessionCard): CardMenuItem[] {
    const archived = isArchived(s.id);
    return [
      {
        label: "Open in new window",
        onSelect: () => {
          void openNewWindow(s.id);
        },
      },
      {
        label: isPinned(s.id) ? "Unpin" : "Pin",
        separated: true,
        onSelect: () => togglePinned(s.id),
      },
      {
        label: "Rename",
        onSelect: () => {
          abandonRename.current = false;
          setRenamingId(s.id);
        },
      },
      {
        label: archived ? "Unarchive" : "Archive",
        separated: true,
        onSelect: () => {
          // A card cannot be in two built groups at once, and the top of the
          // list is not where something you are done with belongs.
          if (!archived) unpin(s.id);
          toggleArchived(s.id);
        },
      },
      {
        label: "Delete…",
        danger: true,
        onSelect: () => {
          setDeleteError(null);
          setPendingDelete(s);
        },
      },
    ];
  }

  function renderCard(s: SessionCard) {
    const managedStatus = managedStatuses?.[s.id];
    const attached = isPinkcodeAttached(managedStatus);
    const openElsewhere = s.isActive && !attached;
    const needsInput = needsInputSessionIds?.has(s.id) ?? false;
    const state = resolveCardState(managedStatus, openElsewhere, needsInput);
    const pid = managedPids?.[s.id] ?? s.activePid ?? null;
    const pinned = isPinned(s.id);
    const name = displayTitle(s);
    const original = originalTitle(s);
    const editing = renamingId === s.id;
    const cardClass = [
      "session-card",
      selectedId === s.id ? "selected" : "",
      `state-${state}`,
      // `open` is the one state we are not driving; the chrome says so in shape
      // as well as colour, so keep the two families apart in one class.
      state === "open" ? "run-elsewhere" : "",
      pinned ? "pinned" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const ctxPct = contextPct(s.contextTokensUsed, s.contextWindowTokens);
    const ctxLevel = ctxPct >= 90 ? "high" : ctxPct >= 70 ? "mid" : "ok";
    const ctxStyle = {
      "--ctx-pct": `${Math.min(100, Math.max(0, ctxPct))}%`,
    } as CSSProperties;
    return (
      <div
        key={s.id}
        className={cardClass}
        onClick={() => onSelect(s.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ id: s.id, x: e.clientX, y: e.clientY });
        }}
        title={stateTitle(state)}
        aria-busy={
          state === "running" || state === "starting" ? true : undefined
        }
      >
        {pinned && (
          <span
            className="session-pinned-mark"
            title="Pinned"
            aria-label="Pinned"
          >
            <PinGlyph filled />
          </span>
        )}
        {/*
          The row's own mark. It carries what the card chrome used to say in
          border and fill, now that rows are flat: hollow when nothing is
          running, filled in the state's colour when something is.
        */}
        <span className="session-mark" aria-hidden />
        <button
          type="button"
          className="session-menu-button"
          aria-haspopup="menu"
          aria-expanded={menu?.id === s.id}
          title="Actions"
          aria-label={`Actions for ${name}`}
          onClick={(e) => {
            // The card behind this button opens the session on click.
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ id: s.id, x: r.left, y: r.bottom + 2 });
          }}
        >
          <MenuGlyph />
        </button>
        {state !== "idle" && (
          <div className="card-status">
            <span className="card-status-dot" aria-hidden />
            <span className="card-status-text">{stateLabel(state)}</span>
            {pid != null && (
              <span className="card-status-pid" title={`pid ${pid}`}>
                pid {pid}
              </span>
            )}
          </div>
        )}
        <div className="card-body">
          {editing ? (
            <input
              className="card-title-input"
              defaultValue={name}
              placeholder={s.title}
              autoFocus
              spellCheck={false}
              title="Enter to save · Esc to cancel · leave it empty to restore the agent's own title"
              // Everything here happens on a card that opens on click.
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  rename(s, e.currentTarget.value);
                  setRenamingId(null);
                } else if (e.key === "Escape") {
                  abandonRename.current = true;
                  setRenamingId(null);
                }
              }}
              onBlur={(e) => {
                // Escape already unmounted the input, and unmounting blurs it.
                if (abandonRename.current) {
                  abandonRename.current = false;
                  return;
                }
                rename(s, e.target.value);
                setRenamingId(null);
              }}
            />
          ) : (
            <div
              className={original ? "card-title renamed" : "card-title"}
              // Measured on arrival, not watched: see applyOverflowTitle.
              onMouseEnter={(e) =>
                applyOverflowTitle(
                  e.currentTarget,
                  cardTitleTooltip(name, original),
                  original != null,
                )
              }
              onDoubleClick={(e) => {
                e.stopPropagation();
                abandonRename.current = false;
                setRenamingId(s.id);
              }}
            >
              {name}
            </div>
          )}
          <div className="card-meta">
            <span title={s.cwd}>{projectName(s.cwd)}</span>
            {s.headBranch && <span className="branch">⎇ {s.headBranch}</span>}
            <span className="time">
              {formatRelative(s.lastActiveAt ?? s.updatedAt)}
            </span>
          </div>
          <div className="card-metrics">
            <span
              className="card-chip"
              title={
                s.tokenUsagePending
                  ? "Loading completed-turn token usage"
                  : !s.tokenUsageAvailable
                  ? "Completed-turn token usage is not available for this session"
                  : s.tokenUsageIncomplete
                    ? "Approximate completed-turn total tokens; one or more turns may be incomplete"
                    : "Completed-turn total tokens (input + output, including cached reads)"
              }
            >
              {s.tokenUsagePending
                ? "… tok"
                : !s.tokenUsageAvailable
                ? "? tok"
                : `${s.tokenUsageIncomplete ? "≈" : ""}${formatTokens(s.totalTokens)} tok`}
            </span>
            <span
              className={`card-chip card-chip-ctx level-${ctxLevel}`}
              style={ctxStyle}
              title={`Context ${ctxPct}% (${formatTokens(s.contextTokensUsed, { decimals: false })} / ${formatTokens(s.contextWindowTokens, { decimals: false })})`}
            >
              {ctxPct}% ctx
            </span>
            {(s.agentLinesAdded > 0 || s.agentLinesRemoved > 0) && (
              <span className="card-chip diff-stat">
                +{s.agentLinesAdded}/−{s.agentLinesRemoved}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="session-list">
      <div className="panel-header">
        <div className="panel-header-left">
          <h2>Tasks</h2>
        </div>
        <div className="panel-header-right">
          {onNewTask && (
            <button
              className="btn primary"
              type="button"
              onClick={onNewTask}
            >
              New
            </button>
          )}
        </div>
      </div>

      <div className="list-controls">
        <input
          className="search"
          placeholder="Filter by title, path, id…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>

      <div className="session-cards">
        {visible.length === 0 && (
          <div className="empty-hint">No sessions match.</div>
        )}
        {grouped ? (
          <ProjectGroupList
            groups={groups}
            isCollapsed={isCollapsed}
            onToggle={toggleCollapsed}
            selectedId={selectedId}
            onNewSession={onNewTaskInProject}
            renderSession={renderCard}
          />
        ) : (
          visible.map((s) => renderCard(s))
        )}
        {hasMore && onLoadMore && (
          <button
            className="btn ghost session-load-more"
            type="button"
            onClick={onLoadMore}
          >
            Load more
          </button>
        )}
      </div>

      {menu &&
        (() => {
          const card = visible.find((s) => s.id === menu.id);
          if (!card) return null;
          return (
            <SessionCardMenu
              at={{ x: menu.x, y: menu.y }}
              items={menuItems(card)}
              onClose={closeMenu}
              label={displayTitle(card)}
            />
          );
        })()}

      {pendingDelete && (
        <div
          className="modal-backdrop"
          onClick={() => setPendingDelete(null)}
        >
          <div
            className="modal delete-session-modal"
            role="dialog"
            aria-modal
            aria-labelledby="delete-session-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="delete-session-title">Delete this task?</h2>
            </div>
            <p className="delete-session-name">
              {displayTitle(pendingDelete)}
            </p>
            <p className="delete-session-note">
              Its folder moves to <code>.trash</code> inside the session store.
              It leaves this list and <code>grok</code> stops seeing it, but
              nothing is erased — moving the folder back brings it all the way
              back.
            </p>
            {deleteError && (
              <p className="delete-session-error">{deleteError}</p>
            )}
            <div className="modal-actions">
              <button
                className="btn ghost"
                type="button"
                onClick={() => setPendingDelete(null)}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                type="button"
                onClick={() => {
                  const card = pendingDelete;
                  void trashSession(card.id)
                    .then(() => {
                      // Clear our own notes so a new session cannot inherit
                      // them by id reuse, then tell the list: nothing else
                      // will, the watcher included.
                      unpin(card.id);
                      setPendingDelete(null);
                      onDeleted?.(card.id);
                    })
                    .catch((e: unknown) =>
                      setDeleteError(
                        e instanceof Error ? e.message : String(e),
                      ),
                    );
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
