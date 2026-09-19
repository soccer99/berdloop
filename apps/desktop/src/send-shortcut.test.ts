import { describe, expect, test } from "bun:test";
import { shouldSendOnKey, type SendKeystroke } from "./send-shortcut";

const cmd: SendKeystroke = { key: "Enter", metaKey: true };
const ctrl: SendKeystroke = { key: "Enter", ctrlKey: true };
const ready = { text: "Ship it" };

describe("the send shortcut", () => {
  test("Cmd+Enter and Ctrl+Enter both send, so one habit works on every platform", () => {
    expect(shouldSendOnKey(cmd, ready)).toBe(true);
    expect(shouldSendOnKey(ctrl, ready)).toBe(true);
  });
  test("Enter alone leaves the input to decide, and Shift+Enter stays a newline", () => {
    expect(shouldSendOnKey({ key: "Enter" }, ready)).toBe(false);
    expect(shouldSendOnKey({ key: "Enter", shiftKey: true }, ready)).toBe(
      false,
    );
    expect(shouldSendOnKey({ ...cmd, shiftKey: true }, ready)).toBe(false);
  });
  test("another key with the same modifier is not a send", () => {
    expect(shouldSendOnKey({ ...cmd, key: "a" }, ready)).toBe(false);
    expect(shouldSendOnKey({ ...cmd, key: "Escape" }, ready)).toBe(false);
    expect(shouldSendOnKey({ ...ctrl, key: "NumpadEnter" }, ready)).toBe(false);
  });
});

describe("the guards on the send path", () => {
  test("never sends empty or whitespace-only text", () => {
    expect(shouldSendOnKey(cmd, { text: "" })).toBe(false);
    expect(shouldSendOnKey(cmd, { text: "   \n\t " })).toBe(false);
  });
  test("never sends while a send is already in flight", () => {
    expect(shouldSendOnKey(cmd, { ...ready, busy: true })).toBe(false);
    expect(shouldSendOnKey(ctrl, { ...ready, busy: true })).toBe(false);
  });
  test("never sends a half-typed word while an IME composition is active", () => {
    expect(shouldSendOnKey({ ...cmd, isComposing: true }, ready)).toBe(false);
    expect(shouldSendOnKey({ ...ctrl, isComposing: true }, ready)).toBe(false);
  });
});
