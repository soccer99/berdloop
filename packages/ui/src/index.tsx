import type { ReactNode } from "react";
import { MantineProvider, createTheme } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./styles.css";
export const theme = createTheme({
  primaryColor: "lime",
  primaryShade: 4,
  autoContrast: true,
  defaultRadius: "md",
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: {
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: "600",
  },
  colors: {
    dark: [
      "#dce4df",
      "#b5c0b8",
      "#88968c",
      "#657168",
      "#354239",
      "#28332b",
      "#1b251e",
      "#151c17",
      "#111713",
      "#0d120f",
    ],
    lime: [
      "#f5fce7",
      "#e9f8ca",
      "#d8f3a1",
      "#c6ec79",
      "#b8e66c",
      "#a3cf58",
      "#86ac45",
      "#688638",
      "#50682e",
      "#394b23",
    ],
  },
});
export function BerdloopProvider({ children }: { children: ReactNode }) {
  return (
    <MantineProvider theme={theme} forceColorScheme="dark">
      <Notifications position="bottom-right" />
      {children}
    </MantineProvider>
  );
}
export function Logo() {
  return (
    <span className="brand">
      <svg
        className="brand-mark"
        width="30"
        height="30"
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden="true"
      >
        <g
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path
            className="bird-body"
            d="M11 42h8l8-17 7-8h10l5 5 8 3-8 3-2 10c-1 8-7 13-16 13H21l-9-5-5-9"
          />
          <path className="bird-wing" d="m20 40 11-12 9 7-10 10" />
          <path className="bird-tail" d="m11 42-6-10m7 14-7 3" />
          <path className="bird-feet" d="m27 51-3 5m11-5 3 5" />
        </g>
        <circle cx="43" cy="23" r="1.7" fill="currentColor" />
      </svg>
      berdloop<span className="brand-dot">.</span>
    </span>
  );
}
export function LoopRail({ active = 1 }: { active?: number }) {
  return (
    <ol className="loop-rail" aria-label="Loop stages">
      {["Branch", "Engineer", "Review", "Deploy"].map((stage, index) => (
        <li
          key={stage}
          className={
            index === active ? "active" : index < active ? "complete" : ""
          }
        >
          <span>{String(index + 1).padStart(2, "0")}</span>
          {stage}
        </li>
      ))}
    </ol>
  );
}
