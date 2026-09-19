import type { ReactNode } from "react";
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
  /** Go up to the organization overview. */
  onOpenOrganization: () => void;
  /** Go up to the project's tickets. Left out when no project is open. */
  onOpenProject?: () => void;
  /** Go up to the ticket list, from a task inside it. */
  onOpenTickets?: () => void;
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
  onOpenOrganization,
  onOpenProject,
  onOpenTickets,
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
        <Crumb onClick={onOpenOrganization}>{organizationName}</Crumb>
        {(isQueue || view === "tools") && projectName && (
          <Crumb onClick={onOpenProject}>{projectName}</Crumb>
        )}
        {/* A task sits inside the ticket list, so the list is a step of its own. */}
        {isQueue && selectedTaskId && (
          <Crumb onClick={onOpenTickets}>Tickets</Crumb>
        )}
        <span aria-current="page">{currentPage}</span>
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

/**
 * One step of the trail. Every step but the last goes somewhere, so a person
 * can walk back up without the sidebar.
 */
function Crumb({
  onClick,
  children,
}: {
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <button type="button" className="breadcrumb" onClick={onClick}>
        {children}
      </button>
      <span className="breadcrumb-separator">/</span>
    </>
  );
}
