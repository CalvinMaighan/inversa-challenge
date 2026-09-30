"use client";

import { useEffect, useState } from "react";

export type Load<T> = { status: "idle" } | { status: "loading" } | { status: "ready"; data: T } | { status: "error"; error: string };

type Settled<T> = { key: string; data?: T; error?: string };

/**
 * Load `key` with `load` and track the result. A result is tagged with the key it was loaded for, so a stale
 * response for an older key never shows, and switching keys reads as loading without a state reset.
 * `attempt` in the key (from `retry`) forces a reload after an error.
 */
export function useLoad<T>(key: string | null, load: () => Promise<T>): Load<T> & { retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const tagged = key === null ? null : `${key}#${attempt}`;

  useEffect(() => {
    if (tagged === null) return;
    let live = true;
    load().then(
      (data) => live && setSettled({ key: tagged, data }),
      (err: unknown) => live && setSettled({ key: tagged, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
    // `load` is recreated per render by callers; the key identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagged]);

  const retry = () => setAttempt((a) => a + 1);
  if (tagged === null) return { status: "idle", retry };
  if (!settled || settled.key !== tagged) return { status: "loading", retry };
  if (settled.error !== undefined) return { status: "error", error: settled.error, retry };
  return { status: "ready", data: settled.data as T, retry };
}
