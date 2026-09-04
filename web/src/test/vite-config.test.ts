import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, PreviewServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import viteConfig from "../../vite.config";

type PreviewMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void
) => void;

interface RegisteredMiddleware {
  middleware: PreviewMiddleware | undefined;
}

interface ResponseFixture {
  response: ServerResponse;
  readonly headers: Map<string, string>;
  body: string;
  ended: boolean;
}

const config = viteConfig;
const plugins = config.plugins as Plugin[];
const visualSessionPlugin = plugins.find(
  (plugin) => plugin.name === "nxt-local-visual-session"
);

if (visualSessionPlugin === undefined) {
  throw new Error("The local visual-session plugin is missing.");
}

const runPreviewHook = (server: PreviewServer): void => {
  const hook = visualSessionPlugin.configurePreviewServer;
  if (hook === undefined) throw new Error("The visual-session preview hook is missing.");
  const handler = typeof hook === "function" ? hook : hook.handler;
  Reflect.apply(handler, undefined, [server]);
};

const createPreviewFixture = (
  preview: { readonly host: string | boolean; readonly port: number; readonly strictPort: boolean }
): { readonly server: PreviewServer; readonly registered: RegisteredMiddleware } => {
  const registered: RegisteredMiddleware = { middleware: undefined };
  const middlewares = {
    use(middleware: PreviewMiddleware) {
      registered.middleware = middleware;
      return middlewares;
    }
  };
  return {
    registered,
    server: {
      config: { preview },
      middlewares
    } as unknown as PreviewServer
  };
};

const createRequest = ({
  host = "127.0.0.1:5173",
  method = "GET",
  path = "/api/private/session",
  remoteAddress = "127.0.0.1"
}: {
  readonly host?: string;
  readonly method?: string;
  readonly path?: string;
  readonly remoteAddress?: string;
} = {}): IncomingMessage =>
  ({
    headers: { host },
    method,
    socket: { remoteAddress },
    url: path
  }) as unknown as IncomingMessage;

const createResponse = (): ResponseFixture => {
  const fixture: ResponseFixture = {
    body: "",
    ended: false,
    headers: new Map<string, string>(),
    response: undefined as unknown as ServerResponse
  };
  fixture.response = {
    statusCode: 200,
    setHeader(name: string, value: number | string | readonly string[]) {
      fixture.headers.set(name.toLowerCase(), String(value));
      return this;
    },
    end(chunk?: string) {
      fixture.body = chunk ?? "";
      fixture.ended = true;
      return this;
    }
  } as unknown as ServerResponse;
  return fixture;
};

const invoke = (
  middleware: PreviewMiddleware,
  request: IncomingMessage
): { readonly next: ReturnType<typeof vi.fn>; readonly response: ResponseFixture } => {
  const response = createResponse();
  const next = vi.fn();
  middleware(request, response.response, next);
  return { next, response };
};

const originalVisualQaFlag = process.env.NXT_VISUAL_QA_SESSION;
const originalE2eHmrFlag = process.env.NXT_E2E_DISABLE_VITE_HMR;

afterEach(() => {
  if (originalVisualQaFlag === undefined) {
    delete process.env.NXT_VISUAL_QA_SESSION;
  } else {
    process.env.NXT_VISUAL_QA_SESSION = originalVisualQaFlag;
  }
  if (originalE2eHmrFlag === undefined) {
    delete process.env.NXT_E2E_DISABLE_VITE_HMR;
  } else {
    process.env.NXT_E2E_DISABLE_VITE_HMR = originalE2eHmrFlag;
  }
  vi.restoreAllMocks();
});

describe("E2E Vite HMR boundary", () => {
  it.each([
    [undefined, undefined],
    ["0", undefined],
    ["true", undefined],
    ["1", false]
  ] as const)("maps opt-in value %s to HMR setting %s", async (flag, expected) => {
    if (flag === undefined) delete process.env.NXT_E2E_DISABLE_VITE_HMR;
    else process.env.NXT_E2E_DISABLE_VITE_HMR = flag;
    vi.resetModules();

    const loaded = (await import("../../vite.config")).default;

    expect(loaded.server?.hmr).toBe(expected);
  });
});

