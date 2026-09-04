import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { AppProviders } from "./app/providers";
import { appRoutes } from "./app/router";
import "./theme/gruvbox.css";
import "./theme/layout.css";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("NXT root element is missing.");
}

const bootShell = document.getElementById("nxt-boot-shell");
if (bootShell !== null) {
  bootShell.setAttribute("data-nxt-boot", "dismissing");
  // Defer removal one frame so the dismissing state can play a fade-out
  // transition (CSS hooks into data-nxt-boot="dismissing").
  window.requestAnimationFrame(() => {
    bootShell.remove();
  });
}

const router = createBrowserRouter(appRoutes);

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>
);
