import { useEffect, useState } from "react";
import {
  Button,
  Modal,
  MultiSelect,
  Select,
  Tabs,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { IconFolder, IconPlus, IconUsers } from "@tabler/icons-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  importIssue,
  migrateTasks,
  starterProjectId,
  type AccountSession,
  type ExternalIssue,
  type ExternalProvider,
  type Organization,
  type Project,
  type Task,
  type TicketProvider,
} from "@berdloop/core";
import { useBerdloop } from "@berdloop/state";
import { useTaskWorkspace } from "./task-storage";
import { useQueueWatcher } from "./queue-watcher";
import {
  AccessScreen,
  WorkOSRequiredModal,
  canCollaborate,
  type CollaborationTarget,
} from "./access";
import { QueueView, topTicket } from "./queue";
import { useWorkflowRuntime } from "./workflow-runtime";
import { defaultWorkers, useRalphLoop } from "./ralph-loop";
import { AppShell } from "./layout/AppShell";
import { WorkspaceHeader } from "./layout/WorkspaceHeader";
import { WorkspaceNavigation } from "./layout/WorkspaceNavigation";
import { AccountMenu, SystemStatus } from "./layout/WorkspaceFooters";
import type { WorkspaceView } from "./layout/types";
import {
  agentRoles,
  emptyAgentPreferences,
  type AgentPreferences,
  type AgentRoleSetting,
  type RolePreference,
} from "./agent-preferences";

// The WorkOS adapter will provide this after account auth is connected.
const workosSession: AccountSession | null = null;

interface Draft {
  title: string;
  projectId: string;
  source: TicketProvider;
  ticket: string;
  criteria: string;
}
interface ImportDraft {
  provider: ExternalProvider;
  reference: string;
  token: string;
  jiraSite: string;
  jiraEmail: string;
}
const emptyImportDraft: ImportDraft = {
  provider: "Linear",
  reference: "",
  token: "",
  jiraSite: "",
  jiraEmail: "",
};
interface ProjectInfo {
  path: string;
  name: string;
  isGit: boolean;
  branch: string | null;
  remoteUrl: string | null;
  provider: string | null;
}
const emptyDraft: Draft = {
  title: "",
  projectId: "",
  source: "Local",
  ticket: "",
  criteria: "",
};

