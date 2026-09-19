import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Badge,
  Button,
  Loader,
  Modal,
  MultiSelect,
  PasswordInput,
  Select,
  Switch,
  Tabs,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { IconFolder, IconPlus, IconUsers } from "@tabler/icons-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  migrateTasks,
  starterProjectId,
  topTicket,
  type AccountSession,
  type ExternalIssue,
  type ExternalProvider,
  type Organization,
  type Project,
  type Task,
  type TicketProvider,
} from "@berdloop/core";
import { useBerdloop } from "@berdloop/state";
import {
  betaEnabled,
  defaultHarnessSettings,
  type HarnessSettings,
} from "@berdloop/agent";
import { useTaskWorkspace } from "./task-storage";
import {
  AccessScreen,
  WorkOSRequiredModal,
  canCollaborate,
  type CollaborationTarget,
} from "./access";
import { QueueView } from "./queue";
import { plannerKey, useWorkflowRuntime } from "./workflow-runtime";
import { defaultWorkers, useRalphLoop } from "./ralph-loop";
import { AppShell } from "./layout/AppShell";
import { WorkspaceHeader } from "./layout/WorkspaceHeader";
import { WorkspaceNavigation } from "./layout/WorkspaceNavigation";
import { AccountMenu, SystemStatus } from "./layout/WorkspaceFooters";
import type { WorkspaceView } from "./layout/types";
import {
  agentRoles,
  emptyAgentPreferences,
  patchIntegration,
  resolveRolePreference,
  patchRolePreference,
  type AgentPreferences,
  type AgentRoleSetting,
  type IntegrationScope,
  type IntegrationSettings,
  type RolePreference,
} from "./agent-preferences";
import {
  settingsFix,
  recentFirst,
  searchDebounceMs,
  searchSequence,
  ticketAgentPrompt,
  updatedLabel,
} from "./ticket-picker";

import { HarnessModelSelects } from "./harness-model-selects";
import { useHarnessCatalog } from "./harness-catalog";
import { pruneDraftsForOwners, useDraft } from "./drafts";
import { moveNewTicketDrafts, newTicketDraftKey } from "./new-ticket-draft";

// The WorkOS adapter will provide this after account auth is connected.
const workosSession: AccountSession | null = null;

/**
 * The two pickers in the new-ticket form. What a person types there is unsent
 * work and lives in `useDraft`; these are re-aimed every time the form opens,
 * so there is nothing to keep. `projectId` is the project the ticket will be
 * created in, which is also what names those drafts: see `new-ticket-draft`.
 */
interface DraftTarget {
  projectId: string;
  source: TicketProvider;
}
interface ProjectInfo {
  path: string;
  name: string;
  isGit: boolean;
  branch: string | null;
  remoteUrl: string | null;
  provider: string | null;
}
const emptyDraftTarget: DraftTarget = { projectId: "", source: "Local" };

/**
 * One role's extra instructions. Typing commits straight into preferences,
 * but a draft is kept alongside so a prompt written before a scope exists —
 * when `setRolePreference` has nowhere to put it — is not typed into thin
 * air. Its own component so `useDraft` is not called inside the roles loop.
 */
function RoleSystemPrompt({
  role,
  label,
  scope,
  committed,
  onChange,
}: {
  role: AgentRoleSetting;
  label: string;
  scope: string;
  committed: string;
  onChange: (systemPrompt: string) => void;
}) {
  const [text, setText] = useDraft(`role-prompt:${scope}:${role}`, {
    seed: committed,
  });
  return (
    <Textarea
      size="xs"
      autosize
      minRows={1}
      maxRows={6}
      aria-label={`${label} system prompt`}
      placeholder="Additional system prompt"
      value={text}
      onChange={(event) => {
        setText(event.currentTarget.value);
        onChange(event.currentTarget.value);
      }}
    />
  );
}

const ticketProviders: ExternalProvider[] = ["Linear", "Jira", "Asana"];

interface ConnectionField {
  name: string;
  label: string;
  placeholder: string;
  read: (settings: IntegrationSettings | undefined) => string;
  write: (value: string) => Partial<IntegrationSettings>;
}

// What a provider needs besides its token. The token is deliberately missing:
// it never travels through the preferences, and it is never read back.
const connectionFields: Record<ExternalProvider, ConnectionField[]> = {
  Linear: [],
  Jira: [
    {
      name: "site",
      label: "Jira Cloud site",
      placeholder: "https://your-team.atlassian.net",
      read: (settings) => settings?.jiraSite ?? "",
      write: (value) => ({ jiraSite: value }),
    },
    {
      name: "email",
      label: "Atlassian account email",
      placeholder: "you@your-team.com",
      read: (settings) => settings?.jiraEmail ?? "",
      write: (value) => ({ jiraEmail: value }),
    },
  ],
  Asana: [
    {
      name: "workspace",
      label: "Asana workspace GID",
      placeholder: "1200123456789",
      read: (settings) => settings?.asanaWorkspace ?? "",
      write: (value) => ({ asanaWorkspace: value }),
    },
  ],
};

const tokenLabels: Record<ExternalProvider, string> = {
  Linear: "Linear API token",
  Jira: "Atlassian API token",
  Asana: "Asana API token",
};

