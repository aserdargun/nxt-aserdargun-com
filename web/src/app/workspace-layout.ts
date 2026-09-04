import { useSyncExternalStore } from "react";

export type WorkspaceLayout = "mobile" | "tablet" | "desktop";

export interface WorkspaceViewport {
  readonly layout: WorkspaceLayout;
  readonly compactTablet: boolean;
}

export const MOBILE_MAX = 767;
export const COMPACT_TABLET_MAX = 899;
export const DESKTOP_MIN = 1200;

const desktopViewport: WorkspaceViewport = { layout: "desktop", compactTablet: false };
let cachedViewport = desktopViewport;

const cacheViewport = (viewport: WorkspaceViewport): WorkspaceViewport => {
  if (
    cachedViewport.layout === viewport.layout &&
    cachedViewport.compactTablet === viewport.compactTablet
  ) return cachedViewport;
  cachedViewport = viewport;
  return cachedViewport;
};

const snapshot = (): WorkspaceViewport => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return desktopViewport;
  if (window.matchMedia(`(max-width: ${MOBILE_MAX}px)`).matches) {
    return cacheViewport({ layout: "mobile", compactTablet: false });
  }
  if (window.matchMedia(`(min-width: ${DESKTOP_MIN}px)`).matches) {
    return desktopViewport;
  }
  return cacheViewport({
    layout: "tablet",
    compactTablet: window.matchMedia(`(max-width: ${COMPACT_TABLET_MAX}px)`).matches
  });
};

const subscribe = (onChange: () => void): (() => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mobile = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`);
  const compactTablet = window.matchMedia(`(max-width: ${COMPACT_TABLET_MAX}px)`);
  const desktop = window.matchMedia(`(min-width: ${DESKTOP_MIN}px)`);
  mobile.addEventListener("change", onChange);
  compactTablet.addEventListener("change", onChange);
  desktop.addEventListener("change", onChange);
  return () => {
    mobile.removeEventListener("change", onChange);
    compactTablet.removeEventListener("change", onChange);
    desktop.removeEventListener("change", onChange);
  };
};

export const getWorkspaceViewport = snapshot;

export const useWorkspaceViewport = (): WorkspaceViewport =>
  useSyncExternalStore(subscribe, snapshot, () => desktopViewport);
