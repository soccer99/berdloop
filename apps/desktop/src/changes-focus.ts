/**
 * Sending a thread row's file to the Changes tab.
 *
 * The click is an event, not a state: the same file asked for twice must land
 * on it twice, so a request carries a rising id rather than only a path, and
 * the panel acts on an id it has not answered yet. The task is carried too,
 * because a request made on one worker must not open a file on the next one
 * opened.
 *
 * A row whose file the changes command does not report has no diff to show,
 * and asking for it would land on an empty tab, so it makes no request at all.
 * That is the same rule the row itself draws by, kept in one place.
 */
import type { ChangedFile } from "./changes-panel";

/** The file the panel is asked to show. */
export interface FileFocus {
  /** Rises with every ask, so asking twice is two events, not one. */
  id: number;
  path: string;
}

/** A focus, and the task whose rows asked for it. */
export interface FocusRequest extends FileFocus {
  taskId: string;
}

/**
 * The request a row click makes, or the one already standing when the file
 * has no diff to show.
 */
export function focusFile(
  current: FocusRequest | undefined,
  taskId: string,
  path: string,
  files: ChangedFile[] | undefined,
): FocusRequest | undefined {
  if (!files?.some((file) => file.path === path)) return current;
  return { id: (current?.id ?? 0) + 1, taskId, path };
}

/** The focus this task's panel should act on, if the request was made on it. */
export function focusFor(
  request: FocusRequest | undefined,
  taskId: string,
): FileFocus | undefined {
  if (!request || request.taskId !== taskId) return undefined;
  return { id: request.id, path: request.path };
}