describe("local visual-QA preview boundary", () => {
  it("pins the version-controlled preview to the exact loopback invariant", () => {
    expect(config.preview).toEqual({
      host: "127.0.0.1",
      port: 5173,
      strictPort: true
    });
  });

  it("does not install a synthetic session when the opt-in flag is absent", () => {
    delete process.env.NXT_VISUAL_QA_SESSION;
    const fixture = createPreviewFixture({ host: "0.0.0.0", port: 5173, strictPort: false });

    runPreviewHook(fixture.server);

    expect(fixture.registered.middleware).toBeUndefined();
  });

  it("returns a synthetic session only for the exact loopback preview", () => {
    process.env.NXT_VISUAL_QA_SESSION = "1";
    const fixture = createPreviewFixture({ host: "127.0.0.1", port: 5173, strictPort: true });
    runPreviewHook(fixture.server);
    const middleware = fixture.registered.middleware;
    if (middleware === undefined) throw new Error("Synthetic session middleware was not installed.");

    const result = invoke(middleware, createRequest());

    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.response.statusCode).toBe(200);
    expect(result.response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(JSON.parse(result.response.body)).toEqual({
      user: { userDetails: "visual-qa-owner" }
    });
  });

  it.each(["0.0.0.0", "192.0.2.25", true] as const)(
    "refuses wildcard or non-loopback preview host %s",
    (host) => {
      process.env.NXT_VISUAL_QA_SESSION = "1";
      const fixture = createPreviewFixture({ host, port: 5173, strictPort: true });

      expect(() => runPreviewHook(fixture.server)).toThrow(/127\.0\.0\.1/u);
      expect(fixture.registered.middleware).toBeUndefined();
    }
  );

  it("refuses a visual-QA preview without strict port 5173", () => {
    process.env.NXT_VISUAL_QA_SESSION = "1";

    for (const preview of [
      { host: "127.0.0.1", port: 5174, strictPort: true },
      { host: "127.0.0.1", port: 5173, strictPort: false }
    ] as const) {
      const fixture = createPreviewFixture(preview);
      expect(() => runPreviewHook(fixture.server)).toThrow(/5173.*strict/u);
      expect(fixture.registered.middleware).toBeUndefined();
    }
  });

  it.each([
    ["192.0.2.10", "127.0.0.1:5173"],
    ["127.0.0.1", "example.test:5173"],
    ["127.0.0.1", "127.0.0.1:5174"]
  ] as const)("rejects client %s with Host %s before returning a principal", (remoteAddress, host) => {
    process.env.NXT_VISUAL_QA_SESSION = "1";
    const fixture = createPreviewFixture({ host: "127.0.0.1", port: 5173, strictPort: true });
    runPreviewHook(fixture.server);
    const middleware = fixture.registered.middleware;
    if (middleware === undefined) throw new Error("Synthetic session middleware was not installed.");

    const result = invoke(middleware, createRequest({ host, remoteAddress }));

    expect(result.next).not.toHaveBeenCalled();
    expect(result.response.response.statusCode).toBe(403);
    expect(result.response.body).toBe("Forbidden");
    expect(result.response.body).not.toContain("visual-qa-owner");
  });

  it.each([
    ["POST", "/api/private/session"],
    ["GET", "/api/private/other"]
  ] as const)("passes through %s %s", (method, path) => {
    process.env.NXT_VISUAL_QA_SESSION = "1";
    const fixture = createPreviewFixture({ host: "127.0.0.1", port: 5173, strictPort: true });
    runPreviewHook(fixture.server);
    const middleware = fixture.registered.middleware;
    if (middleware === undefined) throw new Error("Synthetic session middleware was not installed.");

    const result = invoke(middleware, createRequest({ method, path }));

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.response.ended).toBe(false);
  });
});
