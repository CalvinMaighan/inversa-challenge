import { key } from "@calvinjs/active-state";

/** The one open HUD menu (a button's popover), or null. The agent opens and closes menus through it too. */
export const MENU = key("MENU", null as string | null);
