import type { CSSProperties, ReactNode } from "react";

export interface StatusCalloutProps {
  readonly tone: "info" | "warning" | "error";
  readonly children: ReactNode;
  readonly persistent?: boolean;
}

const toneStyles: Readonly<Record<StatusCalloutProps["tone"], CSSProperties>> = {
  info: { color: "var(--text)" },
  warning: { borderColor: "var(--warning-border)", color: "var(--text-warning)" },
  error: { borderColor: "var(--danger-border)", color: "var(--text-danger)" }
};

export const StatusCallout = ({ tone, children, persistent = false }: StatusCalloutProps): React.JSX.Element => (
  <div
    className="status-callout"
    data-tone={tone}
    data-persistent={persistent ? "true" : "false"}
    role={tone === "error" ? "alert" : "status"}
    aria-live={tone === "error" ? undefined : "polite"}
    style={toneStyles[tone]}
  >
    {children}
  </div>
);
