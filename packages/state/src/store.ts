import { create } from "zustand";
import {
  persist,
  createJSONStorage,
  type StateStorage,
} from "zustand/middleware";
import { sampleOrganizations } from "@berdloop/core";
import type {
  AgentActivity,
  AgentTask,
  Organization,
  Project,
  Task,
} from "@berdloop/core";

/**
 * One store for everything both surfaces show.
 *
 * Desktop and web read the same records, so the records live here and not in
 * a component. Every collection carries its own status, because each one will
 * be filled by its own HTTP call and one failing request must not blank the
 * rest of the screen.
 */

/** A running agent, as any surface lists it. Its messages stay in the runtime. */
export interface Worker {
  /** Thread key: ticket-agent:<project id>, planner:<ticket id>, or task id. */
  id: string;
  activity: AgentActivity;
  projectId?: string;
  ticketId?: string;
  agentTaskId?: string;
  harness?: string;
  branch?: string;
  worktree?: string;
  streaming?: boolean;
}

/** Ordered work, keyed by what the line belongs to. Values are record IDs. */
export interface Queues {
  /** Tickets waiting on a project, in the order they are to be picked up. */
  ticket: Record<string, string[]>;
  /** Agent tasks waiting under a ticket. */
  agentTask: Record<string, string[]>;
  /** Branches waiting to land, per project. One line, first in first out. */
  merge: Record<string, string[]>;
  /** Workers waiting for a free slot, per project. */
  worker: Record<string, string[]>;
}

export type CollectionName =
  | "organizations"
  | "projects"
  | "tickets"
  | "agentTasks"
  | "workers"
  | "queues";

export type LoadState = "idle" | "loading" | "ready" | "error";

export interface Status {
  state: LoadState;
  /** Set only when `state` is `"error"`. */
  error?: string;
  /** When the records were last filled, as an ISO timestamp. */
  at?: string;
}

export interface BerdloopState {
  organizations: Organization[];
  projects: Project[];
  /** Tickets. `Task` is the ticket record the provider imports own. */
  tickets: Task[];
  agentTasks: AgentTask[];
  workers: Worker[];
  queues: Queues;
  status: Record<CollectionName, Status>;

  /** What the interface is pointed at. */
  organizationId: string;
  projectId: string;
  ticketId: string;
  /**
   * Whether the loop was handing out work when the window last drew.
   *
   * The loop lives in the window, so a reload or a rebuild stops it. Nothing
   * about the work asked it to stop, so this is what tells the next window to
   * start it again.
   */
  loopRunning: boolean;

  setOrganizations: (organizations: Organization[]) => void;
  upsertOrganization: (organization: Organization) => void;
  removeOrganization: (id: string) => void;

  setProjects: (projects: Project[]) => void;
  upsertProject: (project: Project) => void;
  removeProject: (id: string) => void;

  setTickets: (tickets: Task[]) => void;
  upsertTicket: (ticket: Task) => void;
  removeTicket: (id: string) => void;

  setAgentTasks: (agentTasks: AgentTask[]) => void;
  upsertAgentTask: (agentTask: AgentTask) => void;
  removeAgentTask: (id: string) => void;

  setWorkers: (workers: Worker[]) => void;
  upsertWorker: (worker: Worker) => void;
  removeWorker: (id: string) => void;

  setQueue: (name: keyof Queues, key: string, ids: string[]) => void;
  setQueues: (name: keyof Queues, lines: Record<string, string[]>) => void;
  /** Put an ID at the end of a line. A record already in line does not move. */
  enqueue: (name: keyof Queues, key: string, id: string) => void;
  /** Take an ID out of a line, wherever it is. */
  dequeue: (name: keyof Queues, key: string, id: string) => void;

  setStatus: (name: CollectionName, status: Status) => void;
  /** Mark a collection as loading. Use before the request, not after. */
  loading: (name: CollectionName) => void;
  /** Record a failed request against one collection. */
  failed: (name: CollectionName, error: unknown) => void;

  setOrganizationId: (id: string) => void;
  setProjectId: (id: string) => void;
  setTicketId: (id: string) => void;
  setLoopRunning: (running: boolean) => void;
}

function upsertBy<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((existing) => existing.id === item.id)
    ? list.map((existing) => (existing.id === item.id ? item : existing))
    : [...list, item];
}

function removeById<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((item) => item.id !== id);
}

const ready = (): Status => ({
  state: "ready",
  at: new Date().toISOString(),
});

const idle: Status = { state: "idle" };

const emptyQueues = (): Queues => ({
  ticket: {},
  agentTask: {},
  merge: {},
  worker: {},
});

/** Local storage where there is one, memory where there is not: tests, SSR. */
const memory = new Map<string, string>();
const webStorage: StateStorage = globalThis.localStorage ?? {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => {
    memory.set(key, value);
  },
  removeItem: (key) => {
    memory.delete(key);
  },
};

/**
 * Read what the interface stored before this store existed.
 *
 * Mantine's local storage hook wrote one JSON value per key. Those keys are
 * the only copy of a person's projects, so they are read once here and then
 * left alone.
 */
function legacy<T>(key: string, fallback: T): T {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return value === null || value === undefined
      ? fallback
      : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
}

