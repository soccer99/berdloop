import { ActionIcon, NumberInput, Tooltip } from "@mantine/core";
import { IconPlayerPause, IconPlayerPlay } from "@tabler/icons-react";
import type { Project } from "@berdloop/core";
import { defaultWorkers, type LoopStatus } from "./ralph-loop";

/**
 * The system loop control in the application header.
 *
 * Controls only: how many workers, and start or pause. What the loop is doing
 * is status, and status lives in the footer, so this block never changes size.
 * Pausing stops the loop handing out new work; workers already running keep
 * going, because each one is its own process.
 */
export function LoopBar({
  loop,
  ticketId,
  project,
  onWorkersChange,
}: {
  loop: LoopStatus;
  ticketId: string;
  project?: Project;
  onWorkersChange: (workers: number) => void;
}) {
  const ready = Boolean(project?.path) && (Boolean(ticketId) || loop.running);
  const label = loop.running ? "Pause the loop" : "Start the loop";

  return (
    <div className="loop-bar">
      <div className="loop-bar-workers">
        <NumberInput
          variant="unstyled"
          size="xs"
          aria-label="Workers"
          title="Workers this project runs at once"
          w={52}
          min={1}
          max={8}
          clampBehavior="strict"
          allowDecimal={false}
          disabled={!project}
          value={project?.workers ?? defaultWorkers}
          onChange={(value) =>
            typeof value === "number" && onWorkersChange(value)
          }
        />
        <span className="loop-bar-unit">workers</span>
      </div>
      <Tooltip
        label={ready ? label : "Link a project folder and queue a ticket"}
      >
        <ActionIcon
          className="loop-bar-run"
          aria-label={label}
          size="lg"
          variant="filled"
          color={loop.running ? "yellow" : "lime"}
          data-disabled={!ready || undefined}
          aria-disabled={!ready}
          onClick={(event) => {
            if (!ready) {
              event.preventDefault();
            } else if (loop.running) {
              loop.pause();
            } else {
              loop.start();
            }
          }}
        >
          {loop.running ? (
            <IconPlayerPause size={18} />
          ) : (
            <IconPlayerPlay size={18} />
          )}
        </ActionIcon>
      </Tooltip>
    </div>
  );
}
