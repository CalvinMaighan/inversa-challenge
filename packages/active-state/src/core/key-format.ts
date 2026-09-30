/** UPPERCASE_IDS — e.g. CART, CART_ITEMS, UI_NAV_OPEN */
const UPPERCASE_ID = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

export function isUppercaseId(key: string): boolean {
  return UPPERCASE_ID.test(key);
}

export function assertUppercaseId(key: string): void {
  if (!isUppercaseId(key)) {
    throw new Error(
      `[active-state] Invalid key "${key}". Use UPPERCASE_IDS (e.g. CART_ITEMS). Pass any on <ActiveState> (or init(..., { any: true })) to allow any keys.`,
    );
  }
}

