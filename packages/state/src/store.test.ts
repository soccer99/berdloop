import { expect, test } from "bun:test";
import { useBerdloop, ticketsOf, type Worker } from "./store";

const reset = () =>
  useBerdloop.setState({
    organizations: [],
    projects: [],
    tickets: [],
    agentTasks: [],
    workers: [],
    queues: { ticket: {}, agentTask: {}, merge: {}, worker: {} },
  });

test("upsert replaces a record instead of adding a second one", () => {
  reset();
  const store = useBerdloop.getState();
  store.upsertOrganization({ id: "a", name: "Berdloop" });
  store.upsertOrganization({ id: "a", name: "Renamed" });
  expect(useBerdloop.getState().organizations).toEqual([
    { id: "a", name: "Renamed" },
  ]);
});

test("a queue keeps its order and refuses a record twice", () => {
  reset();
  const store = useBerdloop.getState();
  store.enqueue("merge", "project-1", "ticket-1");
  store.enqueue("merge", "project-1", "ticket-2");
  store.enqueue("merge", "project-1", "ticket-1");
  expect(useBerdloop.getState().queues.merge["project-1"]).toEqual([
    "ticket-1",
    "ticket-2",
  ]);
  store.dequeue("merge", "project-1", "ticket-1");
  expect(useBerdloop.getState().queues.merge["project-1"]).toEqual([
    "ticket-2",
  ]);
});

test("one failed collection does not touch the others", () => {
  reset();
  const store = useBerdloop.getState();
  store.setWorkers([{ id: "w1", activity: "coding" } satisfies Worker]);
  store.failed("tickets", new Error("offline"));
  const status = useBerdloop.getState().status;
  expect(status.tickets.state).toBe("error");
  expect(status.tickets.error).toContain("offline");
  expect(status.workers.state).toBe("ready");
});

test("selectors read records by their parent", () => {
  reset();
  useBerdloop.getState().setTickets([
    { id: "t1", projectId: "p1" },
    { id: "t2", projectId: "p2" },
    // The selector only reads the project, so a partial record is enough here.
  ] as never);
  expect(ticketsOf("p1")(useBerdloop.getState()).map((t) => t.id)).toEqual([
    "t1",
  ]);
});
