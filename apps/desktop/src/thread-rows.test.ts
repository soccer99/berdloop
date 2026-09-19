import { describe, expect, test } from "bun:test";
import { threadRows } from "./thread-rows";
import type { ThreadMessage } from "./workflow-ui";

/**
 * A tool call the harness reported, as the thread stores it.
 *
 * The text is the line the native side builds: the tool, what it was called
 * with, and its whole input under that. A `path` is set only where the call
 * wrote a file.
 */
function tool(id: string, name: string, path?: string): ThreadMessage {
  const label = path ? `${name} · ${path}` : name;
  return { id, role: "tool", text: `${label}\n{\n  "run": 1\n}`, path };
}

function said(id: string, text: string): ThreadMessage {
  return { id, role: "agent", text };
}

describe("threadRows", () => {
  test("two edits of two files are two rows, in the order touched", () => {
    const rows = threadRows([
      tool("1", "Edit", "apps/desktop/src/queue.tsx"),
      tool("2", "Edit", "apps/desktop/src/diff.ts"),
    ]);
    expect(rows.map((row) => row.files)).toEqual([
      [{ path: "apps/desktop/src/queue.tsx", status: "M" }],
      [{ path: "apps/desktop/src/diff.ts", status: "M" }],
    ]);
  });

  test("a call that wrote a file is its row and not also a tool line", () => {
    const [row] = threadRows([tool("1", "Write", "src/new.ts")]);
    expect(row?.text).toBe("");
    expect(row?.files).toEqual([{ path: "src/new.ts", status: "M" }]);
  });

  test("a call that wrote nothing keeps its line and gains no row", () => {
    const [row] = threadRows([tool("1", "Bash")]);
    expect(row?.text.split("\n")[0]).toBe("Bash");
    expect(row?.files).toEqual([]);
  });

  test("a file edited again keeps its first row and gains no second", () => {
    const rows = threadRows([
      tool("1", "Edit", "src/a.ts"),
      tool("2", "Edit", "src/a.ts"),
      tool("3", "Edit", "src/b.ts"),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["1", "3"]);
  });

  test("words are kept, and a diff pasted into them becomes a row", () => {
    const rows = threadRows([
      said(
        "1",
        [
          "Fixed it.",
          "",
          "--- a/src/foo.ts",
          "+++ b/src/foo.ts",
          "@@ -1 +1 @@",
          "-old();",
          "+new();",
        ].join("\n"),
      ),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("Fixed it.");
    expect(rows[0]?.files).toEqual([{ path: "src/foo.ts", status: "M" }]);
  });

  test("a pasted diff of a file already rowed by its tool call repeats nothing", () => {
    const rows = threadRows([
      tool("1", "Edit", "src/foo.ts"),
      said(
        "2",
        [
          "--- a/src/foo.ts",
          "+++ b/src/foo.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
      ),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["1"]);
  });

  test("an ordinary message is left exactly as it came", () => {
    const rows = threadRows([said("1", "I read the file and it looked fine.")]);
    expect(rows[0]?.text).toBe("I read the file and it looked fine.");
    expect(rows[0]?.files).toEqual([]);
  });
});
