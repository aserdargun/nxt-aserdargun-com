export interface RouteStateProps {
  readonly state: "loading" | "error" | "forbidden";
  readonly title: string;
  readonly message?: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly children?: React.ReactNode;
}

export const RouteState = ({
  state,
  title,
  message,
  onRetry,
  retryLabel = "Try again",
  children
}: RouteStateProps): React.JSX.Element => (
  <div className="route-page">
    <header className="route-header"><span className="brand">NXT</span></header>
    <main className="route-main route-state-main">
      {state === "loading" ? (
        <div className="route-progress" role="status" aria-label={title} aria-busy="true">
          <span>{title}</span>
          <span className="route-progress-line" aria-hidden />
        </div>
      ) : (
        <div className="route-state-copy" role="alert">
          <h1>{title}</h1>
          {message === undefined ? null : <p>{message}</p>}
          {onRetry === undefined ? null : (
            <button className="primary-action touch-target" type="button" onClick={onRetry}>
              {retryLabel}
            </button>
          )}
          {children}
        </div>
      )}
    </main>
  </div>
);
