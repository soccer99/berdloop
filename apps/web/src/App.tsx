import { useState } from "react";
import { Accordion, Badge, Button, Modal } from "@mantine/core";
import {
  IconArrowRight,
  IconArrowUpRight,
  IconBrandGithub,
  IconBuilding,
  IconCheck,
  IconFolder,
  IconGitBranch,
  IconGitPullRequest,
  IconLayoutDashboard,
  IconMessage,
  IconPlus,
  IconSettings,
  IconTerminal2,
} from "@tabler/icons-react";
import { Logo } from "@berdloop/ui";
import { harnessCatalog } from "@berdloop/core";
import BirdMigration from "./BirdMigration";
import SystemMap from "./SystemMap";

const features = [
  {
    number: "01",
    title: "Start with a ticket.",
    text: "Create a local ticket or import one from Linear, Jira, or Asana. Define its requirements, then split the work into agent tasks with clear criteria and dependencies.",
    detail: "Keep the plan in one project.",
    icon: IconMessage,
  },
  {
    number: "02",
    title: "See where each worker stands.",
    text: "The agent task view separates queued work from agent threads. Worker states cover building, testing, reviewing, and waiting to merge.",
    detail: "Task prompts and instructions stay with the work.",
    icon: IconTerminal2,
  },
  {
    number: "03",
    title: "Give merges a clear order.",
    text: "The merge queue shows workers waiting for the ticket branch. The planned workflow merges them one at a time, then opens one PR for independent review.",
    detail: "Final merge policy can be saved per ticket.",
    icon: IconGitPullRequest,
  },
];

