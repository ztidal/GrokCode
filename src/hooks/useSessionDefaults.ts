import { useCallback, useRef } from "react";
import { setSessionModel } from "../api";
import type { AvailableModelInfo, ManagedAgentInfo } from "../types";
import { isLiveManagedStatus } from "../utils/managedStatus";
import { resolveReasoningOptions } from "../utils/reasoningEffort";

/** The agent state a session default is decided from. */
type CatalogAgent = Pick<
  ManagedAgentInfo,
  "modelId" | "reasoningEffort" | "availableModels"
>;

/** What to send to `session/set_model`, or `null` when the agent is already there. */
export interface SessionDefaultPush {
  modelId: string;
  /** Absent when the model advertises no rungs — leave the agent's own level alone. */
  reasoningEffort?: string;
}

function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * The newest model the agent advertises: the first usable entry in its catalog.
 *
 * List order is the only thing in the payload that ranks models — an entry
 * carries an id, a name and its reasoning rungs, and nothing that says "newest".
 * The agent puts the model it wants you on first, which is the same convention
 * as `reasoningEfforts` in the same payload (best rung first) and the order the
 * app's own fallback list is written in. Reading a version out of the id would
 * be a second, competing notion of "newest" that mis-ranks the first model that
 * is not spelled `grok-<major>.<minor>` — so trust the agent's ordering, and
 * fix this one function if the agent ever stops sorting.
 */
export function newestAdvertisedModel(
  catalog: readonly AvailableModelInfo[] | null | undefined,
): string | null {
  for (const model of catalog ?? []) {
    const id = trimmed(model.modelId);
    if (id) return id;
  }
  return null;
}

/**
 * The model's best reasoning level, or `null` when it has none.
 *
 * `resolveReasoningOptions` is the app's single ordering of the rungs (catalog
 * list when the agent sent one, the known-model fallback otherwise) and it is
 * ordered best-first, so the highest level is simply the head. The catalog's
 * own `default` flag is deliberately ignored: it marks the level the agent
 * considers sensible, and we are asking for the level it considers highest.
 */
export function highestReasoningEffort(
  modelId: string,
  catalog: readonly AvailableModelInfo[] | null | undefined,
): string | null {
  const options = resolveReasoningOptions(modelId, [...(catalog ?? [])]);
  return trimmed(options[0]?.value) || null;
}

/**
 * Newest model at its highest reasoning level, or `null` when there is nothing
 * to do — the catalog has not arrived yet, or the agent already chose this.
 *
 * Returning `null` for "already there" is the point: a new session usually
 * starts on the newest model anyway, and a redundant `session/set_model` is a
 * round trip that buys nothing.
 */
export function sessionDefaultPush(
  agent: CatalogAgent,
): SessionDefaultPush | null {
  const catalog = agent.availableModels ?? [];
  const modelId = newestAdvertisedModel(catalog);
  if (!modelId) return null;

  const sameModel = modelId === trimmed(agent.modelId);
  const effort = highestReasoningEffort(modelId, catalog);
  if (!effort) {
    // No rungs to ask for: switch the model, or do nothing if it is current.
    return sameModel ? null : { modelId };
  }
  if (sameModel && effort === trimmed(agent.reasoningEffort)) return null;
  return { modelId, reasoningEffort: effort };
}

/**
 * Start every new session on the newest model at its highest thinking level.
 *
 * The catalog only exists after `session/new`, so the choice cannot ride along
 * with the spawn: `arm` records the session, and `apply` acts on the first
 * managed-agent snapshot that carries a catalog. Each session is decided
 * exactly once — a user who picks another model mid-task is never overruled,
 * because by then this hook has already forgotten the session. `forget` closes
 * the one window where it could: a pick made from the fallback list before the
 * catalog ever arrived.
 */
export function useSessionDefaults() {
  /** Sessions spawned this run that have not been decided yet. */
  const armed = useRef(new Set<string>());

  const arm = useCallback((sessionId: string | null | undefined) => {
    const id = trimmed(sessionId);
    if (id) armed.current.add(id);
  }, []);

  /** Drop a session's pending default — the user chose for themselves. */
  const forget = useCallback((sessionId: string | null | undefined) => {
    armed.current.delete(trimmed(sessionId));
  }, []);

  const apply = useCallback(async (agents: readonly ManagedAgentInfo[]) => {
    if (armed.current.size === 0) return;
    for (const agent of agents) {
      const sessionId = trimmed(agent.sessionId);
      if (!sessionId || !armed.current.has(sessionId)) continue;
      if (agent.status === "stopped" || agent.status === "error") {
        armed.current.delete(sessionId); // no catalog is coming for this one
        continue;
      }
      if (!isLiveManagedStatus(agent.status)) continue;
      // Still starting up / reconnecting: wait for a snapshot with a catalog.
      if (!newestAdvertisedModel(agent.availableModels)) continue;

      // Decided — drop it before the await, so a snapshot arriving mid-flight
      // cannot start a second push for the same session.
      armed.current.delete(sessionId);
      const push = sessionDefaultPush(agent);
      if (!push) continue;
      try {
        await setSessionModel(
          agent.handleId,
          push.modelId,
          push.reasoningEffort ?? null,
        );
      } catch (e) {
        // A default is a courtesy: the session is usable on whatever the agent
        // picked, so this must not take over the error banner.
        console.debug("[session-defaults] set_model skipped:", e);
      }
    }
  }, []);

  return { arm, forget, apply };
}
