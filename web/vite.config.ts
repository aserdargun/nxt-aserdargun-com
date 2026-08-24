import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "nxt-local-visual-session",
      configurePreviewServer(server) {
        if (process.env.NXT_VISUAL_QA_SESSION !== "1") return;
        server.middlewares.use((request, response, next) => {
          if (request.method !== "GET" || request.url !== "/api/private/session") {
            next();
            return;
          }
          response.statusCode = 200;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ user: { userDetails: "visual-qa-owner" } }));
        });
      }
    }
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true
  }
});
