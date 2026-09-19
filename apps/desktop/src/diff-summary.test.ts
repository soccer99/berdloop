import { describe, expect, test } from "bun:test";
import {
  countDiffLines,
  summariseFile,
  truncatePath,
  verbFor,
} from "./diff-summary";
import type { ChangedFile } from "./changes-panel";

const diff = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,4 +10,5 @@ function foo() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " return a;",
  "@@ -40,3 +41,2 @@",
  "-old();",
  "-older();",
  "+new();",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("countDiffLines", () => {
  test("counts both hunks and skips the file headers", () => {
    expect(countDiffLines(diff)).toEqual({ added: 3, removed: 3 });
  });

  test("counts nothing in an empty diff", () => {
    expect(countDiffLines("")).toEqual({ added: 0, removed: 0 });
  });
});

describe("verbFor", () => {
  test("has a word for every status", () => {
    expect(verbFor("A")).toBe("added");
    expect(verbFor("M")).toBe("edited");
    expect(verbFor("D")).toBe("deleted");
    expect(verbFor("R")).toBe("renamed");
  });
});

describe("truncatePath", () => {
  test("leaves a short path alone", () => {
    expect(truncatePath("src/foo.ts")).toBe("src/foo.ts");
  });

  test("leaves a path of exactly the full width alone", () => {
    const path = "a".repeat(48);
    expect(path.length).toBe(48);
    expect(truncatePath(path)).toBe(path);
  });

  test("cuts a long path from the left and keeps the filename whole", () => {
    const short = truncatePath(
      "apps/desktop/src/components/very/deep/nesting/queue.tsx",
    );
    expect(short).toBe("…src/components/very/deep/nesting/queue.tsx");
    expect(short.length).toBeLessThanOrEqual(48);
  });

  test("keeps a filename that is wider than the whole allowance", () => {
    const name = `${"n".repeat(60)}.ts`;
    expect(truncatePath(`src/${name}`)).toBe(`…${name}`);
  });

  test("takes the width as an argument", () => {
    expect(truncatePath("apps/desktop/src/queue.tsx", 20)).toBe(
      "…src/queue.tsx",
    );
  });
});

describe("summariseFile", () => {
  test("gives the chat row its verb, paths and counts", () => {
    const file: ChangedFile = {
      path: "apps/desktop/src/foo.ts",
      status: "M",
      fingerprint: "abc",
      diff,
    };
    expect(summariseFile(file)).toEqual({
      verb: "edited",
      display: "apps/desktop/src/foo.ts",
      path: "apps/desktop/src/foo.ts",
      added: 3,
      removed: 3,
    });
  });

  test("shortens a long path but keeps the whole one as well", () => {
    const path = "apps/desktop/src/components/very/deep/nesting/queue.tsx";
    const summary = summariseFile({
      path,
      status: "A",
      fingerprint: "def",
      diff: "@@ -0,0 +1,2 @@\n+one\n+two\n",
    });
    expect(summary).toEqual({
      verb: "added",
      display: "…src/components/very/deep/nesting/queue.tsx",
      path,
      added: 2,
      removed: 0,
    });
  });
});
