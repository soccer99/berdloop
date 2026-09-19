/**
 * Quoting a hunk of the diff puts it at the top of the task composer's draft.
 *
 * The draft now outlives the composer (see `drafts.ts`), so the rule that used
 * to live in two `useRef`s inside the component no longer holds: a ref resets
 * on every mount, while the restored draft still carries the quote the ref has
 * forgotten. Deselecting a task and coming back would prepend the same quote a
 * second time. This module is the rule on its own, so it can be tested without
 * a renderer, plus the small memory of what each draft already carries.
 *
 * The memory is in-process on purpose, not in localStorage: the quote itself
 * is React state in `QueueView` and dies with the page, so nothing can ask for
 * a quote to be re-applied after a reload. It only has to outlive a mount.
 */

/** A quote asking to be put at the top of a draft. A new id is a new ask. */
export interface Quote {
  /** Rises with every Quote click, so the same text can be quoted twice. */
  id: number;
  text: string;
}

/** What a draft already carries, remembered for as long as the draft lives. */
export type AppliedQuote = Quote;

/** A draft with a quote in it, and the quote to remember it by. */
export interface QuotePrefill {
  text: string;
  applied: AppliedQuote;
}

/**
 * The draft after a quote arrives, or null when this exact quote is already in
 * it and the draft must not be touched.
 *
 * A prefill can cost the person what they typed only if it replaces it, so it
 * never does: the new quote replaces the previous quote when that is still
 * sitting at the top, and otherwise goes in front of everything. Typed text
 * stays below either way. A restored draft that already starts with the quote
 * is left byte-identical, which is what makes remounting safe even when the
 * memory below has been lost.
 */
export function quotePrefill(
  draft: string,
  quote: Quote,
  applied?: AppliedQuote,
): QuotePrefill | null {
  if (applied?.id === quote.id) {
    return null;
  }
  const previous =
    applied?.text ?? (draft.startsWith(quote.text) ? quote.text : "");
  const text =
    previous && draft.startsWith(previous)
      ? quote.text + draft.slice(previous.length)
      : quote.text + draft;
  return { text, applied: { id: quote.id, text: quote.text } };
}

/** Which quote each draft currently carries, by the draft's subject key. */
const applied = new Map<string, AppliedQuote>();

/** The quote that draft already carries, or undefined when it carries none. */
export function appliedQuote(draftKey: string) {
  return applied.get(draftKey);
}

/** Remembers the quote a draft now carries, for the composer's next mount. */
export function rememberQuote(draftKey: string, quote: AppliedQuote) {
  applied.set(draftKey, quote);
}

/** Forgets a draft's quote. Call it wherever the draft itself is cleared. */
export function forgetQuote(draftKey: string) {
  applied.delete(draftKey);
}