// One provider's connection at one scope. Everything except the token is a
// preference; the token goes straight to the host, which only ever tells us
// whether one is there.
function ProviderConnection({
  provider,
  scope,
  scopeId,
  settings,
  inherited,
  inheritedFrom,
  onPatch,
  onConnected,
  onUseOrganization,
}: {
  provider: ExternalProvider;
  scope: IntegrationScope;
  scopeId: string;
  settings: IntegrationSettings | undefined;
  inherited: IntegrationSettings | undefined;
  inheritedFrom: string;
  onPatch: (patch: Partial<IntegrationSettings>) => void;
  onConnected: (connected: boolean) => void;
  onUseOrganization: (() => Promise<void>) | null;
}) {
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connected = settings?.connected ?? false;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      setError("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  function saveToken() {
    return run(async () => {
      if (!isTauri())
        throw new Error("Saving a token needs the Berdloop desktop app.");
      await invoke("save_integration_secret", {
        scope,
        scopeId,
        provider,
        token,
      });
      onConnected(true);
      setToken("");
      setEditing(false);
    });
  }

  function disconnect() {
    return run(async () => {
      if (!isTauri())
        throw new Error("Clearing a token needs the Berdloop desktop app.");
      await invoke("clear_integration_secret", { scope, scopeId, provider });
      onConnected(false);
      setToken("");
      setEditing(false);
    });
  }

  return (
    <div className="provider-connection">
      <div className="provider-connection-heading">
        <h3>{provider}</h3>
        <Badge variant="light" color={connected ? "lime" : "gray"}>
          {connected ? "Connected" : "Not connected"}
        </Badge>
      </div>
      {!connected && inherited?.connected && (
        <p className="provider-connection-note">
          Using the token from {inheritedFrom}.
        </p>
      )}
      {connectionFields[provider].map((field) => {
        const value = field.read(settings);
        const inheritedValue = field.read(inherited);
        return (
          <TextInput
            key={field.name}
            mt="sm"
            label={field.label}
            placeholder={inheritedValue || field.placeholder}
            description={
              !value && inheritedValue
                ? `Inherited from ${inheritedFrom}`
                : undefined
            }
            value={value}
            onChange={(event) =>
              onPatch(field.write(event.currentTarget.value))
            }
          />
        );
      })}
      {editing ? (
        <>
          <TextInput
            mt="sm"
            type="password"
            autoComplete="off"
            label={tokenLabels[provider]}
            description="Kept in a file only your account can read, and never shown again."
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
          />
          <div className="provider-connection-actions">
            <Button
              size="xs"
              loading={busy}
              disabled={!token.trim()}
              onClick={() => void saveToken()}
            >
              Save token
            </Button>
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                setEditing(false);
                setToken("");
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div className="provider-connection-actions">
          <Button size="xs" variant="subtle" onClick={() => setEditing(true)}>
            {connected ? "Replace token" : "Add token"}
          </Button>
          {connected && (
            <Button
              size="xs"
              variant="subtle"
              color="red"
              loading={busy}
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          )}
          {onUseOrganization && (
            <Button
              size="xs"
              variant="subtle"
              loading={busy}
              onClick={() => void run(onUseOrganization)}
            >
              Use organization connection
            </Button>
          )}
        </div>
      )}
      {error && (
        <p className="task-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// Choosing a ticket to import. The host holds the connection, so the picker
// only ever names a provider and a scope: it asks for the provider's own
// recent list the moment it opens, so there is something to choose from
// before anybody types, and a search replaces that list only while it is
// still the newest one asked for.
function TicketPicker({
  provider,
  organizationId,
  projectId,
  busy,
  onPickIssue,
  onOpenSettings,
}: {
  provider: ExternalProvider;
  organizationId: string;
  projectId: string;
  busy: boolean;
  onPickIssue: (issue: ExternalIssue) => void;
  onOpenSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<ExternalIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const sequence = useRef(searchSequence());
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const term = query.trim();
    const ticket = sequence.current.start();
    setLoading(true);
    // Opening the picker asks at once; waiting would only show an empty
    // panel. Typing rests first, so a typed word is one search and not one
    // per letter. Either way the answer is shown only if its ticket is still
    // the newest, so a slow earlier search cannot overwrite a newer one.
    const timer = setTimeout(
      () => {
        void invoke<ExternalIssue[]>("search_external_issues", {
          provider,
          organizationId,
          projectId,
          query: term,
        })
          .then((found) => {
            if (!sequence.current.accept(ticket)) return;
            setIssues(recentFirst(found));
            setError("");
            setActive(0);
            setLoading(false);
          })
          .catch((cause) => {
            if (!sequence.current.accept(ticket)) return;
            setIssues([]);
            setError(String(cause));
            setLoading(false);
          });
      },
      term ? searchDebounceMs : 0,
    );
    return () => clearTimeout(timer);
  }, [provider, organizationId, projectId, query]);

  function move(step: number) {
    if (issues.length === 0) return;
    const next = Math.min(Math.max(active + step, 0), issues.length - 1);
    setActive(next);
    rows.current[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    // A row is a real button and answers Enter by itself; this is Enter from
    // the search field, which takes whichever row the arrows landed on.
    if (event.key === "Enter" && event.target === search.current) {
      event.preventDefault();
      const picked = issues[active];
      if (picked) onPickIssue(picked);
    }
  }

  const fixInSettings = settingsFix(error);
  return (
    <div className="ticket-picker" onKeyDown={onKeyDown}>
      <TextInput
        ref={search}
        data-autofocus
        mt="md"
        label={`Search ${provider}`}
        placeholder="A key, a title, or a word from the ticket"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {loading ? (
        <p className="ticket-picker-note">
          <Loader size="xs" /> Asking {provider}…
        </p>
      ) : fixInSettings ? (
        <div className="ticket-picker-note">
          <p>{fixInSettings}</p>
          <Button size="xs" variant="subtle" onClick={onOpenSettings}>
            Open settings
          </Button>
        </div>
      ) : error ? (
        <p role="alert" className="task-error">
          {error}
        </p>
      ) : issues.length === 0 ? (
        <p className="ticket-picker-note">No tickets matched</p>
      ) : (
        <div
          className="ticket-picker-list"
          role="group"
          aria-label={`${provider} tickets`}
        >
          {issues.map((issue, index) => {
            const updated = updatedLabel(issue);
            return (
              <button
                key={issue.id}
                type="button"
                ref={(element) => {
                  rows.current[index] = element;
                }}
                className={`ticket-pick${index === active ? " active" : ""}`}
                aria-label={`${issue.key}, ${issue.title}`}
                aria-current={index === active}
                disabled={busy}
                onFocus={() => setActive(index)}
                onClick={() => onPickIssue(issue)}
              >
                <code>{issue.key}</code>
                <strong>{issue.title}</strong>
                {issue.status && (
                  <Badge variant="light" color="gray" size="sm">
                    {issue.status}
                  </Badge>
                )}
                <small>
                  {updated ? `Updated ${updated}` : "Never updated"}
                </small>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [accessMode, setAccessMode] = useLocalStorage<"local" | null>({
    key: "berdloop.preview.access-mode.v1",
    defaultValue: null,
  });
  const [collaborationTarget, setCollaborationTarget] = useState<
    CollaborationTarget | "welcome" | null
  >(null);
  const [view, setView] = useState<WorkspaceView>("queue");
  const harnessOptions = useHarnessCatalog(view === "tools");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const organizations = useBerdloop((state) => state.organizations);
  const addOrganizationRecord = useBerdloop(
    (state) => state.upsertOrganization,
  );
  const projects = useBerdloop((state) => state.projects);
  const saveProjectRecord = useBerdloop((state) => state.upsertProject);
  const removeProjectRecord = useBerdloop((state) => state.removeProject);
  const {
    workspace,
    update: updateWorkspace,
    ready: tasksReady,
    error: taskStoreError,
  } = useTaskWorkspace(workosSession);
  const tasks = workspace.tasks;

  // The agent system, and the loop that keeps handing it work.
  const loopTicketId = useBerdloop((state) => state.ticketId);
  const setLoopTicketId = useBerdloop((state) => state.setTicketId);
  // Read once, at mount: whether the previous window was handing out work.
  const [loopWasRunning] = useState(() => useBerdloop.getState().loopRunning);
  const [sourceSettingsProjectId, setSourceSettingsProjectId] = useState("");
  const [agentPreferences, setAgentPreferences] =
    useLocalStorage<AgentPreferences>({
      key: "berdloop.agent-preferences.v1",
      defaultValue: emptyAgentPreferences,
    });
  const [preferencesLoaded, setPreferencesLoaded] = useState(!isTauri());
  const [preferencesError, setPreferencesError] = useState("");

  // Harness settings live beside the app, not in this workspace, because they
  // are about trusting the machine. The native side is the only copy; this is
  // a draft of it that saves as it is edited.
  const [harnessSettings, setHarnessSettingsState] = useState<HarnessSettings>(
    defaultHarnessSettings,
  );
  const [harnessSettingsError, setHarnessSettingsError] = useState("");
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void invoke<HarnessSettings>("load_harness_settings")
      .then((saved) => active && setHarnessSettingsState(saved))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  function setHarnessSettings(change: Partial<HarnessSettings>) {
    const next = { ...harnessSettings, ...change };
    // A key that is taken away takes the beta with it, so the switch can never
    // be left on with nothing behind it.
    if (!next.openrouterKey?.trim() && !next.vercelKey?.trim() && next.beta)
      next.beta = false;
    setHarnessSettingsState(next);
    setHarnessSettingsError("");
    if (!isTauri()) return;
    void invoke("save_harness_settings", { settings: next }).catch((cause) =>
      setHarnessSettingsError(String(cause)),
    );
  }
  const organizationId = useBerdloop((state) => state.organizationId);
  const setOrganizationId = useBerdloop((state) => state.setOrganizationId);
  const projectId = useBerdloop((state) => state.projectId);
  const setProjectId = useBerdloop((state) => state.setProjectId);
  const agents = useWorkflowRuntime();
  // The agents write the queue files; this keeps the store true to them.
  const loopProject = projects.find((item) => item.id === projectId);
  // The loop follows the top of the queue unless a ticket was picked, and it
  // moves on by itself once that ticket is complete.
  const projectTickets = workspace.tasks.filter(
    (item) => !projectId || item.projectId === projectId,
  );
  const loopTicket =
    projectTickets.find(
      (item) => item.id === loopTicketId && item.status !== "complete",
    ) ?? topTicket(projectTickets);
  // Harness and model are one choice, so they are resolved together and the
  // model travels with the harness that names it.
  const workerPreference = resolveRolePreference(
    agentPreferences,
    organizationId,
    projectId,
    "worker",
  );
  const reviewPreference = resolveRolePreference(
    agentPreferences,
    organizationId,
    projectId,
    "pr-code-review",
  );
  const loop = useRalphLoop({
    workspace,
    update: updateWorkspace,
    projects,
    projectId,
    preferredTicketId: loopTicketId,
    slots: loopProject?.workers ?? defaultWorkers,
    harness: workerPreference.harness ?? "claude-code",
    model: workerPreference.model,
    reviewHarness: reviewPreference.harness,
    reviewModel: reviewPreference.model,
    startAgent: async ({ key, plan, role, ticket }) => {
      if (isTauri())
        await invoke("save_agent_preferences", {
          preferences: agentPreferences,
        });
      const owner = projects.find((item) => item.id === ticket.projectId);
      if (!owner) throw new Error("The agent's project no longer exists.");
      return agents.launch(key, plan, {
        organizationId: owner.organizationId,
        projectId: owner.id,
        ticketId: ticket.id,
        taskId: role === "worker" ? key : undefined,
        role,
      });
    },
    startPlanner: async (ticket, owner, prompt) => {
      if (!owner.path) throw new Error("The project has no folder.");
      if (isTauri())
        await invoke("save_agent_preferences", {
          preferences: agentPreferences,
        });
      await agents.start(plannerKey(ticket.id), owner.path, prompt, {
        organizationId: owner.organizationId,
        projectId: owner.id,
        ticketId: ticket.id,
        role: "task-agent",
      });
    },
  });
  // The loop lives in this window, so a hot reload, a rebuild or a crash stops
  // it handing out work. None of that was a decision to stop, so it is started
  // again once the records and the project folder are back. Its own recovery
  // pass then reconciles whatever finished while the window was gone.
  const loopRestarted = useRef(false);
  useEffect(() => {
    if (loopRestarted.current || !tasksReady || !loopWasRunning) return;
    if (!projects.find((item) => item.id === projectId)?.path) return;
    loopRestarted.current = true;
    loop.start();
  }, [tasksReady, loopWasRunning, projects, projectId, loop]);

  // Projects live in this window, so the backend cannot watch a pull request
  // until it has been told where the project is.
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("watch_projects", {
      projects: projects
        .filter((item) => item.path)
        .map((item) => ({ id: item.id, path: item.path })),
    }).catch(() => undefined);
  }, [projects]);

  // Workers alive right now. The processes are the truth, so this counts the
  // live conversations rather than the loop's own bookkeeping, which frees a
  // slot as soon as a worker reports and so reads low while it exits.
  const busyWorkers = Object.values(agents.threads).filter(
    (thread) =>
      thread.streaming &&
      thread.scope.role === "worker" &&
      (!projectId || thread.scope.projectId === projectId),
  ).length;
  const [selectedId, setSelectedId] = useState("");
  const [taskOpened, setTaskOpened] = useState(false);
  const [importOpened, setImportOpened] = useState(false);
  const [importProvider, setImportProvider] =
    useState<ExternalProvider>("Linear");
  // What a picked ticket left in the ticket agent's chat box. The id rises
  // with every pick, so picking the same ticket twice writes it again.
  const [ticketAgentPrefill, setTicketAgentPrefill] = useState<{
    id: number;
    text: string;
  }>();
  const [organizationOpened, setOrganizationOpened] = useState(false);
  const [projectOpened, setProjectOpened] = useState(false);
  const [linkProjectId, setLinkProjectId] = useState<string | null>(null);
  const [organizationName, setOrganizationName, clearOrganizationName] =
    useDraft("new-organization:name");
  const [projectSource, setProjectSource] = useState<"local" | "clone">(
    "local",
  );
  const [projectPath, setProjectPath] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneDestination, setCloneDestination] = useState("");
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  /** What `.berd/` setup found when a project was added. Cleared once read. */
  const [projectSetup, setProjectSetup] = useState<{
    created: boolean;
    notes: string[];
  } | null>(null);
  const [draft, setDraft] = useState<DraftTarget>(emptyDraftTarget);
  // Everything typed into the new-ticket form, kept against the project the
  // ticket will be created in, so closing the modal or leaving the view never
  // throws it away. That is `draft.projectId`, not the project in view: the
  // organization view has none, and two organizations must not share a draft.
  const [ticketCriteriaSeed, setTicketCriteriaSeed] = useState("");
  const [ticketTitle, setTicketTitle, clearTicketTitle] = useDraft(
    newTicketDraftKey(draft.projectId, "title"),
  );
  const [ticketReference, setTicketReference, clearTicketReference] = useDraft(
    newTicketDraftKey(draft.projectId, "reference"),
  );
  const [ticketCriteria, setTicketCriteria, clearTicketCriteria] = useDraft(
    newTicketDraftKey(draft.projectId, "criteria"),
    { seed: ticketCriteriaSeed },
  );
  const [runtime, setRuntime] = useState("Browser preview");

  useEffect(() => {
    if (!isTauri()) return;
    invoke<AgentPreferences>("load_agent_preferences")
      .then((settings) => setAgentPreferences(settings))
      .catch((cause) => setPreferencesError(String(cause)))
      .finally(() => setPreferencesLoaded(true));
  }, [setAgentPreferences]);
  useEffect(() => {
    if (!isTauri() || !preferencesLoaded) return;
    const timer = window.setTimeout(() => {
      void invoke("save_agent_preferences", { preferences: agentPreferences })
        .then(() => setPreferencesError(""))
        .catch((cause) => setPreferencesError(String(cause)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [agentPreferences, preferencesLoaded]);

  useEffect(() => {
    if (isTauri()) {
      invoke<{ platform: string; execution: string }>("runtime_info")
        .then((info) => setRuntime(`${info.platform} · ${info.execution}`))
        .catch(() => setRuntime("Native connection unavailable"));
    }
  }, []);
  useEffect(() => {
    if (
      tasksReady &&
      projects.length &&
      tasks.some(
        (item) =>
          !item.projectId ||
          !projects.some((project) => project.id === item.projectId),
      )
    ) {
      updateWorkspace((current) => ({
        ...current,
        tasks: migrateTasks(current.tasks, projects),
      }));
    }
  }, [projects, tasks, tasksReady, updateWorkspace]);

  // Drafts outlive the editor they were typed in, so a deleted ticket or task
  // would otherwise leave its unsent text behind for good. This is the one
  // place that knows every ticket and task across every project: the queue
  // view only ever sees one project's worth, and pruning from there would read
  // the other projects' work as deleted. Gated on `tasksReady`, because an
  // empty workspace before the store answers is not an empty workspace.
  // Joined so the effect depends on the ids themselves, not on an array that
  // is rebuilt every render: pruning runs when something is deleted, not always.
  const liveSubjectKey = [
    ...workspace.tasks.map((item) => item.id),
    ...workspace.agentTasks.map((item) => item.id),
  ].join("\n");
  useEffect(() => {
    if (!tasksReady) return;
    pruneDraftsForOwners(liveSubjectKey ? liveSubjectKey.split("\n") : []);
  }, [tasksReady, liveSubjectKey]);

  const organization =
    organizations.find((item) => item.id === organizationId) ??
    organizations[0];
  const organizationProjects = projects.filter(
    (item) => item.organizationId === organization?.id && !item.archived,
  );
  const archivedProjects = projects.filter(
    (item) => item.organizationId === organization?.id && item.archived,
  );
  const projectOptions = organizationProjects.map((item) => ({
    value: item.id,
    label: item.name,
  }));
  const project = organizationProjects.find((item) => item.id === projectId);
  // Archived projects are off the lists but keep a reachable settings page.
  const settingsProject = projects.find(
    (item) => item.id === sourceSettingsProjectId,
  );
  // The name is edited as a draft, because an empty box must not blank the
  // name every list shows. It is written back when the box loses focus.
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [confirmDeleteProject, setConfirmDeleteProject] = useState("");
  useEffect(() => {
    setProjectNameDraft(settingsProject?.name ?? "");
    setConfirmDeleteProject("");
  }, [settingsProject?.id, settingsProject?.name]);
  const sourceSettings =
    agentPreferences.ticketSources ?? emptyAgentPreferences.ticketSources;
  const organizationSources = sourceSettings.organizations;
  const projectSources = sourceSettings.projects;
  const enabledTicketSources =
    projectId && projectSources[projectId] !== undefined
      ? projectSources[projectId]
      : (organizationSources[organization?.id ?? ""] ?? []);
  // What the picker may switch between: whatever this project turned on,
  // and every provider when nobody has chosen yet.
  const pickerProviders = enabledTicketSources.length
    ? enabledTicketSources
    : ticketProviders;
  const visibleSettingsSources = sourceSettingsProjectId
    ? (projectSources[sourceSettingsProjectId] ??
      organizationSources[organization?.id ?? ""] ??
      [])
    : (organizationSources[organization?.id ?? ""] ?? []);
  // The scope a role's extra instructions belong to, so a prompt typed for
  // one project is never shown under another.
  const rolePromptScope =
    sourceSettingsProjectId ||
    settingsProject?.organizationId ||
    organization?.id ||
    "none";
  function rolePreference(role: AgentRoleSetting): Required<RolePreference> {
    return resolveRolePreference(
      agentPreferences,
      settingsProject?.organizationId ?? organization?.id ?? "",
      sourceSettingsProjectId,
      role,
    );
  }

  function setRolePreference(
    role: AgentRoleSetting,
    patch: Partial<RolePreference>,
  ) {
    const settingsOrganizationId =
      settingsProject?.organizationId ?? organization?.id;
    const scopeId = sourceSettingsProjectId || settingsOrganizationId;
    if (!scopeId) return;
    setAgentPreferences((current) =>
      patchRolePreference(
        current,
        sourceSettingsProjectId ? "projects" : "organizations",
        scopeId,
        role,
        patch,
      ),
    );
  }

  function setTicketSources(
    scope: "organizations" | "projects",
    id: string,
    sources: ExternalProvider[] | null,
  ) {
    setAgentPreferences((current) => {
      const settings =
        current.ticketSources ?? emptyAgentPreferences.ticketSources;
      const next = { ...settings[scope] };
      if (sources === null) delete next[id];
      else next[id] = sources;
      return { ...current, ticketSources: { ...settings, [scope]: next } };
    });
  }
  const integrationSettings =
    agentPreferences.integrations ?? emptyAgentPreferences.integrations;
  // Connections are edited at whichever scope the settings screen is showing.
  const connectionScope: IntegrationScope = sourceSettingsProjectId
    ? "projects"
    : "organizations";
  const connectionScopeId = sourceSettingsProjectId || (organization?.id ?? "");
  function connectionAt(
    scope: IntegrationScope,
    scopeId: string,
    provider: ExternalProvider,
  ): IntegrationSettings | undefined {
    return integrationSettings[scope][scopeId]?.[provider];
  }
  function setConnection(
    provider: ExternalProvider,
    patch: Partial<IntegrationSettings>,
  ) {
    if (!connectionScopeId) return;
    setAgentPreferences((current) =>
      patchIntegration(
        current,
        connectionScope,
        connectionScopeId,
        provider,
        patch,
      ),
    );
  }
  // Drop a project's own connection so the organization's applies again. Its
  // token goes with it, or the host would keep a secret nothing points at.
  async function useOrganizationConnection(provider: ExternalProvider) {
    const scopeId = sourceSettingsProjectId;
    if (!scopeId) return;
    if (connectionAt("projects", scopeId, provider)?.connected && isTauri())
      await invoke("clear_integration_secret", {
        scope: "projects",
        scopeId,
        provider,
      });
    setAgentPreferences((current) => {
      const integrations =
        current.integrations ?? emptyAgentPreferences.integrations;
      const providers = { ...integrations.projects[scopeId] };
      delete providers[provider];
      return {
        ...current,
        integrations: {
          ...integrations,
          projects: { ...integrations.projects, [scopeId]: providers },
        },
      };
    });
  }
  const organizationProjectIds = new Set(
    organizationProjects.map((item) => item.id),
  );
  const organizationTasks = tasks.filter((item) =>
    organizationProjectIds.has(item.projectId || starterProjectId),
  );
  const duplicateOrganization = organizations.some(
    (item) =>
      item.name.toLocaleLowerCase() ===
      organizationName.trim().toLocaleLowerCase(),
  );
  const duplicateProject = Boolean(
    projectInfo &&
    projects.some(
      (item) => item.path === projectInfo.path && item.id !== linkProjectId,
    ),
  );

  function selectOrganization(id: string) {
    setOrganizationId(id);
    setProjectId("");
    setSourceSettingsProjectId("");
    setSelectedId("");
    setNavigationOpen(false);
    setView("organization");
  }
  function saveProjectName() {
    const name = projectNameDraft.trim();
    if (!settingsProject) return;
    if (!name) {
      setProjectNameDraft(settingsProject.name);
      return;
    }
    if (name !== settingsProject.name)
      saveProjectRecord({ ...settingsProject, name });
  }
  function deleteProject(id: string) {
    removeProjectRecord(id);
    // Tickets go with the project. Left behind, migrateTasks would hand them
    // to whichever project is left, which is worse than losing them.
    updateWorkspace((current) => ({
      ...current,
      tasks: current.tasks.filter((task) => task.projectId !== id),
    }));
    if (projectId === id) setProjectId("");
    setSourceSettingsProjectId("");
    setSelectedId("");
    setView("organization");
  }
  function showProjectSettings(id: string) {
    setProjectId(id);
    setSourceSettingsProjectId(id);
    setSelectedId("");
    setNavigationOpen(false);
    setView("tools");
  }
  function selectProject(id: string) {
    setNavigationOpen(false);
    setProjectId(id);
    setSelectedId("");
    setView("loops");
  }
  function addOrganization() {
    const name = organizationName.trim();
    if (!name || duplicateOrganization) return;
    const next: Organization = { id: crypto.randomUUID(), name };
    addOrganizationRecord(next);
    setOrganizationId(next.id);
    setProjectId("");
    setSelectedId("");
    clearOrganizationName();
    setOrganizationOpened(false);
    setProjectOpened(false);
    setView("organization");
  }
  function resetProjectForm() {
    setProjectSource("local");
    setProjectPath("");
    setCloneUrl("");
    setCloneDestination("");
    setProjectInfo(null);
    setProjectError(null);
    setLinkProjectId(null);
  }
  function saveProject(info: ProjectInfo) {
    if (!organization) return;
    const linked = linkProjectId
      ? projects.find((item) => item.id === linkProjectId)
      : null;
    if (
      projects.some((item) => item.path === info.path && item.id !== linked?.id)
    ) {
      setProjectError("This folder is already a project.");
      return;
    }
    const next: Project = {
      ...linked,
      id: linked?.id ?? crypto.randomUUID(),
      organizationId: linked?.organizationId ?? organization.id,
      name: linked?.name ?? info.name,
      description: linked?.description || info.remoteUrl || "",
      path: info.path,
      isGit: info.isGit,
      branch: info.branch,
      remoteUrl: info.remoteUrl,
      provider: info.provider,
    };
    const relinked = Boolean(linked);
    saveProjectRecord(next);
    // Set the project up for parallel workers: a `.berd/` directory holding its
    // ports, engines and env. It only ever creates that one directory, and it
    // leaves an existing one exactly as it is, so adding a project can never
    // change how the project already runs for the person who owns it.
    if (info.isGit && isTauri())
      void invoke<{ created: boolean; notes: string[] }>("devenv_setup", {
        projectId: next.id,
        path: info.path,
      })
        .then((setup) => setProjectSetup(setup.created ? setup : null))
        .catch((error) => setProjectError(String(error)));
    setProjectId(next.id);
    setSelectedId("");
    setProjectOpened(false);
    resetProjectForm();
    // Relinking is a settings edit, so it leaves you where you were.
    if (!relinked) setView("loops");
  }
  async function pickFolder(setter: (path: string) => void) {
    if (!isTauri()) {
      setProjectError("Choosing a folder requires the desktop app.");
      return;
    }
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setProjectError(null);
      setter(picked);
    }
  }
  async function inspectProject() {
    if (!isTauri()) {
      setProjectError("Opening local folders requires the desktop app.");
      return;
    }
    setProjectBusy(true);
    setProjectError(null);
    try {
      const info = await invoke<ProjectInfo>("project_inspect", {
        path: projectPath,
      });
      setProjectInfo(info);
    } catch (error) {
      setProjectInfo(null);
      setProjectError(String(error));
    } finally {
      setProjectBusy(false);
    }
  }
  async function initProject() {
    setProjectBusy(true);
    setProjectError(null);
    try {
      const info = await invoke<ProjectInfo>("project_init", {
        path: projectInfo?.path,
      });
      setProjectInfo(info);
    } catch (error) {
      setProjectError(String(error));
    } finally {
      setProjectBusy(false);
    }
  }
  async function cloneProject() {
    if (!isTauri()) {
      setProjectError("Cloning requires the desktop app.");
      return;
    }
    setProjectBusy(true);
    setProjectError(null);
    try {
      const info = await invoke<ProjectInfo>("project_clone", {
        url: cloneUrl,
        destination: cloneDestination,
      });
      saveProject(info);
    } catch (error) {
      setProjectError(String(error));
    } finally {
      setProjectBusy(false);
    }
  }
  /**
   * Aims the form at another project. The drafts are keyed on the target, so
   * what has been typed is carried over: re-aiming must not empty the form.
   */
  function retargetDraft(projectId: string) {
    moveNewTicketDrafts(draft.projectId, projectId, [
      { field: "title", text: ticketTitle },
      { field: "reference", text: ticketReference },
      { field: "criteria", text: ticketCriteria, seed: ticketCriteriaSeed },
    ]);
    setDraft({ ...draft, projectId });
  }
  function openTaskDraft(criteria = "") {
    const target = project ?? organizationProjects[0];
    if (!target) return;
    setDraft({ ...emptyDraftTarget, projectId: target.id });
    setTicketCriteriaSeed(criteria);
    setTaskOpened(true);
  }
  function addTask() {
    const targetProject = projects.find((item) => item.id === draft.projectId);
    const title = ticketTitle.trim();
    const criteria = ticketCriteria.trim();
    if (
      !targetProject ||
      targetProject.organizationId !== organization?.id ||
      !title ||
      !criteria
    )
      return;
    const next: Task = {
      ...draft,
      title,
      criteria,
      ticket: ticketReference.trim() || "Local draft",
      id: crypto.randomUUID(),
      stage: "Branch",
      status: "queued",
      updatedAt: new Date().toISOString(),
    };
    updateWorkspace((current) => ({
      ...current,
      tasks: [...current.tasks, next],
    }));
    setOrganizationId(targetProject.organizationId);
    setProjectId(targetProject.id);
    setSelectedId(next.id);
    setDraft(emptyDraftTarget);
    setTicketCriteriaSeed("");
    clearTicketTitle();
    clearTicketReference();
    clearTicketCriteria();
    setTaskOpened(false);
    setView("loops");
  }
  // What the picker hands back. Picking creates nothing: it writes an
  // opening message into the ticket agent's chat box and takes the person
  // there, and the agent fetches the real body and makes the ticket once
  // they send it. The queue's ticket agent only shows while no ticket is
  // selected, so the pick clears the selection to land them in front of it.
  function pickIssue(picked: ExternalIssue) {
    setTicketAgentPrefill((current) => ({
      id: (current?.id ?? 0) + 1,
      text: ticketAgentPrompt(picked),
    }));
    setImportOpened(false);
    setSelectedId("");
    setView("loops");
  }
  function requestCollaboration(target: CollaborationTarget) {
    setCollaborationTarget(target);
  }

  if (accessMode === null) {
    return <AccessScreen onLocalOnly={() => setAccessMode("local")} />;
  }

  return (
    <>
      <AppShell
        header={
          <WorkspaceHeader
            organizationName={organization?.name ?? "Organization"}
            projectName={project?.name}
            view={view}
            selectedTaskId={selectedId}
            navigationOpen={navigationOpen}
            onToggleNavigation={() => setNavigationOpen((open) => !open)}
            loop={loop}
            loopTicketId={
              loop.currentTicketId ??
              loopTicket?.id ??
              projectTickets.find(
                (item) =>
                  item.status === "review" &&
                  item.pullRequest?.review === "pending",
              )?.id ??
              ""
            }
            loopProject={loopProject}
            onWorkersChange={(workers) =>
              loopProject && saveProjectRecord({ ...loopProject, workers })
            }
          />
        }
        navigation={
          <WorkspaceNavigation
            open={navigationOpen}
            view={view}
            organizations={organizations}
            organization={organization}
            organizationProjects={organizationProjects}
            project={project}
            settingsProjectId={sourceSettingsProjectId}
            tasks={tasks}
            organizationTaskCount={organizationTasks.length}
            onSelectOrganization={selectOrganization}
            onSelectProject={selectProject}
            onShowOverview={() => {
              setProjectId("");
              setSelectedId("");
              setNavigationOpen(false);
              setView("organization");
            }}
            onShowOrganizationSettings={() => {
              setProjectId("");
              setSourceSettingsProjectId("");
              setSelectedId("");
              setNavigationOpen(false);
              setView("tools");
            }}
            onShowProjectSettings={showProjectSettings}
            onNewOrganization={() => setOrganizationOpened(true)}
            onNewProject={() => setProjectOpened(true)}
          />
        }
        account={
          <AccountMenu
            onOpenAccount={() => setCollaborationTarget("welcome")}
          />
        }
        systemStatus={
          <SystemStatus
            runtime={runtime}
            loopNote={loop.note}
            busyWorkers={busyWorkers}
          />
        }
      >
        {taskStoreError && (
          <p className="task-error" role="alert">
            Task storage error: {taskStoreError}
          </p>
        )}
        {view === "organization" && (
          <main className="organization-view">
            <div className="page-heading">
              <div>
                <h1>{organization?.name ?? "Your organization"}</h1>
                <p>Choose a project to plan tickets and follow agent work.</p>
              </div>
              <div className="heading-actions">
                {canCollaborate(workosSession) && (
                  <Button
                    variant="default"
                    leftSection={<IconUsers size={16} />}
                    disabled={!organization}
                    onClick={() =>
                      organization &&
                      requestCollaboration({
                        kind: "organization",
                        organizationId: organization.id,
                        organizationName: organization.name,
                      })
                    }
                  >
                    Members
                  </Button>
                )}
                <Button
                  leftSection={<IconPlus size={16} />}
                  disabled={!organization}
                  onClick={() => setProjectOpened(true)}
                >
                  New project
                </Button>
              </div>
            </div>
            <div className="summary-row">
              <div>
                <span>Projects</span>
                <strong>
                  {organizationProjects.length.toString().padStart(2, "0")}
                </strong>
              </div>
              <div>
                <span>Tickets</span>
                <strong>
                  {organizationTasks.length.toString().padStart(2, "0")}
                </strong>
              </div>
              <div>
                <span>Running · sample state</span>
                <strong>
                  {organizationTasks
                    .filter((item) => item.status === "running")
                    .length.toString()
                    .padStart(2, "0")}
                </strong>
              </div>
              <div>
                <span>In review</span>
                <strong>
                  {organizationTasks
                    .filter((item) => item.stage === "Review")
                    .length.toString()
                    .padStart(2, "0")}
                </strong>
              </div>
            </div>
            <div className="panel-heading">
              Projects <span>{organizationProjects.length}</span>
            </div>
            {organizationProjects.length ? (
              <div className="organization-projects">
                {organizationProjects.map((item) => {
                  const count = organizationTasks.filter(
                    (task) => task.projectId === item.id,
                  ).length;
                  return (
                    <button
                      key={item.id}
                      className="organization-project"
                      onClick={() => selectProject(item.id)}
                    >
                      <IconFolder size={22} />
                      <h2>{item.name}</h2>
                      <p>
                        {item.path || item.description || "No folder linked."}
                      </p>
                      <span>
                        {count} {count === 1 ? "ticket" : "tickets"}{" "}
                        <span aria-hidden="true">↗</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <section className="empty-project surface">
                <IconFolder size={30} />
                <h2>No projects in {organization?.name} yet.</h2>
                <p>
                  Open a folder or clone a repository to start adding tasks.
                </p>
                <Button
                  leftSection={<IconPlus size={15} />}
                  onClick={() => setProjectOpened(true)}
                >
                  New project
                </Button>
              </section>
            )}
            {archivedProjects.length > 0 && (
              <>
                <div className="panel-heading">
                  Archived <span>{archivedProjects.length}</span>
                </div>
                <div className="organization-projects">
                  {archivedProjects.map((item) => (
                    <button
                      key={item.id}
                      className="organization-project archived"
                      onClick={() => showProjectSettings(item.id)}
                    >
                      <IconFolder size={22} />
                      <h2>{item.name}</h2>
                      <p>
                        {item.path || item.description || "No folder linked."}
                      </p>
                      <span>
                        Open settings <span aria-hidden="true">↗</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </main>
        )}
        {(view === "loops" || view === "queue") && (
          <QueueView
            runtime={agents}
            onPrepareAgent={async () => {
              if (isTauri())
                await invoke("save_agent_preferences", {
                  preferences: agentPreferences,
                });
            }}
            workspace={workspace}
            projects={organizationProjects}
            projectId={projectId}
            organizationId={organization?.id ?? ""}
            onLinkProject={(id) => {
              setLinkProjectId(id);
              setProjectOpened(true);
            }}
            selectedTicketId={selectedId}
            onSelectTicket={setSelectedId}
            loopTicketId={
              loop.currentTicketId ??
              loopTicket?.id ??
              projectTickets.find(
                (item) =>
                  item.status === "review" &&
                  item.pullRequest?.review === "pending",
              )?.id ??
              ""
            }
            onLoopTicket={(id) => {
              // Pointing the loop at a ticket is a request to work on it. If
              // the loop is not running, nothing would come of it otherwise.
              setLoopTicketId(id);
              if (!loop.running) loop.start();
            }}
            update={updateWorkspace}
            onNewTicket={() => openTaskDraft()}
            onImportTicket={(provider) => {
              setImportProvider(provider ?? "Linear");
              setImportOpened(true);
            }}
            onNewProject={() => setProjectOpened(true)}
            canImport={isTauri()}
            ticketSources={enabledTicketSources}
            onConfigureSources={() => {
              setSourceSettingsProjectId(projectId);
              setView("tools");
            }}
            ready={tasksReady}
            ticketAgentPrefill={ticketAgentPrefill}
            beta={betaEnabled(harnessSettings)}
          />
        )}
        {view === "tools" && (
          <main className="tools-view">
            <div className="settings-page">
              <div className="settings-heading">
                <p className="app-eyebrow">
                  {sourceSettingsProjectId ? "PROJECT" : "ORGANIZATION"}
                </p>
                <h1>
                  {sourceSettingsProjectId
                    ? (settingsProject?.name ?? "Project")
                    : (organization?.name ?? "Organization")}
                </h1>
                <p className="settings-heading-note">
                  {sourceSettingsProjectId
                    ? "These settings override the organization defaults."
                    : "Defaults for every project in this organization."}
                </p>
              </div>

              {settingsProject && (
                <section className="settings-group">
                  <h2>Project</h2>
                  <div className="settings-row">
                    <div>
                      <label htmlFor="project-name">Name</label>
                      <p>Shown in the sidebar and the project list.</p>
                    </div>
                    <TextInput
                      id="project-name"
                      size="xs"
                      className="settings-row-control"
                      value={projectNameDraft}
                      onChange={(event) =>
                        setProjectNameDraft(event.currentTarget.value)
                      }
                      onBlur={saveProjectName}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                  </div>
                  <div className="settings-row">
                    <div>
                      <label>Folder</label>
                      <p className="settings-row-path">
                        {settingsProject.path ||
                          "No folder linked. Workers cannot run."}
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => {
                        setLinkProjectId(settingsProject.id);
                        setProjectOpened(true);
                      }}
                    >
                      {settingsProject.path ? "Change..." : "Choose..."}
                    </Button>
                  </div>
                </section>
              )}

              <section className="settings-group">
                <h2>Ticket sources</h2>
                <div className="settings-row">
                  <div>
                    <label>Import buttons</label>
                    <p>
                      Only selected sources appear above the ticket queue. Each
                      source searches with the connection set below.
                    </p>
                  </div>
                  <MultiSelect
                    size="xs"
                    className="settings-row-control"
                    data={ticketProviders}
                    value={visibleSettingsSources}
                    onChange={(value) => {
                      if (sourceSettingsProjectId)
                        setTicketSources(
                          "projects",
                          sourceSettingsProjectId,
                          value as ExternalProvider[],
                        );
                      else if (organization)
                        setTicketSources(
                          "organizations",
                          organization.id,
                          value as ExternalProvider[],
                        );
                    }}
                  />
                </div>
                {sourceSettingsProjectId &&
                  projectSources[sourceSettingsProjectId] !== undefined && (
                    <div className="settings-row">
                      <div>
                        <label>Override</label>
                        <p>This project ignores the organization sources.</p>
                      </div>
                      <Button
                        size="xs"
                        variant="default"
                        onClick={() =>
                          setTicketSources(
                            "projects",
                            sourceSettingsProjectId,
                            null,
                          )
                        }
                      >
                        Use organization sources
                      </Button>
                    </div>
                  )}
                {connectionScopeId && (
                  <>
                    <p className="settings-group-note">
                      {sourceSettingsProjectId
                        ? `Anything left blank falls back to ${organization?.name ?? "the organization"}.`
                        : "Every project in this organization uses these unless it sets its own."}
                    </p>
                    <div className="provider-connections">
                      {ticketProviders.map((provider) => (
                        <ProviderConnection
                          key={provider}
                          provider={provider}
                          scope={connectionScope}
                          scopeId={connectionScopeId}
                          settings={connectionAt(
                            connectionScope,
                            connectionScopeId,
                            provider,
                          )}
                          inherited={
                            sourceSettingsProjectId
                              ? connectionAt(
                                  "organizations",
                                  organization?.id ?? "",
                                  provider,
                                )
                              : undefined
                          }
                          inheritedFrom={
                            organization?.name ?? "the organization"
                          }
                          onPatch={(patch) => setConnection(provider, patch)}
                          onConnected={(connected) =>
                            setConnection(provider, { connected })
                          }
                          onUseOrganization={
                            sourceSettingsProjectId &&
                            connectionAt(
                              "projects",
                              sourceSettingsProjectId,
                              provider,
                            )
                              ? () => useOrganizationConnection(provider)
                              : null
                          }
                        />
                      ))}
                    </div>
                  </>
                )}
              </section>

              <section className="settings-group">
                <h2>Agent defaults</h2>
                <div className="settings-row">
                  <div>
                    <label>Harness and model options</label>
                    <p>
                      {harnessOptions.catalog
                        ? `Updated ${new Date(harnessOptions.catalog.fetchedAt * 1000).toLocaleString()}. Refreshes every 24 hours.`
                        : "Options are saved on this device."}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="default"
                    loading={harnessOptions.loading}
                    disabled={!harnessOptions.connected}
                    onClick={() => void harnessOptions.refresh()}
                  >
                    Refresh options
                  </Button>
                </div>
                {harnessOptions.error && (
                  <p className="task-error" role="alert">
                    {harnessOptions.error}
                  </p>
                )}
                {agentRoles.map(({ id, label }) => {
                  const preference = rolePreference(id);
                  const overridden = Boolean(
                    sourceSettingsProjectId &&
                    agentPreferences.projects[sourceSettingsProjectId]?.[id],
                  );
                  return (
                    <div className="settings-row settings-row-stacked" key={id}>
                      <div className="settings-row-top">
                        <div>
                          <label>{label}</label>
                          <p>
                            {overridden
                              ? "Overriding the organization default."
                              : "Harness, model and extra instructions for this role."}
                          </p>
                        </div>
                      </div>
                      <HarnessModelSelects
                        preference={preference}
                        projectSettings={Boolean(sourceSettingsProjectId)}
                        override={
                          agentPreferences.projects[sourceSettingsProjectId]?.[
                            id
                          ]
                        }
                        catalog={harnessOptions.catalog}
                        loading={harnessOptions.loading}
                        connected={harnessOptions.connected}
                        onChange={(patch) => setRolePreference(id, patch)}
                      />
                      <RoleSystemPrompt
                        role={id}
                        label={label}
                        scope={rolePromptScope}
                        committed={preference.systemPrompt}
                        onChange={(systemPrompt) =>
                          setRolePreference(id, { systemPrompt })
                        }
                      />
                      {overridden && (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          onClick={() =>
                            setAgentPreferences((current) => {
                              const roles = {
                                ...current.projects[sourceSettingsProjectId],
                              };
                              delete roles[id];
                              return {
                                ...current,
                                projects: {
                                  ...current.projects,
                                  [sourceSettingsProjectId]: roles,
                                },
                              };
                            })
                          }
                        >
                          Use organization default
                        </Button>
                      )}
                    </div>
                  );
                })}
              </section>

              {!sourceSettingsProjectId && (
                <section className="settings-group">
                  <h2>Beta features</h2>
                  <p className="settings-group-note">
                    A decision model screens read-only commands, marks a worker
                    that is going in circles, checks where an instruction was
                    aimed, and orders the queues. Add a key for one gateway.
                    Both work; with both, OpenRouter is used.
                  </p>
                  <div className="settings-row">
                    <div>
                      <label htmlFor="openrouter-key">OpenRouter key</label>
                      <p>Kept on this machine. It never reaches the window.</p>
                    </div>
                    {/* A secret: never a draft. It is kept by harnessSettings. */}
                    <PasswordInput
                      id="openrouter-key"
                      size="xs"
                      className="settings-row-control"
                      placeholder="sk-or-v1-…"
                      value={harnessSettings.openrouterKey ?? ""}
                      onChange={(event) =>
                        setHarnessSettings({
                          openrouterKey: event.currentTarget.value,
                        })
                      }
                    />
                  </div>
                  <div className="settings-row">
                    <div>
                      <label htmlFor="vercel-key">Vercel AI Gateway key</label>
                      <p>Kept on this machine. It never reaches the window.</p>
                    </div>
                    {/* A secret: never a draft. It is kept by harnessSettings. */}
                    <PasswordInput
                      id="vercel-key"
                      size="xs"
                      className="settings-row-control"
                      placeholder="vck_…"
                      value={harnessSettings.vercelKey ?? ""}
                      onChange={(event) =>
                        setHarnessSettings({
                          vercelKey: event.currentTarget.value,
                        })
                      }
                    />
                  </div>
                  <div className="settings-row">
                    <div>
                      <label htmlFor="beta-on">Use the beta features</label>
                      <p>
                        {betaEnabled(harnessSettings)
                          ? "On. Each decision costs a fraction of a cent."
                          : "Off. Add a key above to turn it on."}
                      </p>
                    </div>
                    <Switch
                      id="beta-on"
                      size="sm"
                      checked={harnessSettings.beta ?? false}
                      disabled={
                        !harnessSettings.openrouterKey?.trim() &&
                        !harnessSettings.vercelKey?.trim()
                      }
                      onChange={(event) =>
                        setHarnessSettings({
                          beta: event.currentTarget.checked,
                        })
                      }
                    />
                  </div>
                  {harnessSettingsError && (
                    <p className="settings-error">{harnessSettingsError}</p>
                  )}
                </section>
              )}

              {settingsProject && (
                <section className="settings-group danger">
                  <h2>Danger zone</h2>
                  <div className="settings-row">
                    <div>
                      <label>
                        {settingsProject.archived
                          ? "Restore project"
                          : "Archive project"}
                      </label>
                      <p>
                        {settingsProject.archived
                          ? "Put it back on the project lists."
                          : "Hide it from the project lists. Tickets are kept."}
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() =>
                        saveProjectRecord({
                          ...settingsProject,
                          archived: !settingsProject.archived,
                        })
                      }
                    >
                      {settingsProject.archived ? "Restore" : "Archive"}
                    </Button>
                  </div>
                  <div className="settings-row">
                    <div>
                      <label>Delete project</label>
                      <p>Removes the project and its tickets. No undo.</p>
                    </div>
                    <Button
                      size="xs"
                      variant={
                        confirmDeleteProject === settingsProject.id
                          ? "filled"
                          : "default"
                      }
                      color="red"
                      onClick={() =>
                        confirmDeleteProject === settingsProject.id
                          ? deleteProject(settingsProject.id)
                          : setConfirmDeleteProject(settingsProject.id)
                      }
                    >
                      {confirmDeleteProject === settingsProject.id
                        ? "Click again"
                        : "Delete"}
                    </Button>
                  </div>
                </section>
              )}

              {preferencesError && (
                <p className="task-error" role="alert">
                  {preferencesError}
                </p>
              )}
            </div>
          </main>
        )}
      </AppShell>
      <WorkOSRequiredModal
        target={collaborationTarget}
        onClose={() => setCollaborationTarget(null)}
      />
      <Modal
        opened={organizationOpened}
        onClose={() => setOrganizationOpened(false)}
        title="New organization"
        centered
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            addOrganization();
          }}
        >
          <TextInput
            required
            autoFocus
            label="Organization name"
            placeholder="Your team or company"
            value={organizationName}
            error={
              duplicateOrganization
                ? "An organization with this name already exists."
                : undefined
            }
            onChange={(event) => setOrganizationName(event.currentTarget.value)}
          />
          <Button
            fullWidth
            mt="xl"
            type="submit"
            disabled={!organizationName.trim() || duplicateOrganization}
          >
            Create organization
          </Button>
        </form>
      </Modal>
      <Modal
        opened={projectOpened}
        onClose={() => {
          if (!projectBusy) {
            setProjectOpened(false);
            resetProjectForm();
          }
        }}
        title={
          linkProjectId
            ? `Link folder to ${
                projects.find((item) => item.id === linkProjectId)?.name ??
                "project"
              }`
            : `Add project to ${organization?.name ?? "organization"}`
        }
        centered
      >
        <Tabs
          value={projectSource}
          onChange={(value) => {
            setProjectSource(value as "local" | "clone");
            setProjectInfo(null);
            setProjectError(null);
          }}
        >
          <Tabs.List grow>
            <Tabs.Tab value="local">Open local folder</Tabs.Tab>
            <Tabs.Tab value="clone">Clone repository</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="local" pt="md">
            <TextInput
              label="Folder"
              placeholder="No folder chosen"
              value={projectPath}
              readOnly
              onClick={() =>
                void pickFolder((path) => {
                  setProjectPath(path);
                  setProjectInfo(null);
                })
              }
              rightSectionWidth={100}
              rightSection={
                <Button
                  size="compact-sm"
                  variant="default"
                  onClick={() =>
                    void pickFolder((path) => {
                      setProjectPath(path);
                      setProjectInfo(null);
                    })
                  }
                >
                  Choose...
                </Button>
              }
            />
            {!projectInfo ? (
              <Button
                fullWidth
                mt="md"
                onClick={() => void inspectProject()}
                loading={projectBusy}
                disabled={!projectPath.trim()}
              >
                Open folder
              </Button>
            ) : (
              <>
                <p>
                  <strong>{projectInfo.name}</strong>
                  <br />
                  {projectInfo.path}
                </p>
                {projectInfo.isGit ? (
                  <p>
                    Git repository
                    {projectInfo.branch ? ` · ${projectInfo.branch}` : ""}
                    {projectInfo.remoteUrl ? ` · ${projectInfo.remoteUrl}` : ""}
                  </p>
                ) : (
                  <>
                    <p>No Git repository found in this folder.</p>
                    <Button
                      variant="default"
                      onClick={() => void initProject()}
                      loading={projectBusy}
                    >
                      Initialize Git
                    </Button>
                  </>
                )}
                <Button
                  fullWidth
                  mt="md"
                  onClick={() => saveProject(projectInfo)}
                  disabled={duplicateProject || projectBusy}
                >
                  {linkProjectId ? "Link folder" : "Add project"}
                </Button>
              </>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="clone" pt="md">
            <TextInput
              label="GitHub or GitLab repository URL"
              placeholder="https://github.com/team/repo.git"
              value={cloneUrl}
              onChange={(event) => setCloneUrl(event.currentTarget.value)}
            />
            <TextInput
              mt="md"
              label="Destination folder"
              description="The repository will be cloned into a new folder here."
              placeholder="No folder chosen"
              value={cloneDestination}
              readOnly
              onClick={() => void pickFolder(setCloneDestination)}
              rightSectionWidth={100}
              rightSection={
                <Button
                  size="compact-sm"
                  variant="default"
                  onClick={() => void pickFolder(setCloneDestination)}
                >
                  Choose...
                </Button>
              }
            />
            <Button
              fullWidth
              mt="xl"
              onClick={() => void cloneProject()}
              loading={projectBusy}
              disabled={!cloneUrl.trim() || !cloneDestination.trim()}
            >
              Clone and add project
            </Button>
          </Tabs.Panel>
        </Tabs>
        {duplicateProject && (
          <p role="alert" className="task-error">
            This folder is already a project.
          </p>
        )}
        {projectError && (
          <p role="alert" className="task-error">
            {projectError}
          </p>
        )}
      </Modal>
      <Modal
        opened={projectSetup !== null}
        onClose={() => setProjectSetup(null)}
        title="Set up to run with several workers"
      >
        <p>
          Berdloop added a <code>.berd/</code> directory to this project. It
          holds the ports, databases and environment each worker gets, so
          several can run the app at once. Nothing else in the project was
          changed, and your own setup still runs exactly as it did.
        </p>
        <ul>
          {(projectSetup?.notes ?? []).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <p>
          Read <code>.berd/README.md</code> to change any of it, then commit the
          directory so every worker gets the same setup.
        </p>
      </Modal>
      <Modal
        opened={importOpened}
        onClose={() => setImportOpened(false)}
        title="Import a source ticket"
        centered
      >
        {pickerProviders.length > 1 && (
          <Select
            label="Source"
            data={pickerProviders}
            value={importProvider}
            allowDeselect={false}
            onChange={(value) => {
              if (!value) return;
              setImportProvider(value as ExternalProvider);
            }}
          />
        )}
        <TicketPicker
          key={importProvider}
          provider={importProvider}
          organizationId={project?.organizationId ?? ""}
          projectId={project?.id ?? ""}
          busy={!project}
          onPickIssue={pickIssue}
          onOpenSettings={() => {
            setImportOpened(false);
            setSourceSettingsProjectId(projectId);
            setView("tools");
          }}
        />
      </Modal>
      <Modal
        opened={taskOpened}
        onClose={() => setTaskOpened(false)}
        title="New ticket"
        centered
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            addTask();
          }}
        >
          <TextInput
            required
            label="Ticket title"
            placeholder="Add the paused state check"
            value={ticketTitle}
            onChange={(event) => setTicketTitle(event.currentTarget.value)}
          />
          <Select
            required
            mt="md"
            label="Project"
            data={projectOptions}
            value={draft.projectId || null}
            onChange={(value) => retargetDraft(value ?? "")}
            allowDeselect={false}
          />
          <Select
            mt="md"
            label="Source reference"
            description="This records a reference. It does not import a ticket."
            data={["Local", "Jira", "Asana", "Linear"]}
            value={draft.source}
            allowDeselect={false}
            onChange={(value) =>
              value && setDraft({ ...draft, source: value as TicketProvider })
            }
          />
          <TextInput
            mt="md"
            label="Ticket ID or reference"
            placeholder="BRD-128"
            value={ticketReference}
            onChange={(event) => setTicketReference(event.currentTarget.value)}
          />
          <Textarea
            required
            mt="md"
            minRows={3}
            autosize
            label="Requirements & acceptance criteria"
            placeholder="A paused task does not advance to the next stage."
            value={ticketCriteria}
            onChange={(event) => setTicketCriteria(event.currentTarget.value)}
          />
          <Button
            fullWidth
            mt="xl"
            type="submit"
            disabled={
              !ticketTitle.trim() || !ticketCriteria.trim() || !draft.projectId
            }
          >
            Create ticket
          </Button>
        </form>
      </Modal>
    </>
  );
}
