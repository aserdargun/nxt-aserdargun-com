import { ApiErrorSchema, type ApiError } from "@nxt/contracts";

interface JsonSchema<T> {
  safeParse(input: unknown):
    | { readonly success: true; readonly data: T }
    | { readonly success: false };
}

export type ApplicationApiPath = `/api/${string}`;

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

const fetchApplication = (path: ApplicationApiPath, init: RequestInit): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  return fetch(path, { ...init, credentials: "same-origin", headers });
};

export const requestJson = async <T>(
  path: ApplicationApiPath,
  responseSchema: JsonSchema<T>,
  errorSchema: JsonSchema<ApiError> = ApiErrorSchema,
  init: RequestInit = {}
): Promise<T> => {
  const response = await fetchApplication(path, init);
  const body = await readJson(response);

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
  const response = await fetchApplication(path, init);
  const body = await readJson(response);
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
