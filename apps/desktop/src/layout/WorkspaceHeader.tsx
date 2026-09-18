import { Button } from "@mantine/core";
import { Logo } from "@berdloop/ui";
import type { Project } from "@berdloop/core";
import { LoopBar } from "../loop-control";
import type { LoopStatus } from "../ralph-loop";
import type { WorkspaceView } from "./types";

interface WorkspaceHeaderProps {
  organizationName: string;
  projectName?: string;
  view: WorkspaceView;
  selectedTaskId: string;
  navigationOpen: boolean;
  onToggleNavigation: () => void;
  loop: LoopStatus;
  loopTicketId: string;
  loopProject?: Project;
  onWorkersChange: (workers: number) => void;
}

export function WorkspaceHeader({
  organizationName,
  projectName,
  view,
  selectedTaskId,
  navigationOpen,
  onToggleNavigation,
  loop,
  loopTicketId,
  loopProject,
  onWorkersChange,
}: WorkspaceHeaderProps) {
  const isQueue = view === "loops" || view === "queue";
  const currentPage =
    view === "organization"
      ? "Overview"
      : isQueue
        ? selectedTaskId
          ? "Agent tasks"
          : "Tickets"
        : "Settings";

  return (
    <header className="app-header">
      <div className="header-brand">
        <Logo />
        <Button
          className="mobile-menu-button"
          variant="default"
          size="xs"
          aria-expanded={navigationOpen}
          aria-controls="workspace-sidebar"
          onClick={onToggleNavigation}
        >
          {navigationOpen ? "Close menu" : "Workspace menu"}
        </Button>
      </div>
      <nav className="header-path" aria-label="Breadcrumbs">
        <span className="breadcrumb">
          {organizationName}
          {(isQueue || view === "tools") && projectName
            ? ` / ${projectName}`
            : ""}{" "}
          /
        </span>{" "}
        {currentPage}
      </nav>
      <div className="header-controls">
        <LoopBar
          loop={loop}
          ticketId={loopTicketId}
          project={loopProject}
          onWorkersChange={onWorkersChange}
        />
      </div>
    </header>
  );
}
