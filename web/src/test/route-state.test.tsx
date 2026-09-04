import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RouteState } from "../app/route-state";

describe("RouteState", () => {
  it("shows visible loading copy and retries an error once", async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    const view = render(<RouteState state="loading" title="Loading vault" />);
    expect(screen.getByRole("status", { name: "Loading vault" })).toHaveAttribute("aria-busy", "true");
    view.rerender(
      <RouteState
        state="error"
        title="NXT could not verify access"
        message="The service is temporarily unavailable."
        onRetry={retry}
      />
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("announces error and forbidden titles as alerts", () => {
    const { rerender, container } = render(
      <RouteState state="error" title="The vault could not be loaded safely" />
    );
    expect(screen.getByRole("heading", { name: "The vault could not be loaded safely" })).toBeVisible();
    expect(within(container).getByRole("alert")).toHaveTextContent("The vault could not be loaded safely");

    rerender(<RouteState state="forbidden" title="This account cannot access the vault." />);
    expect(screen.getByRole("heading", { name: "This account cannot access the vault." })).toBeVisible();
    expect(within(container).getByRole("alert")).toHaveTextContent("This account cannot access the vault.");
  });
});
