import { describe, expect, test } from "bun:test";
import {
  canMerge,
  migrateTasks,
  sampleProjects,
  sampleTasks,
  starterProjectId,
  type MergeEvidence,
} from "./index";
const ready: MergeEvidence = {
  head: "abc",
  reviewedHead: "abc",
  testedHead: "abc",
  checksPassed: true,
  reviewApproved: true,
  hasConflicts: false,
};
describe("merge evidence", () => {
  test("accepts a checked and reviewed candidate", () =>
    expect(canMerge(ready)).toBe(true));
  test("requires new evidence after a conflict fix", () =>
    expect(canMerge({ ...ready, head: "fixed" })).toBe(false));
  test("rejects unresolved conflicts", () =>
    expect(canMerge({ ...ready, hasConflicts: true })).toBe(false));
  test("rejects failed checks and rejected review", () => {
    expect(canMerge({ ...ready, checksPassed: false })).toBe(false);
    expect(canMerge({ ...ready, reviewApproved: false })).toBe(false);
  });
  test("rejects missing or stale evidence", () => {
    expect(canMerge({ ...ready, testedHead: "old" })).toBe(false);
    expect(
      canMerge({ ...ready, head: "", testedHead: "", reviewedHead: "" }),
    ).toBe(false);
  });
});

describe("task project migration", () => {
  test("places older local drafts in the starter project without changing their content", () => {
    const { projectId: _projectId, ...legacyTask } = sampleTasks[0];
    expect(migrateTasks([legacyTask], sampleProjects)).toEqual([
      { ...legacyTask, projectId: starterProjectId },
    ]);
  });
  test("preserves valid project links and repairs missing projects", () => {
    expect(
      migrateTasks(
        [sampleTasks[2], { ...sampleTasks[0], projectId: "deleted" }],
        sampleProjects,
      ).map((task) => task.projectId),
    ).toEqual(["demo-history", starterProjectId]);
  });
});
