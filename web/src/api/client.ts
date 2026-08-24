import { ApiErrorSchema, type ApiError } from "@nxt/contracts";

interface JsonSchema<T> {
  safeParse(input: unknown):
    | { readonly success: true; readonly data: T }
    | { readonly success: false };
}

type ApplicationApiPath = `/api/${string}`;

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

export const requestJson = async <T>(
  path: ApplicationApiPath,
  responseSchema: JsonSchema<T>,
  errorSchema: JsonSchema<ApiError> = ApiErrorSchema,
  init: RequestInit = {}
): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init.headers as Record<string, string> | undefined)
    }
  });
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
