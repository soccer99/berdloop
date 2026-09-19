import { describe, expect, test } from "bun:test";
import {
  diffFiles,
  parseDiff,
  quoteLine,
  stripDiffBodies,
  stripToolBodies,
} from "./diff";

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

describe("stripDiffBodies", () => {
  test("a fenced diff loses the hunk and keeps the prose", () => {
    const message = [
      "I widened the timeout, because the merge queue was outrunning it.",
      "",
      "```diff",
      "diff --git a/src/queue.ts b/src/queue.ts",
      "index 1111111..2222222 100644",
      "--- a/src/queue.ts",
      "+++ b/src/queue.ts",
      "@@ -10,3 +10,3 @@ function wait() {",
      " const start = now();",
      "-const limit = 1000;",
      "+const limit = 5000;",
      "```",
      "",
      "Tests pass. Merging next.",
    ].join("\n");
    expect(stripDiffBodies(message)).toBe(
      [
        "I widened the timeout, because the merge queue was outrunning it.",
        "",
        "Tests pass. Merging next.",
      ].join("\n"),
    );
  });

  test("an unfenced diff goes, header and all", () => {
    expect(
      stripDiffBodies(
        [
          "Here is what changed:",
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1,2 +1,2 @@",
          "-const one = 1;",
          "+const one = 2;",
          "That is the whole of it.",
        ].join("\n"),
      ),
    ).toBe("Here is what changed:\nThat is the whole of it.");
  });

  test("a bare hunk goes without any header above it", () => {
    expect(
      stripDiffBodies(
        ["Before", "@@ -3,2 +3,2 @@", "-old();", "+new();", "After"].join("\n"),
      ),
    ).toBe("Before\nAfter");
  });

  test("an unlabelled fence holding a diff goes too", () => {
    expect(
      stripDiffBodies(
        ["Look:", "```", "@@ -1 +1 @@", "-a", "+b", "```", "Done."].join("\n"),
      ),
    ).toBe("Look:\nDone.");
  });

  test("a message that is only a diff strips to nothing", () => {
    expect(stripDiffBodies(["@@ -1 +1 @@", "-a", "+b"].join("\n"))).toBe("");
  });

  test("text with no diff in it comes back untouched", () => {
    const message = [
      "Two things to note:",
      "",
      "- the worker merged first",
      "- the rest is markdown, not a diff",
      "",
      "---",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "+1 to landing it.",
    ].join("\n");
    expect(stripDiffBodies(message)).toBe(message);
  });

  test("a code fence keeps every line of its code", () => {
    const message = ["```sh", "git diff", "- not a deletion", "```"].join("\n");
    expect(stripDiffBodies(message)).toBe(message);
  });

  test("a bullet list under a hunk survives", () => {
    expect(
      stripDiffBodies(
        [
          "@@ -1,2 +1,2 @@",
          "-a",
          "+b",
          "",
          "- and then I ran the tests",
          "- they pass",
        ].join("\n"),
      ),
    ).toBe("- and then I ran the tests\n- they pass");
  });
});

describe("diffFiles", () => {
  test("names nothing when the message holds no diff", () => {
    expect(diffFiles("I read the file and it looked fine.")).toEqual([]);
  });

  test("names every file of a git diff, in the order written", () => {
    const message = [
      "Done. Here is what changed:",
      "",
      "```diff",
      "diff --git a/apps/desktop/src/queue.tsx b/apps/desktop/src/queue.tsx",
      "index 1111111..2222222 100644",
      "--- a/apps/desktop/src/queue.tsx",
      "+++ b/apps/desktop/src/queue.tsx",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "diff --git a/apps/desktop/src/diff.ts b/apps/desktop/src/diff.ts",
      "--- a/apps/desktop/src/diff.ts",
      "+++ b/apps/desktop/src/diff.ts",
      "@@ -1,1 +1,2 @@",
      " keep",
      "+added",
      "```",
    ].join("\n");
    expect(diffFiles(message)).toEqual([
      { path: "apps/desktop/src/queue.tsx", status: "M" },
      { path: "apps/desktop/src/diff.ts", status: "M" },
    ]);
  });

  test("reads added, deleted and renamed from the headers", () => {
    const message = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/src/was.ts b/src/now.ts",
      "similarity index 98%",
      "rename from src/was.ts",
      "rename to src/now.ts",
    ].join("\n");
    expect(diffFiles(message)).toEqual([
      { path: "src/new.ts", status: "A" },
      { path: "src/gone.ts", status: "D" },
      { path: "src/now.ts", status: "R" },
    ]);
  });

  test("reads a bare --- / +++ pair with no git header above it", () => {
    const message = [
      "--- a/src/foo.ts\t2024-01-01",
      "+++ b/src/foo.ts\t2024-01-02",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(diffFiles(message)).toEqual([{ path: "src/foo.ts", status: "M" }]);
  });

  test("a removed line reading like a header is not one", () => {
    const message = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,3 +1,2 @@",
      "--- a/old/rule.md",
      "+kept",
    ].join("\n");
    expect(diffFiles(message)).toEqual([{ path: "README.md", status: "M" }]);
  });

  test("a file quoted twice in one message is one row", () => {
    const message = [
      "First pass:",
      "",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
      "Then I fixed it:",
      "",
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "-b",
      "+c",
      "",
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -2 +2 @@",
      "-d",
      "+e",
    ].join("\n");
    expect(diffFiles(message)).toEqual([{ path: "src/foo.ts", status: "M" }]);
  });

  test("a bullet list that looks like prose names no file", () => {
    expect(diffFiles("- one\n- two\n--- a rule\n")).toEqual([]);
  });
});

