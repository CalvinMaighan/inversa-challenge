import type { EventBus } from "./create-event-bus";

let globalStateInstance: EventBus | null = null;

export function getStateInstance(bus?: EventBus): EventBus {
  if (bus) {
    globalStateInstance = bus;
    return bus;
  }
  if (!globalStateInstance) {
    throw new Error(
      "State has not been initialized. Call init(initialState) first.",
    );
  }
  return globalStateInstance;
}

export function resetStateInstance(): void {
  globalStateInstance = null;
}

