export type Observer<T = unknown> = {
  id: string;
  next: (value: T) => void;
  complete: () => void;
};

export type Observable<T = unknown> = {
  subscribe(observer: Observer<T>): void;
  unsubscribe(id: string): void;
  next(nextValue: T): void;
  complete(): void;
  getValue(): T;
};

export function createObservable<T>(initial: T): Observable<T> {
  let value = initial;
  const subscribers = new Map<string, Observer<T>>();

  return {
    subscribe(observer) {
      subscribers.set(observer.id, observer);
      observer.next(value);
    },
    unsubscribe(id) {
      subscribers.delete(id);
    },
    next(nextValue) {
      if (Object.is(value, nextValue)) return;
      value = nextValue;
      for (const observer of subscribers.values()) {
        observer.next(value);
      }
    },
    complete() {
      for (const observer of subscribers.values()) {
        observer.complete();
      }
      subscribers.clear();
    },
    getValue() {
      return value;
    },
  };
}
