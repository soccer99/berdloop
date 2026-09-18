import { Menu } from "@mantine/core";
import { IconChevronDown, IconUsers } from "@tabler/icons-react";

export function AccountMenu({ onOpenAccount }: { onOpenAccount: () => void }) {
  return (
    <div className="account-footer">
      <Menu position="top-start" withinPortal>
        <Menu.Target>
          <button className="account-button" type="button">
            <IconUsers size={17} />
            <span>
              <strong>Account</strong>
              <small>Local-only access</small>
            </span>
            <IconChevronDown size={14} className="account-chevron" />
          </button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={onOpenAccount}>Account options</Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}

export function SystemStatus({
  runtime,
  loopNote,
  busyWorkers,
}: {
  runtime: string;
  /** What the system loop is doing. Status belongs here, not in the header. */
  loopNote?: string;
  /** Worker processes alive right now. */
  busyWorkers?: number;
}) {
  return (
    <footer className="system-footer">
      <span className="connection-dot" />
      <span>System · {runtime}</span>
      <span className="system-footer-loop">
        {busyWorkers ? (
          <span className="system-footer-workers">
            {busyWorkers} {busyWorkers === 1 ? "worker" : "workers"} running
          </span>
        ) : null}
        {loopNote ? <span title={loopNote}>{loopNote}</span> : null}
      </span>
    </footer>
  );
}