export const useBerdloop = create<BerdloopState>()(
  persist(
    (set) => ({
      organizations: legacy<Organization[]>(
        "berdloop.preview.organizations.v1",
        sampleOrganizations,
      ),
      projects: legacy<Project[]>("berdloop.preview.projects.v1", []),
      tickets: [],
      agentTasks: [],
      workers: [],
      queues: emptyQueues(),
      status: {
        organizations: idle,
        projects: idle,
        tickets: idle,
        agentTasks: idle,
        workers: idle,
        queues: idle,
      },

      organizationId: legacy(
        "berdloop.preview.organization-selection.v1",
        sampleOrganizations[0].id,
      ),
      projectId: legacy("berdloop.preview.project-selection.v1", ""),
      ticketId: legacy("berdloop.loop.ticket.v1", ""),
      loopRunning: false,

      setOrganizations: (organizations) =>
        set((state) => ({
          organizations,
          status: { ...state.status, organizations: ready() },
        })),
      upsertOrganization: (organization) =>
        set((state) => ({
          organizations: upsertBy(state.organizations, organization),
        })),
      removeOrganization: (id) =>
        set((state) => ({
          organizations: removeById(state.organizations, id),
        })),

      setProjects: (projects) =>
        set((state) => ({
          projects,
          status: { ...state.status, projects: ready() },
        })),
      upsertProject: (project) =>
        set((state) => ({ projects: upsertBy(state.projects, project) })),
      removeProject: (id) =>
        set((state) => ({ projects: removeById(state.projects, id) })),

      setTickets: (tickets) =>
        set((state) => ({
          tickets,
          status: { ...state.status, tickets: ready() },
        })),
      upsertTicket: (ticket) =>
        set((state) => ({ tickets: upsertBy(state.tickets, ticket) })),
      removeTicket: (id) =>
        set((state) => ({ tickets: removeById(state.tickets, id) })),

      setAgentTasks: (agentTasks) =>
        set((state) => ({
          agentTasks,
          status: { ...state.status, agentTasks: ready() },
        })),
      upsertAgentTask: (agentTask) =>
        set((state) => ({
          agentTasks: upsertBy(state.agentTasks, agentTask),
        })),
      removeAgentTask: (id) =>
        set((state) => ({ agentTasks: removeById(state.agentTasks, id) })),

      setWorkers: (workers) =>
        set((state) => ({
          workers,
          status: { ...state.status, workers: ready() },
        })),
      upsertWorker: (worker) =>
        set((state) => ({ workers: upsertBy(state.workers, worker) })),
      removeWorker: (id) =>
        set((state) => ({ workers: removeById(state.workers, id) })),

      setQueue: (name, key, ids) =>
        set((state) => ({
          queues: {
            ...state.queues,
            [name]: { ...state.queues[name], [key]: ids },
          },
          status: { ...state.status, queues: ready() },
        })),
      setQueues: (name, lines) =>
        set((state) => ({
          queues: { ...state.queues, [name]: lines },
          status: { ...state.status, queues: ready() },
        })),
      enqueue: (name, key, id) =>
        set((state) => {
          const line = state.queues[name][key] ?? [];
          if (line.includes(id)) return state;
          return {
            queues: {
              ...state.queues,
              [name]: { ...state.queues[name], [key]: [...line, id] },
            },
          };
        }),
      dequeue: (name, key, id) =>
        set((state) => ({
          queues: {
            ...state.queues,
            [name]: {
              ...state.queues[name],
              [key]: (state.queues[name][key] ?? []).filter(
                (waiting) => waiting !== id,
              ),
            },
          },
        })),

      setStatus: (name, status) =>
        set((state) => ({ status: { ...state.status, [name]: status } })),
      loading: (name) =>
        set((state) => ({
          status: { ...state.status, [name]: { state: "loading" } },
        })),
      failed: (name, error) =>
        set((state) => ({
          status: {
            ...state.status,
            [name]: { state: "error", error: String(error) },
          },
        })),

      setOrganizationId: (organizationId) => set({ organizationId }),
      setProjectId: (projectId) => set({ projectId }),
      setTicketId: (ticketId) => set({ ticketId }),
      setLoopRunning: (loopRunning) => set({ loopRunning }),
    }),
    {
      name: "berdloop.state.v1",
      storage: createJSONStorage(() => webStorage),
      // Records that a server will send stay out of storage. Only what the
      // person chose, and the local-only lists, are kept between sessions.
      partialize: (state) => ({
        organizations: state.organizations,
        projects: state.projects,
        organizationId: state.organizationId,
        projectId: state.projectId,
        ticketId: state.ticketId,
        loopRunning: state.loopRunning,
      }),
    },
  ),
);

/** The project the interface is pointed at, or nothing. */
export const currentProject = (state: BerdloopState) =>
  state.projects.find((project) => project.id === state.projectId);

/** The organization the interface is pointed at, or nothing. */
export const currentOrganization = (state: BerdloopState) =>
  state.organizations.find(
    (organization) => organization.id === state.organizationId,
  );

/** Projects of one organization. */
export const projectsOf = (organizationId: string) => (state: BerdloopState) =>
  state.projects.filter((project) => project.organizationId === organizationId);

/** Tickets of one project. */
export const ticketsOf = (projectId: string) => (state: BerdloopState) =>
  state.tickets.filter((ticket) => ticket.projectId === projectId);

/** Agent tasks under one ticket. */
export const agentTasksOf = (ticketId: string) => (state: BerdloopState) =>
  state.agentTasks.filter((task) => task.parentTaskId === ticketId);
