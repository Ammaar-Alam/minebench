import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import net from "node:net";
import { isDisallowedIpAddress } from "@/lib/ai/providers/customApiGuard";
import type { GenerateVoxelBuildParams } from "@/lib/ai/generateVoxelBuild";
import {
  normalizeProviderRequestOverrides,
  requestOverrideSecretValues,
} from "@/lib/ai/customProviderConfig";
import { z } from "zod";

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;
const MAX_STEALTH_MAX_OUTPUT_TOKENS = 1_000_000;

export type StealthEndpointProtocol =
  | "openai-compatible"
  | "openrouter"
  | "anthropic"
  | "gemini";

export const stealthEndpointConfigSchema = z.object({
  protocol: z.enum([
    "openai-compatible",
    "openai-chat-completions",
    "openrouter",
    "anthropic",
    "gemini",
  ]),
  endpointUrl: z.string().max(2048).default(""),
  apiKey: z.string().min(1).max(8192),
  modelId: z.string().min(1).max(512),
  maxOutputTokens: z
    .number()
    .int()
    .min(2_048)
    .max(MAX_STEALTH_MAX_OUTPUT_TOKENS)
    .optional(),
  requireStructuredOutput: z.boolean().default(true),
  enableTools: z.boolean().default(true),
  reasoning: z.string().trim().min(1).max(64).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
}).superRefine((config, ctx) => {
  const endpointUrl = config.endpointUrl.trim();
  const openAiCompatible =
    config.protocol === "openai-compatible" ||
    config.protocol === "openai-chat-completions";

  if (openAiCompatible) {
    if (!endpointUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpointUrl"],
        message: "endpointUrl is required for OpenAI-compatible endpoints",
      });
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(endpointUrl);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpointUrl"],
        message: "endpointUrl must be a valid URL",
      });
      return;
    }

    if (parsed.protocol !== "https:") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpointUrl"],
        message: "endpointUrl must use HTTPS",
      });
      return;
    }

    if (parsed.username || parsed.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpointUrl"],
        message: "endpointUrl must not include embedded credentials",
      });
      return;
    }

    const rawHostname = parsed.hostname.trim().toLowerCase();
    const hostname = rawHostname.replace(/^\[(.*)\]$/, "$1");
    if (
      !hostname ||
      hostname === "localhost" ||
      hostname === "localhost.localdomain" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpointUrl"],
        message: "endpointUrl must not target localhost or local network hosts",
      });
      return;
    }

    const hostFamily = net.isIP(hostname);
    if (hostFamily !== 0) {
      if (isDisallowedIpAddress(hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endpointUrl"],
          message: "endpointUrl must not target private or loopback IP addresses",
        });
        return;
      }
    } else if (!hostname.includes(".")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpointUrl"],
        message: "endpointUrl must use a public hostname",
      });
      return;
    }

    return;
  }

  if (endpointUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endpointUrl"],
      message: "endpointUrl is only supported for OpenAI-compatible endpoints",
    });
  }
});

export type StealthEndpointConfigInput = z.input<typeof stealthEndpointConfigSchema>;
export type StealthEndpointConfig = z.output<typeof stealthEndpointConfigSchema>;
type CanonicalStealthEndpointConfig = Omit<StealthEndpointConfig, "protocol"> & {
  protocol: StealthEndpointProtocol;
};
export type StealthGenerateVoxelBuildArgs = Pick<
  GenerateVoxelBuildParams,
  | "model"
  | "providerKeys"
  | "allowServerKeys"
  | "enableTools"
  | "reasoning"
  | "maxOutputTokens"
>;

