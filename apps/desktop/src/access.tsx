import { useState } from "react";
import { Badge, Button, Modal } from "@mantine/core";
import {
  IconArrowRight,
  IconCloud,
  IconDeviceDesktop,
} from "@tabler/icons-react";
import { Logo } from "@berdloop/ui";
import type { AccountSession } from "@berdloop/core";

export interface CollaborationTarget {
  kind: "organization" | "project";
  organizationId: string;
  organizationName: string;
  projectId?: string;
  projectName?: string;
}

/** A WorkOS session is required before any shared action can be enabled. */
export function canCollaborate(session: AccountSession | null): boolean {
  return Boolean(session?.userId && session.accessToken);
}

export function WorkOSRequiredModal({
  target,
  onClose,
}: {
  target: CollaborationTarget | "welcome" | null;
  onClose: () => void;
}) {
  const title =
    target === "welcome" || !target
      ? "Sign up or sign in with WorkOS"
      : target.kind === "organization"
        ? `Collaborate in ${target.organizationName}`
        : `Share ${target.projectName}`;
  return (
    <Modal opened={target !== null} onClose={onClose} title={title} centered>
      <div className="workos-modal">
        <IconCloud size={27} />
        <p>
          Collaboration requires a WorkOS account. Local organizations and
          projects remain available without signing in.
        </p>
        {target && target !== "welcome" && (
          <p className="workos-target">
            {target.organizationName}
            {target.kind === "project" ? ` / ${target.projectName}` : ""}
          </p>
        )}
        <Badge variant="outline" color="gray">
          WorkOS connection pending
        </Badge>
        <p className="access-muted">
          Sign-up, sign-in, and shared workspaces are coming soon. Nothing here
          is shared yet.
        </p>
        <Button fullWidth disabled>
          Continue with WorkOS
        </Button>
      </div>
    </Modal>
  );
}

export function AccessScreen({ onLocalOnly }: { onLocalOnly: () => void }) {
  const [showWorkOS, setShowWorkOS] = useState(false);
  return (
    <div className="access-screen">
      <div className="access-card">
        <Logo />
        <p className="app-eyebrow">WELCOME TO BERDLOOP</p>
        <h1>Choose how to start.</h1>
        <p className="access-muted">
          Use organizations and projects on this device without an account.
          WorkOS sign-up and sign-in will be required for collaboration.
        </p>
        <div className="access-options">
          <button className="access-option" onClick={onLocalOnly}>
            <IconDeviceDesktop size={23} />
            <span>
              <strong>Local only</strong>
              <small>
                Keep your organizations, projects, and tasks on this device.
              </small>
            </span>
            <IconArrowRight size={17} />
          </button>
          <button className="access-option" onClick={() => setShowWorkOS(true)}>
            <IconCloud size={23} />
            <span>
              <strong>Sign up or sign in</strong>
              <small>
                WorkOS account required for collaboration. Coming soon.
              </small>
            </span>
            <IconArrowRight size={17} />
          </button>
        </div>
      </div>
      <WorkOSRequiredModal
        target={showWorkOS ? "welcome" : null}
        onClose={() => setShowWorkOS(false)}
      />
    </div>
  );
}
