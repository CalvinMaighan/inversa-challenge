import type { AgentStreamEvent } from "shared/agent/events";

/**
 * Streamed agent output for voice-spawned tasks (`task.event`). Deliberately outside
 * active-state: content deltas arrive many times a second and only the orb card needs them.
 */

export type TaskEventListener = (taskId: string, event: AgentStreamEvent) => void;

const listeners = new Set<TaskEventListener>();

/** Subscribe to every task's agent events. Returns the unsubscribe function. */
export function onTaskEvent(listener: TaskEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by the voice runtime for each `task.event`. A throwing listener does not starve the others. */
export function emitTaskEvent(taskId: string, event: AgentStreamEvent): void {
  for (const listener of listeners) {
    try {
      listener(taskId, event);
    } catch (error) {
      console.error("[voice] task event listener failed", error);
    }
  }
}