/** A tool line as the native side builds it: head, then the whole input. */
function toolLine(name: string, input: unknown): string {
  const detail = JSON.stringify(input, null, 2);
  return `${name} · ${String((input as { file_path?: string }).file_path ?? "")}\n${detail}`;
}

describe("stripToolBodies", () => {
  test("an Edit's before and after never reach the thread", () => {
    const line = toolLine("Edit", {
      file_path: "apps/desktop/src/queue.tsx",
      old_string: "function Log({\n  messages,\n}) {\n  return null;\n}",
      new_string:
        "function Log({\n  messages,\n  changes,\n}) {\n  return null;\n}",
    });
    const out = stripToolBodies(line);
    // The head line still says what was called, and on which file.
    expect(out.split("\n")[0]).toBe("Edit · apps/desktop/src/queue.tsx");
    // Neither side of the change is in it, under any escaping.
    expect(out).not.toContain("function Log");
    expect(out).not.toContain("return null");
    expect(out).not.toContain("changes,");
    // The file path is kept: it is what the line is about.
    expect(out).toContain('"file_path": "apps/desktop/src/queue.tsx"');
    expect(out).toContain('"old_string": "… read it in the Changes tab"');
    expect(out).toContain('"new_string": "… read it in the Changes tab"');
  });

  test("a Write's whole new file goes the same way", () => {
    const out = stripToolBodies(
      toolLine("Write", {
        file_path: "src/new.ts",
        content: "export const answer = 42;\n",
      }),
    );
    expect(out).not.toContain("answer = 42");
    expect(out).toContain('"content": "… read it in the Changes tab"');
  });

  test("a MultiEdit's nested edits go too", () => {
    const out = stripToolBodies(
      toolLine("MultiEdit", {
        file_path: "src/foo.ts",
        edits: [{ old_string: "const a = 1;", new_string: "const a = 2;" }],
      }),
    );
    expect(out).not.toContain("const a =");
  });

  test("an input clamped mid-string still loses its change body", () => {
    // The native side cuts the pretty-printed input at 4000 characters, so
    // the last field can end without its closing quote.
    const line = 'Edit · src/foo.ts\n{\n  "old_string": "const secret = 1;…';
    const out = stripToolBodies(line);
    expect(out).not.toContain("const secret");
    expect(out).toContain('"old_string": "… read it in the Changes tab"');
  });

  test("a patch carried inside a Bash command is taken out of it", () => {
    const out = stripToolBodies(
      toolLine("Bash", {
        command:
          "git apply <<'EOF'\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old();\n+new();\nEOF",
        description: "apply the patch",
      }),
    );
    expect(out).not.toContain("@@ -1 +1 @@");
    expect(out).not.toContain("-old();");
    expect(out).not.toContain("+new();");
    // What was said around it survives, and so does the other field.
    expect(out).toContain("git apply");
    expect(out).toContain('"description": "apply the patch"');
  });

  test("a raw command, not JSON, is swept the same way", () => {
    // Codex sends the command itself under the head line, not an object.
    const out = stripToolBodies(
      [
        "command_execution · git apply",
        "git apply <<'EOF'",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1 +1 @@",
        "-old();",
        "+new();",
        "EOF",
      ].join("\n"),
    );
    expect(out).not.toContain("@@");
    expect(out).not.toContain("+new();");
    expect(out).toContain("git apply");
  });

  test("a tool line with no input is left exactly as it came", () => {
    expect(stripToolBodies("Bash")).toBe("Bash");
  });

  test("the fields that are not a change body are untouched", () => {
    const line = toolLine("Grep", {
      pattern: "old_string",
      path: "apps/desktop/src",
      description: "find the callers",
    });
    expect(stripToolBodies(line)).toBe(line);
  });
});
