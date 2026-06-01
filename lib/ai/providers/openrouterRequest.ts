export type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OpenRouterSupportedParameter =
  | "max_tokens"
  | "stop"
  | "reasoning"
  | "include_reasoning"
  | "tool_choice"
  | "tools"
  | "structured_outputs"
  | "response_format"
  | "verbosity"
  | "temperature";

export type OpenRouterEndpointCapabilities = {
  data?: unknown;
  endpoints?: unknown;
};

type OpenRouterEndpointMetadata = {
  supported_parameters?: unknown;
};

export const VOXEL_BUILD_JSON_SCHEMA_NAME = "voxel_build_response";

export const OPENROUTER_UNSUPPORTED_WHEN_REQUIRE_PARAMETERS: Record<string, OpenRouterSupportedParameter[]> = {
  "anthropic/claude-opus-4.8": ["temperature"],
};

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function normalizeSupportedParameter(value: unknown): OpenRouterSupportedParameter | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "max_tokens" ||
    normalized === "stop" ||
    normalized === "reasoning" ||
    normalized === "include_reasoning" ||
    normalized === "tool_choice" ||
    normalized === "tools" ||
    normalized === "structured_outputs" ||
    normalized === "response_format" ||
    normalized === "verbosity" ||
    normalized === "temperature"
  ) {
    return normalized;
  }
  return null;
}

function coerceEndpointList(capabilities: OpenRouterEndpointCapabilities): OpenRouterEndpointMetadata[] {
  const raw = Array.isArray(capabilities.data)
    ? capabilities.data
    : Array.isArray(capabilities.endpoints)
      ? capabilities.endpoints
      : [];
  return raw.filter((entry): entry is OpenRouterEndpointMetadata => Boolean(entry && typeof entry === "object"));
}

function parameterBlockedByStaticModelRule(
  modelId: string,
  parameter: OpenRouterSupportedParameter,
): boolean {
  const blocked = OPENROUTER_UNSUPPORTED_WHEN_REQUIRE_PARAMETERS[normalizeModelId(modelId)];
  return Boolean(blocked?.includes(parameter));
}

function supportsParameter(
  supportedParameters: ReadonlySet<string> | undefined,
  parameter: OpenRouterSupportedParameter,
): boolean {
  return !supportedParameters || supportedParameters.has(parameter);
}

function shouldIncludeOptionalParameter(args: {
  modelId: string;
  parameter: OpenRouterSupportedParameter;
  requireParameters: boolean;
  supportedParameters?: ReadonlySet<string>;
}): boolean {
  if (parameterBlockedByStaticModelRule(args.modelId, args.parameter)) return false;
  if (!args.requireParameters) return true;
  return supportsParameter(args.supportedParameters, args.parameter);
}

export function openRouterSupportedParametersFromEndpoints(
  capabilities: OpenRouterEndpointCapabilities,
): Set<OpenRouterSupportedParameter> {
  const params = new Set<OpenRouterSupportedParameter>();
  for (const endpoint of coerceEndpointList(capabilities)) {
    const raw = endpoint.supported_parameters;
    if (!Array.isArray(raw)) continue;
    for (const value of raw) {
      const normalized = normalizeSupportedParameter(value);
      if (normalized) params.add(normalized);
    }
  }
  return params;
}

export function buildOpenRouterChatRequestBody(args: {
  modelId: string;
  messages: OpenRouterMessage[];
  stream: boolean;
  maxTokens: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  reasoning?: unknown;
  textVerbosity?: "low" | "medium" | "high";
  requireParameters?: boolean;
  supportedParameters?: ReadonlySet<string>;
  explicitTemperature?: boolean;
}): Record<string, unknown> {
  const requireParameters = Boolean(args.requireParameters);
  const body: Record<string, unknown> = {
    model: args.modelId,
    messages: args.messages,
    stream: args.stream,
    max_tokens: args.maxTokens,
  };

  if (requireParameters) {
    body.provider = { require_parameters: true };
  }

  if (
    typeof args.temperature === "number" &&
    args.explicitTemperature &&
    shouldIncludeOptionalParameter({
      modelId: args.modelId,
      parameter: "temperature",
      requireParameters,
      supportedParameters: args.supportedParameters,
    })
  ) {
    body.temperature = args.temperature;
  }

  if (
    args.reasoning !== undefined &&
    shouldIncludeOptionalParameter({
      modelId: args.modelId,
      parameter: "reasoning",
      requireParameters,
      supportedParameters: args.supportedParameters,
    })
  ) {
    body.reasoning = args.reasoning;
  }

  if (
    args.textVerbosity &&
    shouldIncludeOptionalParameter({
      modelId: args.modelId,
      parameter: "verbosity",
      requireParameters,
      supportedParameters: args.supportedParameters,
    })
  ) {
    body.text = { verbosity: args.textVerbosity };
  }

  if (args.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: VOXEL_BUILD_JSON_SCHEMA_NAME,
        strict: true,
        schema: args.jsonSchema,
      },
    };
  }

  return body;
}
