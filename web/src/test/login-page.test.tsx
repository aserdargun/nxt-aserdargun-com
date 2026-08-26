import { ApiErrorSchema, SessionResponseSchema } from "@nxt/contracts";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, ApiContractError, requestJson } from "../api/client";
import { getSession } from "../api/session";
import { AppProviders } from "../app/providers";
import { LoginPage } from "../app/login-page";
import { appRoutes } from "../app/router";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";

const responseJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

const apiError = (
  code: "UNAUTHORIZED" | "FORBIDDEN" | "DRIVE_UNAVAILABLE",
  message: string
): unknown => ({
  error: { code, message, requestId: REQUEST_ID }
});

const renderRoute = (entry: string): ReturnType<typeof createMemoryRouter> => {
  const router = createMemoryRouter(appRoutes, { initialEntries: [entry] });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );
  return router;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("login and application routing", () => {
  it("offers the exact GitHub sign-in path", () => {
    render(<LoginPage />);
    expect(screen.getByRole("link", { name: "Continue with GitHub" })).toHaveAttribute(
      "href",
      "/.auth/login/github?post_login_redirect_uri=/app"
    );
  });

  it("redirects the root entrypoint to the visible login route", async () => {
    const router = renderRoute("/");

    expect(await screen.findByRole("link", { name: "Continue with GitHub" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("renders a proper not-found page for unknown routes", async () => {
    const router = renderRoute("/missing");

    expect(await screen.findByRole("heading", { name: "Not found" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/missing");
  });
});

describe("typed session boundary", () => {
  it("validates a successful session response from the sole private application route", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(responseJson({ user: { userDetails: "owner" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSession()).resolves.toEqual({ user: { userDetails: "owner" } });
    const firstCall = fetchMock.mock.calls.at(0);
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) throw new Error("Session request was not made.");
    const [path, init] = firstCall;
    expect(path).toBe("/api/private/session");
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("same-origin");
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
  });

  it("rejects a malformed successful JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(responseJson({ user: { userDetails: "" } }))
    );

    await expect(getSession()).rejects.toBeInstanceOf(ApiContractError);
  });

  it.each([
    [401, "UNAUTHORIZED", "Authentication is required."],
    [403, "FORBIDDEN", "This account cannot access the vault."],
    [503, "DRIVE_UNAVAILABLE", "The service is temporarily unavailable."]
  ] as const)("maps HTTP %i to a typed %s API error", async (status, code, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(responseJson(apiError(code, message), status))
    );

    let caught: unknown;
    try {
      await getSession();
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiClientError);
    expect(caught).toMatchObject({ status, code, requestId: REQUEST_ID, message });
  });

  it("validates non-success JSON with the shared error schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(responseJson({ error: { code: "FORBIDDEN" } }, 403))
    );

    await expect(
      requestJson("/api/private/session", SessionResponseSchema, ApiErrorSchema)
    ).rejects.toBeInstanceOf(ApiContractError);
  });
});

describe("session-gated owner route", () => {
  it("renders the owner shell only after a valid 200 session", async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      if (input === "/api/private/session") {
        return Promise.resolve(responseJson({ user: { userDetails: "owner" } }));
      }
      if (input === "/api/private/vault?limit=100") {
        return Promise.resolve(responseJson({
          entries: [],
          preferences: { schemaVersion: 1, favorites: [], recent: [], theme: "dark" },
          folders: [],
          treeVersion: "a".repeat(64),
          cursor: null,
          complete: true
        }));
      }
      return Promise.reject(new Error("Unexpected request."));
    });
    vi.stubGlobal(
      "fetch",
      fetchMock
    );
    renderRoute("/app");

    expect(await screen.findByRole("main", { name: "NXT workspace" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/private/vault?limit=100",
      expect.objectContaining({ method: "GET", credentials: "same-origin" })
    );
  });

  it("redirects an unauthorized session to /login", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(responseJson(apiError("UNAUTHORIZED", "Authentication is required."), 401))
    );
    const router = renderRoute("/app");

    expect(await screen.findByRole("link", { name: "Continue with GitHub" })).toBeVisible();
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("shows a wrong-account state with the Azure logout path for 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          responseJson(apiError("FORBIDDEN", "This account cannot access the vault."), 403)
        )
    );
    const router = renderRoute("/app");

    expect(
      await screen.findByRole("heading", { name: "This account cannot access the vault." })
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign out" })).toHaveAttribute(
      "href",
      "/.auth/logout?post_logout_redirect_uri=/login"
    );
    expect(router.state.location.pathname).toBe("/app");
  });

  it("keeps the owner on /app for storage errors without offering sign-out", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          responseJson(
            apiError("DRIVE_UNAVAILABLE", "The service is temporarily unavailable."),
            503
          )
        )
    );
    const router = renderRoute("/app");

    expect(await screen.findByRole("heading", { name: "Error" })).toBeVisible();
    expect(screen.getByText("The service is temporarily unavailable.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Sign out" })).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/app");
  });
});
