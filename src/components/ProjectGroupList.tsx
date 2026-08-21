import type { ReactNode } from "react";
import type { SessionCard } from "../types";
import {
  groupCountLabel,
  groupCountTitle,
  type SessionGroup,
} from "../hooks/useProjectGroups";

interface Props {
  groups: SessionGroup[];
  isCollapsed: (key: string) => boolean;
  onToggle: (key: string) => void;
  /** So a collapsed group can still show that the open task is inside it. */
  selectedId: string | null;
  /** Start a task in this project. Omitted when the host has no modal to open. */
  onNewSession?: (cwd: string) => void;
  /** SessionList owns card chrome; this component owns only the headers. */
  renderSession: (session: SessionCard) => ReactNode;
}

/** Project headers over the task cards. Rendered inside `.session-cards`. */
export function ProjectGroupList({
  groups,
  isCollapsed,
  onToggle,
  selectedId,
  onNewSession,
  renderSession,
}: Props) {
  return (
    <>
      {groups.map((group) => {
        /*
         * The pinned group is a header and nothing else: no caret, because a pin
         * behind a closed header is a pin you cannot see; no "+", because there
         * is no folder to start a task in. It renders only while something is
         * pinned, so the sidebar is unchanged for anyone who never pins.
         */
        if (group.pinned) {
          return (
            <div className="project-group is-pinned" key={group.key}>
              <div className="project-group-header is-pinned">
                <span className="project-group-label">{group.label}</span>
                <span
                  className="project-group-count"
                  title={groupCountTitle(group)}
                >
                  {groupCountLabel(group)}
                </span>
              </div>
              <div className="project-group-sessions">
                {group.sessions.map((session) => renderSession(session))}
              </div>
            </div>
          );
        }

        const collapsed = isCollapsed(group.key);
        const holdsSelected =
          selectedId != null &&
          group.sessions.some((session) => session.id === selectedId);
        const headerClass = [
          "project-group-header",
          collapsed ? "collapsed" : "",
          group.missing ? "missing" : "",
          holdsSelected ? "has-selected" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div className="project-group" key={group.key}>
            {/*
             * A row, not one big button: the "+" is its own control, and a button
             * inside a button is neither valid nor separately clickable.
             */}
            <div className={headerClass}>
              <button
                type="button"
                className="project-group-toggle"
                onClick={() => onToggle(group.key)}
                aria-expanded={!collapsed}
                title={
                  group.missing
                    ? `${group.path}\nFolder no longer exists`
                    : group.path
                }
              >
                <span className="project-group-caret" aria-hidden>
                  {collapsed ? "▸" : "▾"}
                </span>
                <span className="project-group-label">{group.label}</span>
                {group.missing && (
                  <span
                    className="project-group-missing"
                    aria-label="Folder no longer exists"
                  >
                    ⚠
                  </span>
                )}
                <span
                  className="project-group-count"
                  title={groupCountTitle(group)}
                >
                  {groupCountLabel(group)}
                </span>
              </button>
              {onNewSession && (
                <button
                  type="button"
                  className="project-group-new"
                  // Disabled rather than hidden: a gap where the control should
                  // be reads as a bug, the greyed-out one names its own reason.
                  disabled={group.missing}
                  title={
                    group.missing
                      ? `Cannot start a task in ${group.path}\nFolder no longer exists`
                      : `New task in ${group.path}`
                  }
                  aria-label={`New task in ${group.label}`}
                  onClick={() => onNewSession(group.path)}
                >
                  +
                </button>
              )}
            </div>
            {!collapsed && (
              <div className="project-group-sessions">
                {group.sessions.map((session) => renderSession(session))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
