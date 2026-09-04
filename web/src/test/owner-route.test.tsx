import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../api/client";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  loadCompleteVault: vi.fn()
}));

vi.mock("../api/session", () => ({ getSession: mocks.getSession }));
vi.mock("../api/vault", () => ({
  vaultClient: { loadCompleteVault: mocks.loadCompleteVault }
}));

import { OwnerRoute } from "../app/owner-route";
import { LoginPage } from "../app/login-page";
import { ThemeProvider } from "../app/providers";

const VAULT = {
  entries: [],
  folders: [],
  preferences: { schemaVersion: 1, favorites: [], recent: [], theme: "dark" as const },
  treeVersion: "a".repeat(64)
};

const renderOwnerRoute = (): void => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/app"]}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route path="/app" element={<OwnerRoute />} />
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </QueryClientProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
};

afterEach(() => {
  cleanup();
  mocks.getSession.mockReset();
  mocks.loadCompleteVault.mockReset();
});

describe("OwnerRoute", () => {
  it("shows session and vault pending copy", async () => {
    let resolveSession: ((value: { user: { userDetails: string } }) => void) | undefined;
    mocks.getSession.mockImplementation(() => new Promise((resolve) => { resolveSession = resolve; }));
    renderOwnerRoute();
    expect(await screen.findByRole("status", { name: "Checking owner access" })).toHaveAttribute("aria-busy", "true");

    resolveSession?.({ user: { userDetails: "owner" } });
    mocks.loadCompleteVault.mockImplementation(() => new Promise(() => undefined));
    expect(await screen.findByRole("status", { name: "Loading vault" })).toHaveAttribute("aria-busy", "true");
  });

  it("retries a failed session once and renders the owner shell", async () => {
    mocks.getSession
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ user: { userDetails: "owner" } });
    mocks.loadCompleteVault.mockResolvedValue(VAULT);
    const user = userEvent.setup();
    renderOwnerRoute();

    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocks.getSession).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("main", { name: "NXT workspace" })).toBeVisible();
  });

  it("retries a failed vault load once and renders the owner shell", async () => {
    mocks.getSession.mockResolvedValue({ user: { userDetails: "owner" } });
    mocks.loadCompleteVault
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(VAULT);
    const user = userEvent.setup();
    renderOwnerRoute();

    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocks.loadCompleteVault).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("main", { name: "NXT workspace" })).toBeVisible();
  });

  it("preserves the 401 redirect and 403 sign-out state", async () => {
    mocks.getSession.mockRejectedValueOnce(new ApiClientError(401, { error: { code: "UNAUTHORIZED", message: "Authentication is required.", requestId: "request-id" } }));
    renderOwnerRoute();
    expect(await screen.findByRole("link", { name: "Continue with GitHub" })).toBeVisible();
    cleanup();

    mocks.getSession.mockReset();
    mocks.getSession.mockRejectedValueOnce(new ApiClientError(403, { error: { code: "FORBIDDEN", message: "This account cannot access the vault.", requestId: "request-id" } }));
    renderOwnerRoute();
    expect(await screen.findByRole("heading", { name: "This account cannot access the vault." })).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign out" })).toHaveAttribute("href", "/.auth/logout?post_logout_redirect_uri=/login");
  });
});
