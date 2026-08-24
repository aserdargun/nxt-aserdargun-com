import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams, type RouteObject } from "react-router-dom";
import { ApiClientError } from "../api/client";
import { getSession } from "../api/session";
import { LoginPage } from "./login-page";
import { NotFoundPage } from "./not-found-page";
import { OwnerShell } from "./owner-shell";

const LOGOUT_PATH = "/.auth/logout?post_logout_redirect_uri=/login";

const RouteState = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <div className="route-page">
    <header className="route-header">
      <span className="brand">NXT</span>
    </header>
    <main className="route-main">{children}</main>
  </div>
);

const OwnerGate = ({ noteId }: { readonly noteId?: string }): React.JSX.Element => {
  const session = useQuery({
    queryKey: ["private-session"],
    queryFn: getSession
  });

  if (session.isPending) {
    return (
      <RouteState>
        <div role="status" aria-label="Loading session" aria-busy="true" />
      </RouteState>
    );
  }

  if (session.error instanceof ApiClientError) {
    if (session.error.status === 401 && session.error.code === "UNAUTHORIZED") {
      return <Navigate to="/login" replace />;
    }
    if (session.error.status === 403 && session.error.code === "FORBIDDEN") {
      return (
        <RouteState>
          <h1>{session.error.message}</h1>
          <a className="secondary-link touch-target" href={LOGOUT_PATH}>Sign out</a>
        </RouteState>
      );
    }
  }

  if (session.isError) {
    const message =
      session.error instanceof Error
        ? session.error.message
        : "The service is temporarily unavailable.";
    return (
      <RouteState>
        <h1>Error</h1>
        <p>{message}</p>
      </RouteState>
    );
  }

  return noteId === undefined ? <OwnerShell /> : <OwnerShell noteId={noteId} />;
};

const OwnerNoteGate = (): React.JSX.Element => {
  const { noteId } = useParams<{ noteId: string }>();
  return noteId === undefined ? <NotFoundPage /> : <OwnerGate noteId={noteId} />;
};

export const appRoutes: RouteObject[] = [
  { path: "/", element: <Navigate to="/login" replace /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/app/notes/:noteId", element: <OwnerNoteGate /> },
  { path: "/app/*", element: <OwnerGate /> },
  { path: "*", element: <NotFoundPage /> }
];
