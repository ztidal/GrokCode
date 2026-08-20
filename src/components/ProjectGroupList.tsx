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
  /** SessionList owns card chrome; this component owns only the headers. */
  renderSession: (session: SessionCard) => ReactNode;
}

/** Project headers over the task cards. Rendered inside `.session-cards`. */
export function ProjectGroupList({
  groups,
  isCollapsed,
  onToggle,
  selectedId,
  renderSession,
}: Props) {
  return (
    <>
      {groups.map((group) => {
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
            <button
              type="button"
              className={headerClass}
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