function encryptionKey(raw = process.env.STEALTH_CONFIG_ENCRYPTION_KEY): Buffer {
  const value = raw?.trim() ?? "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("STEALTH_CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("STEALTH_CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

function normalizeEndpointApiKey(raw: string): string {
  const stripQuotes = (value: string) => {
    const first = value[0];
    return value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first
      ? value.slice(1, -1).trim()
      : value;
  };
  return stripQuotes(stripQuotes(raw.trim()).replace(/^Bearer\s+/i, "").trim());
}

function canonicalConfig(config: StealthEndpointConfigInput): CanonicalStealthEndpointConfig {
  const parsed = stealthEndpointConfigSchema.parse(config);
  const protocol =
    parsed.protocol === "openai-chat-completions"
      ? "openai-compatible"
      : parsed.protocol;
  const reasoning = parsed.reasoning?.trim();
  const { headers: _headers, body: _body, ...withoutOverrides } = parsed;
  const canonical = {
    ...withoutOverrides,
    ...normalizeProviderRequestOverrides(parsed),
    protocol,
    endpointUrl:
      protocol === "openai-compatible"
        ? parsed.endpointUrl.trim().replace(/\/+$/, "")
        : "",
    apiKey: normalizeEndpointApiKey(parsed.apiKey),
    modelId: parsed.modelId.trim(),
  };
  if (reasoning) canonical.reasoning = reasoning;
  else delete canonical.reasoning;
  return canonical;
}

export function stealthEndpointConfigToGenerateVoxelBuildArgs(
  input: StealthEndpointConfigInput,
  identity: { key: string; displayName: string },
): StealthGenerateVoxelBuildArgs {
  const config = canonicalConfig(input);
  const common = {
    allowServerKeys: false,
    enableTools: config.enableTools,
    reasoning: config.reasoning,
    maxOutputTokens: config.maxOutputTokens,
  };
  const requestOverrides = {
    ...(config.headers ? { customHeaders: config.headers } : {}),
    ...(config.body ? { customBody: config.body } : {}),
  };

  if (config.protocol === "openai-compatible") {
    return {
      ...common,
      model: {
        key: identity.key,
        provider: "custom",
        modelId: config.modelId,
        displayName: identity.displayName,
        baseUrl: config.endpointUrl,
        ...requestOverrides,
        requireStructuredOutput: config.requireStructuredOutput,
      },
      providerKeys: { custom: config.apiKey },
    };
  }

  if (config.protocol === "openrouter") {
    return {
      ...common,
      model: {
        key: identity.key,
        provider: "custom",
        modelId: config.modelId,
        displayName: identity.displayName,
        openRouterModelId: config.modelId,
        forceOpenRouter: true,
        ...requestOverrides,
        requireStructuredOutput: config.requireStructuredOutput,
      },
      providerKeys: { openrouter: config.apiKey },
    };
  }

  return {
    ...common,
    model: {
      key: identity.key,
      provider: config.protocol,
      modelId: config.modelId,
      displayName: identity.displayName,
      ...requestOverrides,
    },
    providerKeys: { [config.protocol]: config.apiKey },
  };
}

export function stealthEndpointSecretValues(config: StealthEndpointConfig): string[] {
  return [config.apiKey, ...requestOverrideSecretValues(config)];
}

export function generateStealthConfigEncryptionKey(): string {
  return randomBytes(32).toString("base64");
}

export function encryptStealthEndpointConfig(
  input: StealthEndpointConfigInput,
  rawKey?: string,
): { encryptedConfig: string; fingerprint: string } {
  const key = encryptionKey(rawKey);
  const config = canonicalConfig(input);
  const plaintext = Buffer.from(JSON.stringify(config), "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const fingerprint = createHmac("sha256", key).update(plaintext).digest("hex");

  return {
    encryptedConfig: [
      ENVELOPE_VERSION,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join("."),
    fingerprint,
  };
}

export function decryptStealthEndpointConfig(
  envelope: string,
  rawKey?: string,
): StealthEndpointConfig {
  const [version, encodedIv, encodedTag, encodedCiphertext, extra] = envelope.split(".");
  if (
    version !== ENVELOPE_VERSION ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext ||
    extra
  ) {
    throw new Error("Stealth endpoint credential has an unsupported format");
  }

  try {
    const key = encryptionKey(rawKey);
    const iv = Buffer.from(encodedIv, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    const ciphertext = Buffer.from(encodedCiphertext, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error("invalid envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return canonicalConfig(stealthEndpointConfigSchema.parse(JSON.parse(plaintext.toString("utf8"))));
  } catch {
    throw new Error("Stealth endpoint credential could not be decrypted");
  }
}
