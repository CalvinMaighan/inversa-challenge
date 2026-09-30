"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { ThemeProvider } from "@emotion/react";
import { ActiveState } from "@calvinjs/active-state/react";
import { ActiveTheme } from "active-theme/state";

import { DEBUG_HOOK, installDebugHook } from "client/debug";
import { state } from "client/state";
import { ensureIdentity } from "client/state/me";
import { STORAGE_PREFIX } from "client/themes/bootstrap";
import EmotionRegistry from "client/themes/EmotionRegistry";
import GlobalStyles from "client/themes/GlobalStyles";
import { emotionTheme, theme } from "client/themes/theme";

const noSubscribe = () => () => {};

/**
 * Mounts `<ActiveTheme />` only after hydration. During hydration the bus still reports the server snapshot
 * (dark), so mounting it then would repaint the dark default over the mode the bootstrap script already set,
 * and put it back a task later: a visible flash. After hydration the bus holds the persisted mode and
 * ActiveTheme's first write matches what is already on `<html>`.
 */
function ThemeSync() {
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  return hydrated ? <ActiveTheme init={theme} /> : null;
}

/** First-visit identity. Runs after `<ActiveState ssr />` hydrated ME from storage in its layout effect. */
function Identity() {
  useEffect(() => {
    ensureIdentity();
    // Dev and e2e builds only (DEBUG_HOOK is false in a plain production build).
    if (DEBUG_HOOK) installDebugHook();
  }, []);
  return null;
}

/** Store, theme and styles for the whole app. No React context besides Emotion's. */
export default function Providers({ children }: { children: ReactNode }) {
  return (
    <EmotionRegistry>
      <ThemeProvider theme={emotionTheme}>
        <ActiveState init={state} ssr storagePrefix={STORAGE_PREFIX} />
        <ThemeSync />
        <GlobalStyles />
        <Identity />
        {children}
      </ThemeProvider>
    </EmotionRegistry>
  );
}
