import type { ReactNode } from "react";

interface AppShellProps {
  header: ReactNode;
  navigation: ReactNode;
  account: ReactNode;
  systemStatus: ReactNode;
  children: ReactNode;
}

/** The six persistent regions of the desktop workspace. */
export function AppShell({
  header,
  navigation,
  account,
  systemStatus,
  children,
}: AppShellProps) {
  return (
    <div className="desktop-shell">
      {header}
      {navigation}
      <div className="app-main">{children}</div>
      {account}
      {systemStatus}
    </div>
  );
}
