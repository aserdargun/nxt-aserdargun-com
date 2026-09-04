import { useQuery } from "@tanstack/react-query";
import { NoteIdSchema } from "@nxt/contracts";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { ApiClientError } from "../api/client";
import { getSession } from "../api/session";
import { vaultClient } from "../api/vault";
import { NotFoundPage } from "./not-found-page";
import { OwnerShell } from "./owner-shell";
import { useTheme } from "./providers";
import { RouteState } from "./route-state";

const LOGOUT_PATH = "/.auth/logout?post_logout_redirect_uri=/login";

const OwnerVaultGate = ({ noteId }: { readonly noteId?: string }): React.JSX.Element => {
  const navigate = useNavigate();
  const { mode, setMode } = useTheme();
  const vault = useQuery({
    queryKey: ["private-vault"],
    queryFn: () => vaultClient.loadCompleteVault()
  });

  if (vault.isPending) return <RouteState state="loading" title="Loading vault" />;
  if (vault.isError) {
    return (
      <RouteState
        state="error"
        title="The vault could not be loaded safely"
        message="The service is temporarily unavailable."
        onRetry={() => { void vault.refetch(); }}
      />
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

  if (session.isPending) return <RouteState state="loading" title="Checking owner access" />;

  if (session.error instanceof ApiClientError) {
    if (session.error.status === 401 && session.error.code === "UNAUTHORIZED") {
      return <Navigate to="/login" replace />;
    }
    if (session.error.status === 403 && session.error.code === "FORBIDDEN") {
      return (
        <RouteState state="forbidden" title={session.error.message}>
          <a className="secondary-link touch-target" href={LOGOUT_PATH}>Sign out</a>
        </RouteState>
      );
    }
  }

  if (session.isError) {
    return (
      <RouteState
        state="error"
        title="NXT could not verify access"
        message="The service is temporarily unavailable."
        onRetry={() => { void session.refetch(); }}
      />
    );
  }

  return <OwnerVaultGate {...(noteId === undefined ? {} : { noteId })} />;
};

export const OwnerRoute = (): React.JSX.Element => {
  const { noteId } = useParams<{ noteId?: string }>();
  if (noteId === undefined) return <OwnerGate />;

  const parsed = NoteIdSchema.safeParse(noteId);
  return parsed.success ? <OwnerGate noteId={parsed.data} /> : <NotFoundPage />;
};
