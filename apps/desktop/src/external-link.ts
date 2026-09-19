import type { MouseEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Send a link to the person's own browser.
 *
 * The same markup serves both builds. An external link stays a plain anchor,
 * with its href, `target="_blank"` and `rel="noreferrer"`:
 *
 * - In a browser, this does nothing at all and the anchor opens a new tab.
 * - In the Tauri window, `target="_blank"` opens nothing, so the click is
 *   handed to the operating system instead.
 *
 * Keeping the href is the point. Copying the link, middle-clicking and
 * opening in a new tab all keep working, and neither build needs its own
 * markup.
 */
export function openExternally(event: MouseEvent<HTMLAnchorElement>): void {
  if (!isTauri()) return;
  event.preventDefault();
  void openUrl(event.currentTarget.href);
}
