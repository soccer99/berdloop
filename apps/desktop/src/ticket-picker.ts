// The parts of the ticket picker that hold no React state, so they can be
// read and tested on their own. Everything here is about one question: which
// answer from the provider is the one a person is still waiting for.

import type { ExternalIssue, ExternalProvider } from "@berdloop/core";

/** How long typing rests before the provider is asked again. */
export const searchDebounceMs = 250;

/**
 * A request counter shared by every search the picker sends.
 *
 * A search sent later can come back sooner, so arrival order says nothing
 * about which answer belongs on screen. Each request takes a ticket on the
 * way out, and only a ticket newer than the last one shown is accepted, so a
 * slow earlier answer is dropped rather than overwriting a newer one.
 */
export interface SearchSequence {
  /** Claim the number for a request about to go out. */
  start: () => number;
  /** Whether the answer to `ticket` is still the newest one seen. */
  accept: (ticket: number) => boolean;
}

export function searchSequence(): SearchSequence {
  let issued = 0;
  let shown = 0;
  return {
    start: () => {
      issued += 1;
      return issued;
    },
    accept: (ticket) => {
      if (ticket <= shown) return false;
      shown = ticket;
      return true;
    },
  };
}

function updatedTime(issue: ExternalIssue): number {
  const parsed = Date.parse(issue.updatedAt ?? "");
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

/**
 * Newest first. The providers do not agree on an order, and an issue whose
 * provider did not say when it changed goes last rather than first.
 */
export function recentFirst(issues: ExternalIssue[]): ExternalIssue[] {
  return [...issues].sort(
    (left, right) => updatedTime(right) - updatedTime(left),
  );
}

/** What a row says about the last change. Empty when the provider is silent. */
export function updatedLabel(issue: ExternalIssue): string {
  const parsed = Date.parse(issue.updatedAt ?? "");
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The one refusal the picker answers with a way out rather than a failure:
 * nobody has saved a connection for this provider yet. The host writes it
 * word for word, so the picker matches it word for word.
 */
export function needsConnection(
  error: string,
  provider: ExternalProvider,
): boolean {
  return error.trim() === `Connect ${provider} in settings first.`;
}
