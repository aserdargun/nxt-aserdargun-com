import { lazy, Suspense } from "react";
import { Navigate, useParams, type RouteObject } from "react-router-dom";
import { useNoIndex } from "../publication/noindex";
import { LoginPage } from "./login-page";
import { NotFoundPage } from "./not-found-page";

const PublicNotePage = lazy(async () => {
  const module = await import("../publication/public-note-page");
  return { default: module.PublicNotePage };
});

const OwnerRoute = lazy(async () => {
  const module = await import("./owner-route");
  return { default: module.OwnerRoute };
});

const LazyOwnerRoute = (): React.JSX.Element => (
  <Suspense fallback={<main className="route-main"><div role="status" aria-label="Loading workspace" /></main>}>
    <OwnerRoute />
  </Suspense>
);

const PublicNoteRoute = (): React.JSX.Element => {
  useNoIndex();
  const { publicId = "" } = useParams<{ publicId: string }>();
  return (
    <Suspense fallback={<main className="public-note-page"><div role="status" aria-label="Loading published note" /></main>}>
      <PublicNotePage publicId={publicId} />
    </Suspense>
  );
};

export const appRoutes: RouteObject[] = [
  { path: "/", element: <Navigate to="/login" replace /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/p/:publicId", element: <PublicNoteRoute /> },
  { path: "/app/notes/:noteId", element: <LazyOwnerRoute /> },
  { path: "/app/*", element: <LazyOwnerRoute /> },
  { path: "*", element: <NotFoundPage /> }
];
