import { describe, expect, test } from "bun:test";
import { focusFile, focusFor, type FocusRequest } from "./changes-focus";
import type { ChangedFile } from "./changes-panel";

const file = (path: string): ChangedFile => ({
  path,
  status: "M",
  fingerprint: "abc",
  diff: "@@ -1 +1 @@\n-a\n+b\n",
});
const files = [file("apps/desktop/src/queue.tsx"), file("README.md")];

describe("focusFile", () => {
  test("asks for a file the changes report", () => {
    expect(focusFile(undefined, "task", "README.md", files)).toEqual({
      id: 1,
      taskId: "task",
      path: "README.md",
    });
  });

  test("the same file asked for twice is two requests", () => {
    const first = focusFile(undefined, "task", "README.md", files);
    const second = focusFile(first, "task", "README.md", files);
    expect(second?.path).toBe("README.md");
    expect(second?.id).toBe(first!.id + 1);
  });

  test("a row with no diff to show asks for nothing", () => {
    expect(focusFile(undefined, "task", "untracked.ts", files)).toBeUndefined();
  });

  test("a row with no diff to show leaves a standing request alone", () => {
    const standing = focusFile(undefined, "task", "README.md", files);
    expect(focusFile(standing, "task", "untracked.ts", files)).toBe(standing!);
  });

  test("asks for nothing before the changes have arrived", () => {
    expect(
      focusFile(undefined, "task", "README.md", undefined),
    ).toBeUndefined();
  });
});

describe("focusFor", () => {
  const request: FocusRequest = { id: 3, taskId: "task", path: "README.md" };

  test("hands the panel the file its own task asked for", () => {
    expect(focusFor(request, "task")).toEqual({ id: 3, path: "README.md" });
  });

  test("a request made on one task does not open a file on another", () => {
    expect(focusFor(request, "other")).toBeUndefined();
  });

  test("no request, no focus", () => {
    expect(focusFor(undefined, "task")).toBeUndefined();
  });
});
