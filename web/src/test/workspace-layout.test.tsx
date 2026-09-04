import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getWorkspaceViewport,
  useWorkspaceViewport,
  type WorkspaceViewport
} from "../app/workspace-layout";

interface MatchMediaCall {
  readonly query: string;
  readonly addEventListener: ReturnType<typeof vi.fn<MatchMediaListenerMethod>>;
  readonly removeEventListener: ReturnType<typeof vi.fn<MatchMediaListenerMethod>>;
}

type MatchMediaListenerMethod = (
  event: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions
) => void;

const stubViewportWidth = (width: number): readonly MatchMediaCall[] => {
  const calls: MatchMediaCall[] = [];
  vi.stubGlobal("matchMedia", vi.fn((query: string): MediaQueryList => {
    const constraints = Array.from(
      query.matchAll(/\((min|max)-width:\s*(\d+)px\)/gu),
      ([, boundary, value]) => ({ boundary, value: Number(value) })
    );
    const call: MatchMediaCall = {
      query,
      addEventListener: vi.fn<MatchMediaListenerMethod>(),
      removeEventListener: vi.fn<MatchMediaListenerMethod>()
    };
    calls.push(call);
    return {
      matches: constraints.every(({ boundary, value }) =>
        boundary === "min" ? width >= value : width <= value
      ),
      media: query,
      onchange: null,
      addEventListener: call.addEventListener,
      removeEventListener: call.removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    };
  }));
  return calls;
};

const ViewportHarness = (): React.JSX.Element => {
  const viewport = useWorkspaceViewport();
  return <output data-testid="viewport">{JSON.stringify(viewport)}</output>;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("workspace viewport", () => {
  it.each([
    [390, { layout: "mobile", compactTablet: false }],
    [768, { layout: "tablet", compactTablet: true }],
    [1024, { layout: "tablet", compactTablet: false }],
    [1200, { layout: "desktop", compactTablet: false }],
    [1505, { layout: "desktop", compactTablet: false }]
  ] as const)("classifies %ipx as the expected workspace viewport", (width, expected) => {
    stubViewportWidth(width);

    expect(getWorkspaceViewport()).toEqual(expected);
  });

  it("cleans up each responsive query with the callback registered by the hook", () => {
    const calls = stubViewportWidth(1024);
    const view = render(<ViewportHarness />);

    expect(JSON.parse(screen.getByTestId("viewport").textContent ?? "{}") as WorkspaceViewport).toEqual({
      layout: "tablet",
      compactTablet: false
    });
    const registered = calls.filter((call) => call.addEventListener.mock.calls.length > 0);
    expect(registered).toHaveLength(3);
    view.unmount();

    for (const call of registered) {
      expect(call.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
      const registration = call.addEventListener.mock.calls[0];
      if (registration === undefined) throw new Error("Responsive query listener was not registered.");
      const callback = registration[1];
      expect(call.removeEventListener).toHaveBeenCalledWith("change", callback);
    }
  });
});
