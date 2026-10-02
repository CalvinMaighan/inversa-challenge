import { key } from "@calvinjs/active-state";

/** The provider settings' tabs: the data feeds first, then the API keys. */
export type DeveloperTab = "feeds" | "keys";

export const DEVELOPER_TABS: readonly { id: DeveloperTab; label: string }[] = [
  { id: "feeds", label: "Feeds" },
  { id: "keys", label: "API Keys" },
];

/** The open tab; the panel sets it back to the feeds each time it opens. */
export const DEVELOPER_TAB = key<"DEVELOPER_TAB", DeveloperTab>("DEVELOPER_TAB", "feeds");
