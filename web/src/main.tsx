import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { AppProviders } from "./app/providers";
import { appRoutes } from "./app/router";
import "./theme/gruvbox.css";
import "./theme/layout.css";
import "./theme/workspace.css";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("NXT root element is missing.");
}

const router = createBrowserRouter(appRoutes);

createRoot(rootElement).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>
);
