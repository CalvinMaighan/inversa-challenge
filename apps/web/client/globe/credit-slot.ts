/**
 * Where the globe's data attribution shows (GE9): the chat card's header row, right of the AGENT and NOTES tabs, on
 * the stage layout and in the phone's chat dock alike. The header registers its slot element here; the globe moves
 * its one credit container (Cesium's `CreditDisplay` writes into it) into the slot, and back to its own corner of the
 * globe when no slot is mounted (pages without the chat card). Cesium keeps writing into the same element wherever
 * it sits, so nothing is re-created and the lightbox keeps working.
 */
type Listener = (slot: HTMLElement | null) => void;

let current: HTMLElement | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn(current);
}

/**
 * A React ref callback for the slot element: registers it, and its cleanup releases it (unless another slot took
 * over meanwhile).
 */
export function creditSlotRef(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  current = el;
  emit();
  return () => {
    if (current !== el) return;
    current = null;
    emit();
  };
}

/** Called with the slot now and on each change; returns the unsubscribe. */
export function onCreditSlot(fn: Listener): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}