const ticketFlow = [
  [
    "01",
    "Bring in a ticket",
    "Create a local ticket or import one from Linear, Jira, or Asana. Keep its source reference and requirements together.",
  ],
  [
    "02",
    "Plan the agent tasks",
    "Write prompts and acceptance criteria. Add dependencies so workers can see which tasks are ready next.",
  ],
  [
    "03",
    "Build, test, and review",
    "In the planned run, workers take ready tasks in separate worktrees. Their threads show progress from coding through tests and review.",
  ],
  [
    "04",
    "Wait in the merge queue",
    "A worker that has confirmed its change waits for its turn. The queue keeps ticket-branch merges in order.",
  ],
  [
    "05",
    "Merge and take the next task",
    "At its turn, a worker resolves conflicts, reruns checks if needed, merges into the ticket branch, and returns for more work.",
  ],
  [
    "06",
    "Review one ticket PR",
    "After the agent tasks land, one PR gets an independent review. Final merge follows the saved manual or automatic policy.",
  ],
] as const;
export default function App() {
  const [opened, setOpened] = useState(false);
  return (
    <div className="site">
      <BirdMigration />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header wrap">
        <a href="#" aria-label="Berdloop home">
          <Logo />
        </a>
        <nav aria-label="Main navigation">
          <a href="#workflow">The loop</a>
          <a href="#harnesses">Your tools</a>
          <a href="#questions">Questions</a>
        </nav>
        <Button
          variant="default"
          size="sm"
          rightSection={<IconArrowUpRight size={15} />}
          onClick={() => setOpened(true)}
        >
          Desktop preview
        </Button>
      </header>
      <main id="main">
        <section className="hero wrap">
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="live-dot" /> LOCAL FIRST · TICKETS TO MERGE QUEUE
            </div>
            <h1>
              Set the course.
              <br />
              <span>The flock takes it from there.</span>
            </h1>
            <p className="hero-description">
              Plan tickets and agent tasks in one place.
              <br />
              See the path from worker review to the merge queue.
            </p>
            <div className="hero-actions">
              <Button
                size="lg"
                rightSection={<IconArrowRight size={18} />}
                onClick={() => setOpened(true)}
              >
                Explore Berdloop
              </Button>
              <a className="text-link" href="#workflow">
                See how the loop works <span>↗</span>
              </a>
            </div>
            <p className="hero-note">
              <span className="tiny-square" /> Your machine. Your agent tools.
              Your control.
            </p>
          </div>
        </section>
        <SystemMap />
        <section
          className="product-preview wrap"
          aria-label="Desktop interface preview"
        >
          <div className="preview-titlebar">
            <div>
              <span />
              <span />
              <span />
            </div>
            <span>berdloop / workspace</span>
            <Badge size="sm" color="gray" variant="outline">
              Interface preview
            </Badge>
          </div>
          <div className="preview-body">
            <aside className="preview-sidebar">
              <div className="preview-brand">
                <Logo />
              </div>
              <p className="preview-nav-label">
                <IconBuilding size={12} /> ORGANIZATION
              </p>
              <div className="preview-selector">
                Berdloop <span>⌄</span>
              </div>
              <div>
                <IconLayoutDashboard size={15} /> Overview
              </div>
              <p className="preview-nav-label">
                <IconFolder size={12} /> PROJECTS
              </p>
              <div className="preview-project">
                <IconFolder size={15} /> berdloop <span>3</span>
              </div>
              <p className="preview-nav-label">WORKSPACE</p>
              <div className="sidebar-active">
                <IconLayoutDashboard size={15} /> Ticket queue
              </div>
              <div>
                <IconTerminal2 size={15} /> Agent sessions
              </div>
              <div>
                <IconSettings size={15} /> Harnesses &amp; models
              </div>
              <small className="sample-label">
                Sample project · local preview
              </small>
            </aside>
            <div className="preview-workspace">
              <div className="preview-app-header">
                <span>
                  Berdloop / berdloop / <strong>Agent tasks</strong>
                </span>
                <span>Local preview</span>
              </div>
              <div className="preview-notice">
                Local task workspace · Agent execution is in development
              </div>
              <div className="preview-content">
                <div className="preview-heading">
                  <div>
                    <span className="eyebrow">← BERDLOOP TICKETS</span>
                    <h2>Build the task flow</h2>
                    <p>
                      Linear · BERD-104{" "}
                      <span className="preview-status">Queued</span>
                    </p>
                  </div>
                  <span className="preview-new">
                    <IconPlus size={12} /> New ticket
                  </span>
                </div>
                <div className="preview-steps">
                  <span>01 &nbsp; Requirements</span>
                  <span className="active">
                    02 &nbsp; Agent tasks <small>3</small>
                  </span>
                  <span>03 &nbsp; Merge queue</span>
                  <span>04 &nbsp; PR &amp; review</span>
                </div>
                <div className="preview-coordinator">
                  <IconMessage size={17} />
                  <div>
                    <strong>Planning &amp; steering agent</strong>
                    <small>BERD-104 · Plan tasks and steer the workers</small>
                  </div>
                  <span>Saved locally</span>
                </div>
                <div className="preview-section-heading">
                  <strong>
                    Agent tasks <span>0/3 done</span>
                  </strong>
                  <span>+ Add agent task</span>
                </div>
                <div className="preview-columns">
                  <div className="preview-task-list">
                    <p>
                      AGENT THREADS <span>0</span>
                    </p>
                    <div className="preview-empty">
                      No agents working on this ticket.
                    </div>
                    <p>
                      QUEUED AGENT TASKS <span>3</span>
                    </p>
                    <div className="preview-task-row selected">
                      <IconGitBranch size={14} />
                      <span>
                        Define task stages<small>Ready for an agent</small>
                      </span>
                      <i />
                    </div>
                    <div className="preview-task-row">
                      <IconGitBranch size={14} />
                      <span>
                        Add pause handling<small>Depends on task stages</small>
                      </span>
                      <i />
                    </div>
                    <div className="preview-task-row">
                      <IconGitBranch size={14} />
                      <span>
                        Verify ticket review flow<small>Queued</small>
                      </span>
                      <i />
                    </div>
                  </div>
                  <div className="preview-thread">
                    <span className="preview-status">Queued</span>
                    <h3>Define task stages</h3>
                    <small>No agent assigned</small>
                    <div className="preview-prompt">
                      <strong>Queued prompt</strong>
                      <p>
                        Define the ticket task stages and acceptance criteria
                        for each step.
                      </p>
                    </div>
                    <div className="preview-thread-label">
                      <IconMessage size={14} /> Agent thread
                    </div>
                    <p className="preview-thread-empty">
                      No messages yet. Instructions and agent updates appear
                      here.
                    </p>
                    <div className="fake-input">
                      Add context for the agent that picks up this task…
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section id="harnesses" className="harness-strip wrap">
          <div>
            <span className="eyebrow">BRING YOUR OWN HARNESSES</span>
            <p>Use the agent tools you know.</p>
          </div>
          <div className="tool-list">
            {harnessCatalog.map((harness) => (
              <a
                key={harness.name}
                href={harness.url}
                target="_blank"
                rel="noreferrer"
              >
                <IconTerminal2 size={18} /> {harness.name}
                <small>
                  {harness.status === "sessions" ? "Sessions" : "Coming soon"}
                </small>
              </a>
            ))}
          </div>
          <p className="integration-note">
            Claude Code and Codex sessions work in the desktop app. Other
            harnesses are on the roadmap.
          </p>
        </section>
        <section id="workflow" className="workflow wrap">
          <div className="section-heading">
            <div className="eyebrow">PLAN · BUILD · REVIEW · MERGE</div>
            <h2>Every task has a place in the queue.</h2>
            <p>
              Berdloop keeps tickets, agent tasks, and instructions together.
              <br />
              The worker and merge stages show where the work goes next.
            </p>
          </div>
          <div className="feature-grid">
            {features.map((f) => (
              <article key={f.number}>
                <div className="feature-top">
                  <f.icon size={23} stroke={1.5} />
                  <span>{f.number}</span>
                </div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
                <div className="feature-detail">{f.detail}</div>
              </article>
            ))}
          </div>
          <div className="ticket-flow">
            <div className="ticket-flow-heading">
              <span className="eyebrow">PLANNED WORKER EXECUTION</span>
              <h3>From the ticket queue to one reviewed PR.</h3>
            </div>
            <ol className="ticket-flow-grid">
              {ticketFlow.map(([number, title, description]) => (
                <li key={number}>
                  <span>{number}</span>
                  <div>
                    <h4>{title}</h4>
                    <p>{description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div className="integration-row">
            <IconBrandGithub size={24} />
            <div>
              <h3>Keep the ticket branch and pull request together.</h3>
              <p>
                Workers wait their turn to merge into the ticket branch. After
                those changes land, one PR carries the ticket through review.
              </p>
            </div>
            <Badge variant="outline" color="gray">
              In development
            </Badge>
          </div>
        </section>
        <section className="control-section wrap">
          <div>
            <div className="eyebrow">ONE TICKET. CLEAR TASK CONTEXT.</div>
            <h2>
              Give direction.
              <br />
              Keep the thread.
            </h2>
            <p>
              Open a ticket to see its requirements, agent tasks, merge queue,
              and PR review step.
            </p>
            <p>
              Save instructions with the ticket or task. Set harness and model
              preferences for each stage while worker execution is being built.
            </p>
            <a href="#questions" className="text-link">
              Know what happens next <IconArrowRight size={15} />
            </a>
          </div>
          <div className="control-card">
            <span className="muted-label">THE WORKER PATH</span>
            {[
              [
                "Ready",
                "A task has a prompt, criteria, and clear dependencies.",
              ],
              ["Build", "A worker takes the task in its own worktree."],
              ["Review", "Tests and review confirm the candidate change."],
              ["Wait to merge", "The worker joins the ticket merge queue."],
            ].map(([a, b], i) => (
              <div className="contract-row" key={a}>
                <span>0{i + 1}</span>
                <div>
                  <strong>{a}</strong>
                  <p>{b}</p>
                </div>
                <IconCheck size={16} />
              </div>
            ))}
          </div>
        </section>
        <section id="questions" className="faq wrap">
          <div>
            <span className="eyebrow">BEFORE YOU START</span>
            <h2>A few clear answers.</h2>
            <Badge color="gray" variant="light">
              Cloud agents · Coming soon
            </Badge>
          </div>
          <Accordion variant="default">
            {[
              [
                "What is a Ralph loop?",
                "A Ralph loop repeats a focused task: build, run checks, review the result, and fix what failed. Berdloop's planned workers will use that loop in separate worktrees before they wait to merge.",
              ],
              [
                "Can I use my own agent tools?",
                "Claude Code and Codex sessions work in the desktop app. You can save harness and model preferences for each stage. More CLI harnesses and connected worker execution are in development.",
              ],
              [
                "Can I bring tasks from my issue tracker?",
                "Yes. The native app imports individual Linear, Jira, and Asana tickets. You can also create a local ticket, add agent tasks with dependencies, and save instructions for the ticket and each task.",
              ],
              [
                "What happens in the merge queue?",
                "The planned workers build, test, and review in separate worktrees. A confirmed change waits in the queue until its worker can merge into the ticket branch. The current app shows the queue and worker states; it does not run or merge workers yet.",
              ],
              [
                "What can I use today?",
                "Use the desktop app to organize projects and tickets, import individual issues, plan agent tasks, and save prompts and instructions locally. The agent thread, merge queue, and PR review screens show the planned workflow. Live worker execution, automatic merges, and source-ticket updates are still in development.",
              ],
            ].map(([q, a]) => (
              <Accordion.Item value={q!} key={q}>
                <Accordion.Control>{q}</Accordion.Control>
                <Accordion.Panel>{a}</Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        </section>
      </main>
      <footer className="site-footer wrap">
        <Logo />
        <span>Small tasks. A clear track.</span>
        <span>© {new Date().getFullYear()} Berdloop</span>
      </footer>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title="Berdloop desktop preview"
        centered
      >
        <p>
          The desktop app lets you organize tickets and agent tasks locally. Its
          ticket view includes requirements, agent threads, a merge queue, and a
          PR review step.
        </p>
        <p>Start the desktop app from the repository:</p>
        <code className="command">bun run dev:desktop</code>
        <p className="modal-note">
          Requires Bun 1.4 and the Tauri system dependencies. The native app
          imports individual Linear, Jira, and Asana tickets. Live workers and
          automated merges are in development.
        </p>
        <Button
          fullWidth
          onClick={() => {
            setOpened(false);
            document
              .getElementById("workflow")
              ?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          Explore the workflow
        </Button>
      </Modal>
    </div>
  );
}
