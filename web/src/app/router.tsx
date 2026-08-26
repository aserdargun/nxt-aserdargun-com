import { useQuery } from "@tanstack/react-query";
import { NoteIdSchema } from "@nxt/contracts";
import { Navigate, useNavigate, useParams, type RouteObject } from "react-router-dom";
import { ApiClientError } from "../api/client";
import { getSession } from "../api/session";
import { vaultClient } from "../api/vault";
import { LoginPage } from "./login-page";
import { NotFoundPage } from "./not-found-page";
import { OwnerShell } from "./owner-shell";
import { useTheme } from "./providers";

const LOGOUT_PATH = "/.auth/logout?post_logout_redirect_uri=/login";

const RouteState = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <div className="route-page">
    <header className="route-header">
      <span className="brand">NXT</span>
    </header>
    <main className="route-main">{children}</main>
  </div>
);

const OwnerVaultGate = ({ noteId }: { readonly noteId?: string }): React.JSX.Element => {
  const navigate = useNavigate();
  const { mode, setMode } = useTheme();
  const vault = useQuery({
    queryKey: ["private-vault"],
    queryFn: () => vaultClient.loadCompleteVault()
  });

  if (vault.isPending) {
    return (
      <RouteState>
        <div role="status" aria-label="Loading vault" aria-busy="true" />
      </RouteState>
    );
  }
  if (vault.isError) {
    return (
      <RouteState>
        <h1>Error</h1>
        <p>The vault could not be loaded safely.</p>
      </RouteState>
    );
  }

  if (noteId !== undefined && !vault.data.entries.some((entry) => entry.id === noteId)) {
    return <NotFoundPage />;
  }
  if (noteId === undefined) {
    const entryIds = new Set(vault.data.entries.map((entry) => entry.id));
    const firstRecent = vault.data.preferences.recent.find((id) => entryIds.has(id));
    const first = firstRecent ?? vault.data.entries[0]?.id;
    if (first !== undefined) return <Navigate to={`/app/notes/${first}`} replace />;
  }

  return (
    <OwnerShell
      {...(noteId === undefined ? {} : { noteId })}
      vault={vault.data}
      vaultApi={vaultClient}
      onNavigateNote={(id) => {
        void navigate(`/app/notes/${id}`);
      }}
      onRefreshVault={async () => {
        await vault.refetch();
      }}
      onToggleTheme={() => setMode(mode === "dark" ? "light" : "dark")}
      onSignOut={() => window.location.assign(LOGOUT_PATH)}
    />
  );
};

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

  return <OwnerVaultGate {...(noteId === undefined ? {} : { noteId })} />;
};

const OwnerNoteGate = (): React.JSX.Element => {
  const { noteId } = useParams<{ noteId: string }>();
  const parsed = NoteIdSchema.safeParse(noteId);
  return parsed.success ? <OwnerGate noteId={parsed.data} /> : <NotFoundPage />;
};

export const appRoutes: RouteObject[] = [
  { path: "/", element: <Navigate to="/login" replace /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/app/notes/:noteId", element: <OwnerNoteGate /> },
  { path: "/app/*", element: <OwnerGate /> },
  { path: "*", element: <NotFoundPage /> }
];
