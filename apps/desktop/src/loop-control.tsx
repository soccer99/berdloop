import { ActionIcon, Badge, NumberInput, Tooltip } from "@mantine/core";
import { IconPlayerPause, IconPlayerPlay } from "@tabler/icons-react";
import type { Project } from "@berdloop/core";
import { defaultWorkers, type LoopStatus } from "./ralph-loop";

/**
 * Controls for the system loop in the application header.
 * Pausing stops the loop handing out new work; workers already running keep
 * going, because each one is its own process.
 */
export function LoopBar({
  loop,
  ticketId,
  project,
  busy,
  onWorkersChange,
}: {
  loop: LoopStatus;
  ticketId: string;
  project?: Project;
  /** Worker processes alive right now, counted from the live conversations. */
  busy: number;
  onWorkersChange: (workers: number) => void;
}) {
  const ready = Boolean(project?.path) && (Boolean(ticketId) || loop.running);
  const label = loop.running ? "Pause the loop" : "Start the loop";

  return (
    <div className="loop-bar">
      <span className="loop-bar-label">System loop</span>
      <NumberInput
        size="xs"
        aria-label="Workers"
        title="Workers this project runs at once"
        w={66}
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
      <span className="worker-count-label">workers</span>
      {busy > 0 && (
        <Badge variant="light">
          {busy} {busy === 1 ? "worker" : "workers"}
        </Badge>
      )}
      {project?.path && (
        <span className="loop-bar-note muted">{loop.note}</span>
      )}
      <Tooltip
        label={ready ? label : "Link a project folder and queue a ticket"}
      >
        <ActionIcon
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
