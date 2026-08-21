import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { z } from "zod";

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;

export const stealthEndpointConfigSchema = z.object({
  protocol: z.literal("openai-chat-completions"),
  endpointUrl: z.string().url().max(2048),
  apiKey: z.string().min(1).max(8192),
  modelId: z.string().min(1).max(512),
  requireStructuredOutput: z.boolean().default(true),
  enableTools: z.boolean().default(true),
  reasoning: z.string().trim().min(1).max(64).optional(),
});

export type StealthEndpointConfig = z.infer<typeof stealthEndpointConfigSchema>;

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

function canonicalConfig(config: StealthEndpointConfig): StealthEndpointConfig {
  const parsed = stealthEndpointConfigSchema.parse(config);
  return {
    ...parsed,
    endpointUrl: parsed.endpointUrl.trim().replace(/\/+$/, ""),
    apiKey: parsed.apiKey.trim().replace(/^Bearer\s+/i, "").trim(),
    modelId: parsed.modelId.trim(),
  };
}

export function generateStealthConfigEncryptionKey(): string {
  return randomBytes(32).toString("base64");
}

export function encryptStealthEndpointConfig(
  input: StealthEndpointConfig,
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
