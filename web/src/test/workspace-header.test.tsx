import { createRef } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileDestinationNav } from "../app/mobile-destination-nav";
import { WorkspaceHeader, type WorkspaceHeaderProps } from "../app/workspace-header";
import workspaceCss from "../theme/workspace.css?raw";

const createProps = (
  overrides: Partial<WorkspaceHeaderProps> = {}
): WorkspaceHeaderProps => ({
  layout: "desktop",
  compactTablet: false,
  activeDestination: "editor",
  explorerOpen: false,
  explorerTriggerRef: createRef<HTMLButtonElement>(),
  noteTitle: "Plans",
  notePath: "Notes / Plans",
  saveStatus: "Saved",
  attachmentAction: <button className="text-action touch-target" type="button"><span>Add attachment</span></button>,
  publicationAction: <button className="publish-action touch-target" type="button"><span>Publish</span></button>,
  overflowAction: <button type="button">More actions</button>,
  onToggleExplorer: vi.fn(),
  onSelectDestination: vi.fn(),
  onOpenCommandPalette: vi.fn(),
  ...overrides
});

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("style[data-workspace-header-test]").forEach((style) => style.remove());
});

const styleFor = (selector: string, property?: string): CSSStyleDeclaration => {
  const style = document.createElement("style");
  style.dataset.workspaceHeaderTest = "true";
  style.textContent = workspaceCss;
  document.head.append(style);
  const rules = Array.from(style.sheet?.cssRules ?? []);
  const rule = rules.find((candidate) =>
    candidate.type === CSSRule.STYLE_RULE &&
    (candidate as CSSStyleRule).selectorText.split(",").map((value) => value.trim()).includes(selector) &&
    (property === undefined || (candidate as CSSStyleRule).style.getPropertyValue(property) !== "")
  ) as CSSStyleRule | undefined;
  if (rule === undefined) throw new Error(`Missing CSS rule for ${selector}.`);
  return rule.style;
};

