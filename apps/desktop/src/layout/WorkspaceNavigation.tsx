import { Select } from "@mantine/core";
import {
  IconFolder,
  IconLayoutDashboard,
  IconPlus,
  IconSettings,
} from "@tabler/icons-react";
import {
  starterProjectId,
  type Organization,
  type Project,
  type Task,
} from "@berdloop/core";
import type { WorkspaceView } from "./types";

interface WorkspaceNavigationProps {
  open: boolean;
  view: WorkspaceView;
  organizations: Organization[];
  organization?: Organization;
  organizationProjects: Project[];
  project?: Project;
  settingsProjectId: string;
  tasks: Task[];
  organizationTaskCount: number;
  onSelectOrganization: (id: string) => void;
  onSelectProject: (id: string) => void;
  onShowOverview: () => void;
  onShowOrganizationSettings: () => void;
  onShowProjectSettings: (id: string) => void;
  onNewOrganization: () => void;
  onNewProject: () => void;
}

export function WorkspaceNavigation({
  open,
  view,
  organizations,
  organization,
  organizationProjects,
  project,
  settingsProjectId,
  tasks,
  organizationTaskCount,
  onSelectOrganization,
  onSelectProject,
  onShowOverview,
  onShowOrganizationSettings,
  onShowProjectSettings,
  onNewOrganization,
  onNewProject,
}: WorkspaceNavigationProps) {
  return (
    <aside
      id="workspace-sidebar"
      className={`app-sidebar ${open ? "mobile-open" : ""}`}
    >
      <div className="sidebar-heading">
        <span>ORGANIZATION</span>
        <button
          type="button"
          aria-label="New organization"
          title="New organization"
          onClick={onNewOrganization}
        >
          <IconPlus size={15} />
        </button>
      </div>
      <Select
        aria-label="Organization"
        data={organizations.map((item) => ({
          value: item.id,
          label: item.name,
        }))}
        value={organization?.id ?? null}
        onChange={(value) => value && onSelectOrganization(value)}
        allowDeselect={false}
        placeholder="Choose an organization"
      />
      <nav
        aria-label="Organization navigation"
        className="organization-navigation"
      >
        <button
          type="button"
          className={view === "organization" ? "selected" : ""}
          aria-current={view === "organization" ? "page" : undefined}
          onClick={onShowOverview}
        >
          <IconLayoutDashboard size={17} /> Overview
          <small>{organizationTaskCount}</small>
        </button>
        <button
          type="button"
          className={view === "tools" && !settingsProjectId ? "selected" : ""}
          aria-current={
            view === "tools" && !settingsProjectId ? "page" : undefined
          }
          onClick={onShowOrganizationSettings}
        >
          <IconSettings size={17} /> Settings
        </button>
      </nav>
      <div className="sidebar-heading projects-heading">
        <span>PROJECTS</span>
        <button
          type="button"
          aria-label="New project"
          title="New project"
          disabled={!organization}
          onClick={onNewProject}
        >
          <IconPlus size={15} />
        </button>
      </div>
      <div className="project-navigation" aria-label="Projects">
        {organizationProjects.map((item) => {
          const projectActive = project?.id === item.id;
          const settingsActive =
            view === "tools" && settingsProjectId === item.id;
          return (
            <div
              key={item.id}
              className={`project-nav-item ${projectActive ? "active" : ""}`}
            >
              <button
                type="button"
                className="project-nav-link"
                aria-current={
                  projectActive && (view === "loops" || view === "queue")
                    ? "page"
                    : undefined
                }
                onClick={() => onSelectProject(item.id)}
              >
                <IconFolder size={16} />
                <span>{item.name}</span>
                <small>
                  {
                    tasks.filter(
                      (task) =>
                        (task.projectId || starterProjectId) === item.id,
                    ).length
                  }
                </small>
              </button>
              <button
                type="button"
                className={`project-settings-button ${settingsActive ? "selected" : ""}`}
                aria-label={`${item.name} settings`}
                title={`${item.name} settings`}
                aria-current={settingsActive ? "page" : undefined}
                onClick={() => onShowProjectSettings(item.id)}
              >
                <IconSettings size={16} />
              </button>
            </div>
          );
        })}
        {!organizationProjects.length && (
          <p>No projects yet. Open a folder or clone a repository.</p>
        )}
      </div>
    </aside>
  );
}
