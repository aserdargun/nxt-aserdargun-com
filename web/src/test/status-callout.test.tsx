import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusCallout } from "../app/status-callout";

afterEach(cleanup);

describe("status callout", () => {
  it("announces errors assertively", () => {
    render(<StatusCallout tone="error">Upload failed</StatusCallout>);

    expect(screen.getByRole("alert")).toHaveTextContent("Upload failed");
    expect(screen.getByRole("alert")).toHaveAttribute("data-tone", "error");
  });

  it("announces non-errors politely and exposes persistence", () => {
    render(<StatusCallout tone="warning" persistent>Connection is slow</StatusCallout>);

    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveAttribute("data-persistent", "true");
  });
});
