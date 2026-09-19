export const stages = ["Branch", "Engineer", "Review", "Deploy"] as const;
export type Stage = (typeof stages)[number];
export type Harness = "Claude Code" | "Codex" | "omp" | "Custom";
export { harnessCatalog, sessionHarnesses } from "./harness-catalog";
export type TicketProvider = "Jira" | "Asana" | "Linear" | "Local";
export interface Organization {
  id: string;
  name: string;
}
export interface Project {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  path?: string;
  isGit?: boolean;
  branch?: string | null;
  remoteUrl?: string | null;
  provider?: string | null;
  /** How many workers the loop may run at once for this project. */
  workers?: number;
  /** Kept, but hidden from the project lists. Its tickets stay attached. */
  archived?: boolean;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  source: TicketProvider;
  ticket: string;
  stage: Stage;
  status: "running" | "paused" | "queued" | "review" | "complete";
  pullRequest?: {
    url: string;
    /** The exact published commit. Review and merge evidence apply to it only. */
    head: string;
    baseBranch: string;
    review: "pending" | "changes-requested" | "approved";
    summary?: string;
    /** The commit the recorded review looked at. Stale when it differs from head. */
    reviewedHead?: string;
    merged?: boolean;
  };
  /** Who merges the final pull request. Kept with the ticket, not in the browser. */
  mergePolicy?: "manual" | "automatic";
  criteria: string;
  /** Stable ID returned by a provider. Absent for manually entered references. */
  sourceId?: string;
  sourceUrl?: string;
  sourceStatus?: string;
  updatedAt?: string;
}
/** What a worker is doing right now, as every surface reports it. */
export type AgentActivity =
  | "queued"
  | "coding"
  | "testing"
  | "reviewing"
  | "waiting-for-human"
  | "waiting-to-merge"
  | "merging"
  | "fixing-conflicts"
  | "paused"
  | "blocked"
  /** The work is finished but has not reached the ticket branch yet. */
  | "done"
  /** Landed on the ticket branch. The only state that means the work counts. */
  | "merged";
export * from "./task-system";
export * from "./task-repository";
export interface StageAssignment {
  harness: Harness;
  model: string;
}
export const starterOrganizationId = "demo-org";
export const starterProjectId = "demo-project";
export const sampleOrganizations: Organization[] = [
  { id: starterOrganizationId, name: "Berdloop" },
];
export const sampleProjects: Project[] = [
  {
    id: starterProjectId,
    organizationId: starterOrganizationId,
    name: "Desktop workflow",
    description: "Plan and track local tasks",
  },
  {
    id: "demo-history",
    organizationId: starterOrganizationId,
    name: "Task history",
    description: "Track work as it moves through the loop",
  },
];
export const defaultAssignments: Record<Stage, StageAssignment> = {
  Branch: { harness: "Claude Code", model: "Default" },
  Engineer: { harness: "Codex", model: "Default" },
  Review: { harness: "Claude Code", model: "Default" },
  Deploy: { harness: "Codex", model: "Default" },
};
export const sampleTasks: Task[] = [
  {
    id: "demo-1",
    projectId: starterProjectId,
    title: "Prepare the local task flow",
    source: "Linear",
    ticket: "BRD-128",
    stage: "Engineer",
    status: "running",
    criteria:
      "Create a task, add acceptance criteria, and save a direction locally.",
  },
  {
    id: "demo-2",
    projectId: starterProjectId,
    title: "Check task status rules",
    source: "Jira",
    ticket: "APP-42",
    stage: "Review",
    status: "running",
    criteria:
      "A queued task can be paused and resumed. Existing status checks pass.",
  },
  {
    id: "demo-3",
    projectId: "demo-history",
    title: "Show task history",
    source: "Asana",
    ticket: "Task history",
    stage: "Branch",
    status: "queued",
    criteria:
      "Show each task event in time order. Show an empty state when no events exist.",
  },
];
export function migrateTasks(
  tasks: Array<Omit<Task, "projectId"> & { projectId?: string }>,
  projects: Project[],
): Task[] {
  const validIds = new Set(projects.map((project) => project.id));
  const fallbackId =
    projects.find((project) => project.id === starterProjectId)?.id ??
    projects[0]?.id ??
    starterProjectId;
  return tasks.map((task) => ({
    ...task,
    projectId:
      task.projectId && validIds.has(task.projectId)
        ? task.projectId
        : fallbackId,
  }));
}
export interface MergeEvidence {
  head: string;
  reviewedHead: string;
  testedHead: string;
  checksPassed: boolean;
  reviewApproved: boolean;
  hasConflicts: boolean;
}
// A conflict fix changes the candidate: tests and review must apply to the new head.
export function canMerge(evidence: MergeEvidence): boolean {
  return (
    Boolean(evidence.head) &&
    evidence.head === evidence.reviewedHead &&
    evidence.head === evidence.testedHead &&
    evidence.checksPassed &&
    evidence.reviewApproved &&
    !evidence.hasConflicts
  );
}