describe("workspace header", () => {
  it.each([
    ["Offline draft", "status", "warning"],
    ["Error", "alert", "error"]
  ] as const)("keeps %s recovery feedback persistent with the matching tone", (saveStatus, role, tone) => {
    render(<WorkspaceHeader {...createProps({ saveStatus })} />);

    const copy = screen.getByText("Your local recovery draft remains available.");
    const callout = copy.closest("[data-tone]");
    expect(callout).toHaveAttribute("role", role);
    expect(callout).toHaveAttribute("data-tone", tone);
    expect(callout).toHaveAttribute("data-persistent", "true");
  });

  it("fits the normal mobile status slot and two 44px actions at a 320px viewport", () => {
    const { container } = render(<WorkspaceHeader {...createProps({ layout: "mobile", saveStatus: "Offline draft" })} />);
    container.style.width = "320px";

    const contextualRow = container.querySelector(".workspace-contextual-row");
    const recovery = container.querySelector(".workspace-recovery-callout");
    expect(container).toHaveStyle({ width: "320px" });
    expect(contextualRow?.firstElementChild).toBe(recovery);
    expect(screen.getByText("Your local recovery draft remains available.")).toBeVisible();
    expect(within(screen.getByRole("banner")).queryByLabelText("Save status")).not.toBeInTheDocument();
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Add attachment" })).toBeVisible();
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Publish" })).toBeVisible();

    const rowStyle = styleFor(".workspace-contextual-row", "grid-template-columns");
    expect(rowStyle.getPropertyValue("grid-template-columns").trim()).toBe("minmax(0, 1fr) 44px 44px");
    expect(rowStyle.getPropertyValue("padding").trim()).toBe("2px 8px");
    expect(rowStyle.getPropertyValue("border-top").trim()).toBe("0px");
    expect(rowStyle.getPropertyValue("box-shadow")).toContain("inset");
    expect(rowStyle.getPropertyValue("box-shadow")).toContain("var(--border)");
    for (const selector of [".workspace-contextual-row .text-action", ".workspace-contextual-row .publish-action"]) {
      const actionStyle = styleFor(selector);
      expect(actionStyle.getPropertyValue("min-width").trim()).toBe("44px");
      expect(actionStyle.getPropertyValue("min-height").trim()).toBe("44px");
    }
    expect(styleFor(".workspace-contextual-row .text-action > span").getPropertyValue("position").trim()).toBe("absolute");
    expect(styleFor(".workspace-contextual-row .publish-action > span").getPropertyValue("position").trim()).toBe("absolute");
    const recoveryStyle = styleFor(".workspace-recovery-callout");
    expect(recoveryStyle.getPropertyValue("position").trim()).toBe("static");
    expect(recoveryStyle.getPropertyValue("pointer-events").trim()).toBe("none");
    expect(recoveryStyle.getPropertyValue("z-index").trim()).toBe("auto");
    const compactRecoveryStyle = styleFor(".workspace-contextual-row .workspace-recovery-callout");
    expect(compactRecoveryStyle.getPropertyValue("width").trim()).toBe("auto");
    expect(compactRecoveryStyle.getPropertyValue("max-width").trim()).toBe("100%");
    expect(compactRecoveryStyle.getPropertyValue("height").trim()).toBe("44px");
    expect(styleFor(".workspace-contextual-row .workspace-recovery-callout .status-callout").getPropertyValue("font-size").trim()).toBe("12px");
    expect(styleFor('.owner-shell[data-layout="mobile"] .workspace-header').getPropertyValue("grid-template-rows").trim()).toBe("52px 48px");
  });

  it("keeps desktop commands and status visible without redundant destination navigation", () => {
    render(<WorkspaceHeader {...createProps()} />);

    expect(screen.getByRole("button", { name: "Open commands" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Desktop destinations" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Save status")).toBeVisible();
  });

  it("renders the desktop path and status in the center between left and right action zones", () => {
    const { container } = render(<WorkspaceHeader {...createProps()} />);

    const left = container.querySelector(".workspace-header-explorer");
    const center = container.querySelector(".workspace-header-center");
    const right = container.querySelector(".workspace-header-actions");
    expect(left).not.toBeNull();
    expect(center).not.toBeNull();
    expect(right).not.toBeNull();
    expect(within(left as HTMLElement).getByText("NXT")).toBeVisible();
    expect(within(left as HTMLElement).getByRole("button", { name: "Open commands" })).toBeVisible();
    expect(within(center as HTMLElement).getByLabelText("Active note path: Notes / Plans")).toBeVisible();
    expect(within(center as HTMLElement).getByLabelText("Save status")).toBeVisible();
    expect(within(right as HTMLElement).getByRole("button", { name: "Add attachment" })).toBeVisible();
    expect(within(right as HTMLElement).getByRole("button", { name: "Publish" })).toBeVisible();
    expect(within(right as HTMLElement).getByRole("button", { name: "More actions" })).toBeVisible();
  });

  it.each(["desktop", "tablet"] as const)("keeps More actions visible in the %s header", (layout) => {
    render(<WorkspaceHeader {...createProps({ layout })} />);

    expect(screen.getByRole("button", { name: "More actions" })).toBeVisible();
    expect(
      styleFor(`.owner-shell[data-layout="${layout}"] .workspace-header-overflow`, "display")
        .getPropertyValue("display")
        .trim()
    ).toBe("inline-flex");
  });

  it("exposes the tablet Files toggle, primary destinations, and direct note actions", async () => {
    const user = userEvent.setup();
    const onToggleExplorer = vi.fn();
    const onSelectDestination = vi.fn();
    const explorerTriggerRef = createRef<HTMLButtonElement>();
    render(
      <WorkspaceHeader
        {...createProps({
          layout: "tablet",
          explorerOpen: true,
          explorerTriggerRef,
          onToggleExplorer,
          onSelectDestination
        })}
      />
    );

    const destinations = screen.getByRole("navigation", { name: "Tablet destinations" });
    for (const name of ["Editor", "Preview", "Info"] as const) {
      expect(within(destinations).getByRole("button", { name })).toBeVisible();
    }
    expect(screen.getByRole("button", { name: "Hide files" })).toBe(explorerTriggerRef.current);
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Hide files" }));
    await user.click(within(destinations).getByRole("button", { name: "Preview" }));
    expect(onToggleExplorer).toHaveBeenCalledTimes(1);
    expect(onSelectDestination).toHaveBeenCalledWith("preview");
  });

  it("renders a two-row mobile header without the note path", () => {
    const { container } = render(<WorkspaceHeader {...createProps({ layout: "mobile" })} />);

    const header = screen.getByRole("banner");
    expect(header).toHaveAttribute("data-layout", "mobile");
    expect(container.querySelectorAll(".workspace-title-row")).toHaveLength(1);
    expect(container.querySelectorAll(".workspace-contextual-row")).toHaveLength(1);
    expect(within(header).getByRole("button", { name: "Show files" })).toBeVisible();
    expect(within(header).getByText("Plans")).toBeVisible();
    expect(within(header).getByRole("button", { name: "More actions" })).toBeVisible();
    expect(within(header).getByLabelText("Save status")).toBeVisible();
    expect(within(header).getByRole("button", { name: "Add attachment" })).toBeVisible();
    expect(within(header).getByRole("button", { name: "Publish" })).toBeVisible();
    expect(within(header).queryByText("Notes / Plans")).not.toBeInTheDocument();
  });
});

describe("mobile destination navigation", () => {
  it("renders four destinations and reports selection through the supplied callback", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<MobileDestinationNav activeDestination="preview" onSelect={onSelect} />);

    const navigation = screen.getByRole("navigation", { name: "Mobile destinations" });
    const buttons = within(navigation).getAllByRole("button");
    expect(buttons).toHaveLength(4);
    for (const name of ["Files", "Editor", "Preview", "Info"] as const) {
      expect(within(navigation).getByRole("button", { name })).toBeVisible();
    }
    expect(within(navigation).getByRole("button", { name: "Preview" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    await user.click(within(navigation).getByRole("button", { name: "Info" }));
    expect(onSelect).toHaveBeenCalledWith("info");
  });
});
