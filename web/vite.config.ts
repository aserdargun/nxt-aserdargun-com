import { defineConfig } from "vitest/config";

const VISUAL_QA_HOST = "127.0.0.1";
const VISUAL_QA_PORT = 5173;
const VISUAL_QA_HOST_HEADER = `${VISUAL_QA_HOST}:${VISUAL_QA_PORT}`;
const LOOPBACK_CLIENTS = new Set([VISUAL_QA_HOST, "::1", `::ffff:${VISUAL_QA_HOST}`]);

const assertVisualQaPreviewBinding = (preview: {
  readonly host?: string | boolean;
  readonly port?: number;
  readonly strictPort?: boolean;
}): void => {
  if (
    preview.host !== VISUAL_QA_HOST ||
    preview.port !== VISUAL_QA_PORT ||
    preview.strictPort !== true
  ) {
    throw new Error(
      "NXT visual QA requires preview binding 127.0.0.1:5173 with strictPort enabled."
    );
  }
};

const manualChunks = (id: string): string | undefined => {
  if (!id.includes("node_modules")) return undefined;
  if (id.includes("lucide-react")) return "icons";
  if (id.includes("zod") || id.includes("@nxt/contracts")) return "contracts";
  if (
    id.includes("@radix-ui") ||
    id.includes("@tanstack") ||
    id.includes("react-router") ||
    id.includes("/react/") ||
    id.includes("/react-dom/") ||
    id.includes("/scheduler/")
  ) return "framework";
  if (id.includes("minisearch") || id.includes("idb")) return "storage";
  return undefined;
};

export default defineConfig({
  preview: {
    host: VISUAL_QA_HOST,
    port: VISUAL_QA_PORT,
    strictPort: true
  },
  build: {
    target: "es2022",
    cssCodeSplit: true,
    sourcemap: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        manualChunks
      }
    }
  },
  plugins: [
    {
      name: "nxt-local-visual-session",
      configurePreviewServer(server) {
        if (process.env.NXT_VISUAL_QA_SESSION !== "1") return;
        assertVisualQaPreviewBinding(server.config.preview);
        server.middlewares.use((request, response, next) => {
          if (request.method !== "GET" || request.url !== "/api/private/session") {
            next();
            return;
          }
          const remoteAddress = request.socket.remoteAddress;
          if (
            remoteAddress === undefined ||
            !LOOPBACK_CLIENTS.has(remoteAddress) ||
            request.headers.host !== VISUAL_QA_HOST_HEADER
          ) {
            response.statusCode = 403;
            response.setHeader("content-type", "text/plain; charset=utf-8");
            response.end("Forbidden");
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
