import { describe, expect, test } from "bun:test";
import { parseDiff, quoteLine } from "./diff";

describe("parseDiff", () => {
  test("numbers the lines of every hunk", () => {
    const hunks = parseDiff(
      [
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
        "@@ -40,2 +41,2 @@",
        "-old();",
        "+new();",
        "",
      ].join("\n"),
    );
    expect(hunks.length).toBe(2);
    expect(hunks[0]!.header).toBe("@@ -10,4 +10,5 @@ function foo() {");
    expect(hunks[0]!.lines).toEqual([
      { kind: "ctx", old: 10, new: 10, text: "const a = 1;" },
      { kind: "del", old: 11, text: "const b = 2;" },
      { kind: "add", new: 11, text: "const b = 3;" },
      { kind: "add", new: 12, text: "const c = 4;" },
      { kind: "ctx", old: 12, new: 13, text: "return a;" },
    ]);
    expect(hunks[1]!.lines).toEqual([
      { kind: "del", old: 40, text: "old();" },
      { kind: "add", new: 41, text: "new();" },
    ]);
  });

  test("reads an added file", () => {
    const hunks = parseDiff(
      [
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/new.ts",
        "@@ -0,0 +1,2 @@",
        "+export const one = 1;",
        "+export const two = 2;",
        "",
      ].join("\n"),
    );
    expect(hunks[0]!.lines).toEqual([
      { kind: "add", new: 1, text: "export const one = 1;" },
      { kind: "add", new: 2, text: "export const two = 2;" },
    ]);
  });

  test("reads a deleted file", () => {
    const hunks = parseDiff(
      [
        "deleted file mode 100644",
        "--- a/src/old.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-export const one = 1;",
        "-export const two = 2;",
        "",
      ].join("\n"),
    );
    expect(hunks[0]!.lines).toEqual([
      { kind: "del", old: 1, text: "export const one = 1;" },
      { kind: "del", old: 2, text: "export const two = 2;" },
    ]);
  });

  test("reads a rename with no content change", () => {
    expect(
      parseDiff(
        [
          "diff --git a/src/a.ts b/src/b.ts",
          "similarity index 100%",
          "rename from src/a.ts",
          "rename to src/b.ts",
          "",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("ignores the no-newline marker", () => {
    const hunks = parseDiff(
      [
        "@@ -1,1 +1,1 @@",
        "-last",
        "\\ No newline at end of file",
        "+last line",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(hunks[0]!.lines).toEqual([
      { kind: "del", old: 1, text: "last" },
      { kind: "add", new: 1, text: "last line" },
    ]);
  });

  test("returns nothing for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("\n")).toEqual([]);
  });
});

describe("quoteLine", () => {
  test("quotes a new-file line", () => {
    expect(
      quoteLine("src/foo.ts", { kind: "add", new: 42, text: "const x = 1;" }),
    ).toBe("In `src/foo.ts` line 42:\n> const x = 1;\n\n");
  });

  test("quotes a removed line by its old number", () => {
    expect(
      quoteLine("src/foo.ts", { kind: "del", old: 7, text: "const x = 0;" }),
    ).toBe("In `src/foo.ts` old line 7:\n> const x = 0;\n\n");
  });

  test("quotes a whole file without a line", () => {
    expect(quoteLine("src/foo.ts")).toBe("In `src/foo.ts`:\n\n");
  });
});
