import type { AgentRole } from "./tools";

/**
 * What every Berdloop worker is told before it starts.
 *
 * These are plain documents on purpose. To change how workers behave, edit
 * the text below; nothing else has to change. `renderRules` turns the list
 * into the block of instructions that goes to whichever harness is running.
 *
 * Keep each rule short. A worker reads all of this on every single task,
 * because it starts with an empty context every time.
 */

export interface RuleDoc {
  id: string;
  title: string;
  body: string;
  /** Which agents are told this. Left out means all of them. */
  roles?: AgentRole[];
}

/**
 * A procedure a worker follows when something specific happens.
 *
 * `when` is the trigger. A worker matches on it, so write it as the
 * situation, not as a title.
 */
export interface SkillDoc {
  id: string;
  when: string;
  steps: string[];
  /** Which agents are told this. Left out means all of them. */
  roles?: AgentRole[];
}

export const rules: RuleDoc[] = [
  {
    id: "how-berdloop-works",
    title: "How Berdloop works",
    body: [
      "A ticket is split into small tasks. You have been given exactly one of them.",
      "Several workers run at the same time, each on a different task.",
      "You start with an empty context on every task. You cannot remember an earlier run, and no other worker can tell you anything.",
      "Everything you need is in your brief and in the repository.",
    ].join("\n"),
  },
  {
    id: "your-worktree",
    roles: ["worker"],
    title: "Your worktree",
    body: [
      "You have your own directory and your own git branch. No other worker can see inside it.",
      "Work only there. Never change files in another worker's directory.",
      "Keep your change as small as the task allows. A large change is hard to merge.",
      "Commit your work. Uncommitted changes cannot be merged.",
    ].join("\n"),
  },
  {
    id: "merging",
    roles: ["worker"],
    title: "Merging your work",
    body: [
      "Your branch is scratch space. The ticket branch is what counts.",
      "Only one worker merges at a time, so you must ask for a place in the merge queue and wait your turn.",
      "On your turn: bring the ticket branch into your worktree, fix anything that clashes, commit, then move the ticket branch onto your work.",
      "You fix conflicts in your own directory, where nobody else is working. The ticket branch is never left broken.",
      "Give your place up as soon as you are done. Other workers are waiting.",
    ].join("\n"),
  },
  {
    id: "finishing",
    title: "Finishing",
    body: [
      "Stop when your one task is done. Do not start another task.",
      "Prove the task is done by running a check, not by reading the code.",
      "Report the outcome, whether it worked or not. A blocked task that is reported is useful. A silent one is not.",
    ].join("\n"),
  },
];

export const skills: SkillDoc[] = [
  {
    id: "fix-merge-conflicts",
    roles: ["worker"],
    when: "merge_sync reports conflicted files",
    steps: [
      "Read every conflicted file. The markers show your change and the ticket's change.",
      "Keep both intentions. The other change came from a worker solving a different part of the same ticket, so it is not wrong.",
      "Delete every conflict marker. Search for them again before you continue.",
      "Run the project's build or tests to prove the merged file still works.",
      "Commit the resolution, then call merge_land.",
      "If the two changes genuinely cannot both stand, stop and report the task as blocked. Do not silently drop the other worker's work.",
    ],
  },
  {
    id: "merge-was-refused",
    roles: ["worker"],
    when: "merge_land refuses because the ticket moved",
    steps: [
      "Another worker landed while you were resolving. This is normal.",
      "Call merge_sync again to take in their work.",
      "Fix anything that clashes, commit, then call merge_land again.",
      "Repeat until it lands. Do not force anything.",
    ],
  },
  {
    id: "a-command-was-refused",
    roles: ["worker"],
    when: "a command you need is refused, or you cannot do something the task needs",
    steps: [
      "Do not look for a way around it. A refusal is a decision somebody made on purpose.",
      "Call ask_human with the exact command in --command. The person can then allow it with one click.",
      "It waits for an answer, so carry on only once you have one.",
      "If the answer is a refusal, do not retry it. Find another way, or report the task as blocked saying what was refused.",
    ],
  },
  {
    id: "cannot-finish",
    roles: ["worker"],
    when: "the task cannot be completed",
    steps: [
      "Do not guess, and do not widen the task to get around the problem.",
      "Commit whatever part is sound, so the next attempt starts further along.",
      "Release your merge queue place if you hold one.",
      "Report the task as blocked and say exactly what stopped you.",
    ],
  },
];

/** Keep only what this role is told. A document with no roles is for everyone. */
export function forRole<T extends { roles?: AgentRole[] }>(
  docs: T[],
  role: AgentRole,
): T[] {
  return docs.filter((doc) => !doc.roles || doc.roles.includes(role));
}

export function renderRules(docs: RuleDoc[] = rules): string {
  return docs.map((doc) => `## ${doc.title}\n${doc.body}`).join("\n\n");
}

export function renderSkills(docs: SkillDoc[] = skills): string {
  return docs
    .map(
      (doc) =>
        `### When ${doc.when}\n${doc.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
    )
    .join("\n\n");
}
