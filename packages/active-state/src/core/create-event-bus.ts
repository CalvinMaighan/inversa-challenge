import { createObservable, type Observable } from "./create-observable";

export type EventBus = {
  getSource(id: string): Observable | undefined;
  update(id: string, value: unknown): void;
  keys(): string[];
  /** Live observables map for host introspection. */
  readonly observables: Map<string, Observable>;
};

export type CreateEventBusOptions = {
  init?: (observables: Map<string, Observable>) => void;
};

export function createEventBus(options: CreateEventBusOptions = {}): EventBus {
  const observables = new Map<string, Observable>();
  options.init?.(observables);

  return {
    observables,
    getSource(id) {
      const source = observables.get(id);
      if (!source) {
        console.warn(
          `[active-state] Unknown key "${id}". Add it to your init object (e.g. client/state).`,
        );
        return undefined;
      }
      return source;
    },
    update(id, value) {
      let source = observables.get(id);
      if (!source) {
        console.warn(
          `[active-state] Unknown key "${id}". Add it to your init object (e.g. client/state).`,
        );
        source = createObservable(value);
        observables.set(id, source);
        source.next(value);
        return;
      }
      source.next(value);
    },
    keys() {
      return [...observables.keys()];
    },
  };
}
