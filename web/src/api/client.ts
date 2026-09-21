import { ApiErrorSchema, type ApiError } from "@nxt/contracts";

interface JsonSchema<T> {
  safeParse(input: unknown):
    | { readonly success: true; readonly data: T }
    | { readonly success: false };
}

export type ApplicationApiPath = `/api/${string}`;

const READ_TIMEOUT_MS = 30_000;

export class ApiTimeoutError extends Error {
  public constructor() {
    super("The service took too long to respond. Please try again.");
    this.name = "ApiTimeoutError";
  }
}

export class ApiAuthenticationError extends Error {
  public constructor() {
    super("Authentication is required.");
    this.name = "ApiAuthenticationError";
  }
}

export class ApiContractError extends Error {
  public constructor() {
    super("The application received an invalid response.");
    this.name = "ApiContractError";
  }
}

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: ApiError["error"]["code"];
  public readonly requestId: string;

  public constructor(status: number, response: ApiError) {
    super(response.error.message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = response.error.code;
    this.requestId = response.error.requestId;
  }
}

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    throw new ApiContractError();
  }
};

const fetchApplication = async (path: ApplicationApiPath, init: RequestInit): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const response = await fetch(path, { ...init, credentials: "same-origin", headers });
  // SWA can reject an expired session at the gateway before the JSON API runs.
  if (path.startsWith("/api/private/") && response.status === 401 &&
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/html") {
    throw new ApiAuthenticationError();
  }
  return response;
};

const fetchJson = async (path: ApplicationApiPath, init: RequestInit): Promise<{ response: Response; body: unknown }> => {
  // A write may have reached Drive even if the browser stops waiting. Leave
  // mutation reconciliation to its existing caller; only bound read requests.
  if ((init.method ?? "GET").toUpperCase() !== "GET") {
    const response = await fetchApplication(path, init);
    return { response, body: await readJson(response) };
  }
  const controller = new AbortController();
  const timeoutError = new ApiTimeoutError();
  const abort = (): void => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError), READ_TIMEOUT_MS);
  try {
    const response = await fetchApplication(path, { ...init, signal: controller.signal });
    return { response, body: await readJson(response) };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
};

export const requestJson = async <T>(
  path: ApplicationApiPath,
  responseSchema: JsonSchema<T>,
  errorSchema: JsonSchema<ApiError> = ApiErrorSchema,
  init: RequestInit = {}
): Promise<T> => {
  const { response, body } = await fetchJson(path, init);

  if (response.ok) {
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiContractError();
    }
    return parsed.data;
  }

  const parsedError = errorSchema.safeParse(body);
  if (!parsedError.success) {
    throw new ApiContractError();
  }
  throw new ApiClientError(response.status, parsedError.data);
};

export const requestOptionalJson = async <T>(
  path: ApplicationApiPath,
  responseSchema: JsonSchema<T>,
  errorSchema: JsonSchema<ApiError> = ApiErrorSchema,
  init: RequestInit = {}
): Promise<T | null> => {
  const { response, body } = await fetchJson(path, init);
  if (response.ok) {
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new ApiContractError();
    return parsed.data;
  }
  const parsedError = errorSchema.safeParse(body);
  if (!parsedError.success) throw new ApiContractError();
  if (response.status === 404 && parsedError.data.error.code === "NOT_FOUND") return null;
  throw new ApiClientError(response.status, parsedError.data);
};
