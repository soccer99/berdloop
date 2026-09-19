/**
 * Cmd+Enter (macOS) and Ctrl+Enter (Windows, Linux) send from a text input.
 *
 * Kept pure and free of DOM or React imports so both composers share one
 * answer: a keystroke either sends or it does not, and the guards that already
 * protect the send path decide it, not each call site's own re-reading of them.
 */

export interface SendKeystroke {
  key: string;
  /** macOS Cmd. */
  metaKey?: boolean;
  /** Windows and Linux Ctrl, so the same muscle memory works everywhere. */
  ctrlKey?: boolean;
  /** Shift+Enter is a newline, never a send. */
  shiftKey?: boolean;
  /** Read from `event.nativeEvent.isComposing`: an IME is mid-word. */
  isComposing?: boolean;
}

export interface SendState {
  text: string;
  busy?: boolean;
}

/**
 * True only for a send. Whitespace-only text, a busy composer and an active IME
 * composition all fall through to the input's normal behaviour, which keeps a
 * half-typed CJK word from being sent as if it were finished.
 */
export function shouldSendOnKey(
  keystroke: SendKeystroke,
  state: SendState,
): boolean {
  if (keystroke.key !== "Enter") return false;
  if (!keystroke.metaKey && !keystroke.ctrlKey) return false;
  if (keystroke.shiftKey) return false;
  if (keystroke.isComposing) return false;
  if (state.busy) return false;
  return state.text.trim().length > 0;
}
