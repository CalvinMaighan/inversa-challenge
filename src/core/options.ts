let enforceKeys = true;
let ssr = false;
let serverSnapshot: Record<string, unknown> = {};

export function setEnforceKeys(value: boolean): void {
  enforceKeys = value;
}

export function getEnforceKeys(): boolean {
  return enforceKeys;
}

export function setSsr(value: boolean): void {
  ssr = value;
}

export function getSsr(): boolean {
  return ssr;
}

export function setServerSnapshot(state: Record<string, unknown>): void {
  serverSnapshot = { ...state };
}

export function getServerSnapshot<T = unknown>(key: string): T | undefined {
  return serverSnapshot[key] as T | undefined;
}

export function resetOptions(): void {
  enforceKeys = true;
  ssr = false;
  serverSnapshot = {};
}