export default function App() {
  const [accessMode, setAccessMode] = useLocalStorage<"local" | null>({
    key: "berdloop.preview.access-mode.v1",
    defaultValue: null,
  });
  const [collaborationTarget, setCollaborationTarget] = useState<
    CollaborationTarget | "welcome" | null
  >(null);
  const [view, setView] = useState<WorkspaceView>("queue");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const organizations = useBerdloop((state) => state.organizations);
  const addOrganizationRecord = useBerdloop(
    (state) => state.upsertOrganization,
  );
  const projects = useBerdloop((state) => state.projects);
  const saveProjectRecord = useBerdloop((state) => state.upsertProject);
  const {
    workspace,
    update: updateWorkspace,
    ready: tasksReady,
    error: taskStoreError,
  } = useTaskWorkspace(workosSession);
  const tasks = workspace.tasks;

  // The agent system, and the loop that keeps handing it work.
  const agents = useWorkflowRuntime();
  const loopTicketId = useBerdloop((state) => state.ticketId);
  const setLoopTicketId = useBerdloop((state) => state.setTicketId);
  const [sourceSettingsProjectId, setSourceSettingsProjectId] = useState("");
  const [agentPreferences, setAgentPreferences] =
    useLocalStorage<AgentPreferences>({
      key: "berdloop.agent-preferences.v1",
      defaultValue: emptyAgentPreferences,
    });
  const [preferencesLoaded, setPreferencesLoaded] = useState(!isTauri());
  const [preferencesError, setPreferencesError] = useState("");
  const organizationId = useBerdloop((state) => state.organizationId);
  const setOrganizationId = useBerdloop((state) => state.setOrganizationId);
  const projectId = useBerdloop((state) => state.projectId);
  const setProjectId = useBerdloop((state) => state.setProjectId);
  // The agents write the queue files; this keeps the store true to them.
  useQueueWatcher(projectId);
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
  const loop = useRalphLoop({
    workspace,
    update: updateWorkspace,
    project: loopProject,
    ticket: loopTicket,
    slots: loopProject?.workers ?? defaultWorkers,
    startAgent: async ({ key, plan }) => {
      if (isTauri())
        await invoke("save_agent_preferences", {
          preferences: agentPreferences,
        });
      return agents.launch(key, plan, {
        organizationId,
        projectId,
        role: "worker",
      });
    },
  });
  const [selectedId, setSelectedId] = useState("");
  const [taskOpened, setTaskOpened] = useState(false);
  const [importOpened, setImportOpened] = useState(false);
  const [importDraft, setImportDraft] = useState<ImportDraft>(emptyImportDraft);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [organizationOpened, setOrganizationOpened] = useState(false);
  const [projectOpened, setProjectOpened] = useState(false);
  const [linkProjectId, setLinkProjectId] = useState<string | null>(null);
  const [organizationName, setOrganizationName] = useState("");
  const [projectSource, setProjectSource] = useState<"local" | "clone">(
    "local",
  );
  const [projectPath, setProjectPath] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneDestination, setCloneDestination] = useState("");
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
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

  const organization =
    organizations.find((item) => item.id === organizationId) ??
    organizations[0];
  const organizationProjects = projects.filter(
    (item) => item.organizationId === organization?.id,
  );
  const projectOptions = organizationProjects.map((item) => ({
    value: item.id,
    label: item.name,
  }));
  const project = organizationProjects.find((item) => item.id === projectId);
  const settingsProject = organizationProjects.find(
    (item) => item.id === sourceSettingsProjectId,
  );
  const sourceSettings =
    agentPreferences.ticketSources ?? emptyAgentPreferences.ticketSources;
  const organizationSources = sourceSettings.organizations;
  const projectSources = sourceSettings.projects;
  const enabledTicketSources =
    projectId && projectSources[projectId] !== undefined
      ? projectSources[projectId]
      : (organizationSources[organization?.id ?? ""] ?? []);
  const visibleSettingsSources = sourceSettingsProjectId
    ? (projectSources[sourceSettingsProjectId] ??
      organizationSources[organization?.id ?? ""] ??
      [])
    : (organizationSources[organization?.id ?? ""] ?? []);
  function rolePreference(role: AgentRoleSetting): RolePreference {
    return (
      (sourceSettingsProjectId
        ? agentPreferences.projects[sourceSettingsProjectId]?.[role]
        : undefined) ??
      agentPreferences.organizations[organization?.id ?? ""]?.[role] ?? {
        model: "",
        systemPrompt: "",
      }
    );
  }
  function setRolePreference(
    role: AgentRoleSetting,
    patch: Partial<RolePreference>,
  ) {
    const scopeId = sourceSettingsProjectId || organization?.id;
    if (!scopeId) return;
    setAgentPreferences((current) => {
      const key = sourceSettingsProjectId ? "projects" : "organizations";
      const existing = current[key][scopeId]?.[role] ??
        (sourceSettingsProjectId
          ? current.organizations[organization?.id ?? ""]?.[role]
          : undefined) ?? { model: "", systemPrompt: "" };
      return {
        ...current,
        [key]: {
          ...current[key],
          [scopeId]: {
            ...current[key][scopeId],
            [role]: { ...existing, ...patch },
          },
        },
      };
    });
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
    projectInfo && projects.some((item) => item.path === projectInfo.path),
  );

  function selectOrganization(id: string) {
    setOrganizationId(id);
    setProjectId("");
    setSourceSettingsProjectId("");
    setSelectedId("");
    setNavigationOpen(false);
    setView("organization");
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
    setOrganizationName("");
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
    if (projects.some((item) => item.path === info.path)) {
      setProjectError("This folder is already a project.");
      return;
    }
    const linked = linkProjectId
      ? projects.find((item) => item.id === linkProjectId)
      : null;
    const next: Project = {
      id: linked?.id ?? crypto.randomUUID(),
      organizationId: organization.id,
      name: linked?.name ?? info.name,
      description: linked?.description || info.remoteUrl || "",
      path: info.path,
      isGit: info.isGit,
      branch: info.branch,
      remoteUrl: info.remoteUrl,
      provider: info.provider,
    };
    saveProjectRecord(next);
    setProjectId(next.id);
    setSelectedId("");
    setProjectOpened(false);
    resetProjectForm();
    setView("loops");
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
  function openTaskDraft(criteria = "") {
    const target = project ?? organizationProjects[0];
    if (!target) return;
    setDraft({ ...emptyDraft, projectId: target.id, criteria });
    setTaskOpened(true);
  }
  function addTask() {
    const targetProject = projects.find((item) => item.id === draft.projectId);
    if (
      !targetProject ||
      targetProject.organizationId !== organization?.id ||
      !draft.title.trim() ||
      !draft.criteria.trim()
    )
      return;
    const next: Task = {
      ...draft,
      title: draft.title.trim(),
      criteria: draft.criteria.trim(),
      ticket: draft.ticket.trim() || "Local draft",
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
    setDraft(emptyDraft);
    setTaskOpened(false);
    setView("loops");
  }
  async function importTask() {
    if (!project || !isTauri()) return;
    setImportBusy(true);
    setImportError(null);
    try {
      const issue = await invoke<ExternalIssue>("fetch_external_issue", {
        input: importDraft,
      });
      let importedId = "";
      updateWorkspace((current) => {
        const imported = importIssue(current, issue, project.id);
        importedId = imported.task.id;
        return imported.workspace;
      });
      setSelectedId(importedId);
      setImportDraft(emptyImportDraft);
      setImportOpened(false);
      setView("loops");
    } catch (cause) {
      setImportError(String(cause));
    } finally {
      setImportBusy(false);
    }
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
            loopTicketId={loopTicket?.id ?? ""}
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
            onShowProjectSettings={(id) => {
              setProjectId(id);
              setSourceSettingsProjectId(id);
              setSelectedId("");
              setNavigationOpen(false);
              setView("tools");
            }}
            onNewOrganization={() => setOrganizationOpened(true)}
            onNewProject={() => setProjectOpened(true)}
          />
        }
        account={
          <AccountMenu
            onOpenAccount={() => setCollaborationTarget("welcome")}
          />
        }
        systemStatus={<SystemStatus runtime={runtime} />}
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
            loopTicketId={loopTicket?.id ?? ""}
            onLoopTicket={setLoopTicketId}
            update={updateWorkspace}
            onNewTicket={() => openTaskDraft()}
            onImportTicket={(provider) => {
              setImportError(null);
              setImportDraft({
                ...emptyImportDraft,
                provider: provider ?? "Linear",
              });
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
          />
        )}
        {view === "tools" && (
          <main className="tools-view">
            <div className="page-heading">
              <div>
                <h1>
                  {sourceSettingsProjectId
                    ? `${settingsProject?.name ?? "Project"} settings`
                    : `${organization?.name ?? "Organization"} settings`}
                </h1>
                <p>
                  {sourceSettingsProjectId
                    ? "Project ticket sources and agent defaults override organization settings."
                    : "Default ticket sources and agent settings for this organization."}
                </p>
              </div>
            </div>
            <section className="surface ticket-source-settings">
              <p className="app-eyebrow">TICKET SOURCES</p>
              <h2>Import buttons</h2>
              <p>
                Only selected sources appear above the ticket queue. Credentials
                are entered during import.
              </p>
              <MultiSelect
                label="Visible sources"
                data={["Linear", "Jira", "Asana"]}
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
              {sourceSettingsProjectId &&
                projectSources[sourceSettingsProjectId] !== undefined && (
                  <Button
                    size="xs"
                    variant="subtle"
                    mt="sm"
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
                )}
            </section>
            <div className="agent-preferences-grid">
              {agentRoles.map(({ id, label }) => {
                const preference = rolePreference(id);
                return (
                  <section className="surface agent-preference" key={id}>
                    <div className="agent-preference-heading">
                      <h2>{label}</h2>
                      {sourceSettingsProjectId &&
                        agentPreferences.projects[sourceSettingsProjectId]?.[
                          id
                        ] && (
                          <Button
                            size="xs"
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
                            Use organization defaults
                          </Button>
                        )}
                    </div>
                    <TextInput
                      label="Default model"
                      placeholder="Harness default"
                      value={preference.model}
                      onChange={(event) =>
                        setRolePreference(id, {
                          model: event.currentTarget.value,
                        })
                      }
                    />
                    <Textarea
                      mt="md"
                      label="Additional system prompt"
                      autosize
                      minRows={3}
                      placeholder="Instructions for every agent in this role"
                      value={preference.systemPrompt}
                      onChange={(event) =>
                        setRolePreference(id, {
                          systemPrompt: event.currentTarget.value,
                        })
                      }
                    />
                  </section>
                );
              })}
            </div>
            {preferencesError && (
              <p className="task-error" role="alert">
                {preferencesError}
              </p>
            )}
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
            ? `Link folder to ${project?.name ?? "project"}`
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
                  Add project
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
        opened={importOpened}
        onClose={() => {
          if (!importBusy) {
            setImportOpened(false);
            setImportDraft(emptyImportDraft);
          }
        }}
        title="Import a source ticket"
        centered
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void importTask();
          }}
        >
          <p className="app-eyebrow">{importDraft.provider.toUpperCase()}</p>
          {importDraft.provider === "Jira" && (
            <>
              <TextInput
                required
                mt="md"
                label="Jira Cloud site"
                placeholder="https://your-team.atlassian.net"
                value={importDraft.jiraSite}
                onChange={(event) =>
                  setImportDraft({
                    ...importDraft,
                    jiraSite: event.currentTarget.value,
                  })
                }
              />
              <TextInput
                required
                mt="md"
                label="Atlassian account email"
                value={importDraft.jiraEmail}
                onChange={(event) =>
                  setImportDraft({
                    ...importDraft,
                    jiraEmail: event.currentTarget.value,
                  })
                }
              />
            </>
          )}
          <TextInput
            required
            mt="md"
            label={
              importDraft.provider === "Asana" ? "Task GID" : "Issue ID or key"
            }
            placeholder={
              importDraft.provider === "Asana" ? "1200123456789" : "BRD-128"
            }
            value={importDraft.reference}
            onChange={(event) =>
              setImportDraft({
                ...importDraft,
                reference: event.currentTarget.value,
              })
            }
          />
          <TextInput
            required
            mt="md"
            type="password"
            label={
              importDraft.provider === "Jira"
                ? "Atlassian API token"
                : "Personal access token"
            }
            description="Used for this import only. Berdloop does not save it."
            value={importDraft.token}
            onChange={(event) =>
              setImportDraft({
                ...importDraft,
                token: event.currentTarget.value,
              })
            }
          />
          {importError && (
            <p role="alert" className="task-error">
              {importError}
            </p>
          )}
          <Button
            fullWidth
            mt="xl"
            type="submit"
            loading={importBusy}
            disabled={
              !project ||
              !importDraft.reference.trim() ||
              !importDraft.token.trim()
            }
          >
            Import into {project?.name ?? "project"}
          </Button>
        </form>
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
            value={draft.title}
            onChange={(event) =>
              setDraft({ ...draft, title: event.currentTarget.value })
            }
          />
          <Select
            required
            mt="md"
            label="Project"
            data={projectOptions}
            value={draft.projectId || null}
            onChange={(value) => setDraft({ ...draft, projectId: value ?? "" })}
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
            value={draft.ticket}
            onChange={(event) =>
              setDraft({ ...draft, ticket: event.currentTarget.value })
            }
          />
          <Textarea
            required
            mt="md"
            minRows={3}
            autosize
            label="Requirements & acceptance criteria"
            placeholder="A paused task does not advance to the next stage."
            value={draft.criteria}
            onChange={(event) =>
              setDraft({ ...draft, criteria: event.currentTarget.value })
            }
          />
          <Button
            fullWidth
            mt="xl"
            type="submit"
            disabled={
              !draft.title.trim() || !draft.criteria.trim() || !draft.projectId
            }
          >
            Create ticket
          </Button>
        </form>
      </Modal>
    </>
  );
}
