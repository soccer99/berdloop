/**
 * The new-ticket form's three drafts: title, source reference and criteria.
 *
 * They are keyed on the project the ticket will be *created in*, never on the
 * project in view. The organization view has no project in view while the form
 * still resolves a real target project, so keying on the view let every
 * organization share one `new-ticket:none` draft: text typed under one
 * organization turned up in a form aimed at another.
 *
 * Because the key follows the target, re-aiming the Project select would drop
 * what has been typed. `moveNewTicketDrafts` carries it across, so changing the
 * project changes where the ticket lands and nothing else.
 */
import { removeDraft, saveDraft, type DraftOptions } from "./drafts";

/** The fields of the new-ticket form that hold unsent text. */
export type NewTicketField = "title" | "reference" | "criteria";

export const newTicketFields: NewTicketField[] = [
  "title",
  "reference",
  "criteria",
];

/**
 * The draft subject for one field of a ticket aimed at `projectId`. An empty
 * project id is the form before it has a target, which nothing can type into.
 */
export function newTicketDraftKey(projectId: string, field: NewTicketField) {
  return `new-ticket:${projectId || "none"}:${field}`;
}

/** One field's text on screen, and the committed text it opened with. */
export interface NewTicketDraftText {
  field: NewTicketField;
  text: string;
  /** What the field was seeded with, when it has a seed. */
  seed?: string;
}

/**
 * Re-aims the form's drafts from one project at another, carrying the text on
 * screen across. Pass the live values: they are newer than anything stored.
 * Aiming at the project already targeted leaves everything where it is.
 */
export function moveNewTicketDrafts(
  from: string,
  to: string,
  texts: NewTicketDraftText[],
  options: DraftOptions = {},
) {
  if (from === to) {
    return;
  }
  for (const { field, text, seed } of texts) {
    saveDraft(newTicketDraftKey(to, field), text, { ...options, seed });
    removeDraft(newTicketDraftKey(from, field), options);
  }
}
