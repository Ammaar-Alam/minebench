import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const CIPHER = "aes-256-gcm";
const KEY_VERSION = 1;
const IV_BYTES = 12;

export type EncryptedProviderKey = {
  provider: string;
  keyCiphertext: string;
  keyIv: string;
  keyAuthTag: string;
  keyVersion: number;
};

function getEncryptionSecret(): string {
  const secret = process.env.CUSTOM_BUILD_KEY_ENCRYPTION_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing CUSTOM_BUILD_KEY_ENCRYPTION_SECRET");
  }
  return secret;
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptProviderKey(
  providerKey: string,
  opts: { provider: string },
): EncryptedProviderKey {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, deriveKey(getEncryptionSecret()), iv);
  const encrypted = Buffer.concat([
    cipher.update(providerKey, "utf8"),
    cipher.final(),
  ]);

  return {
    provider: opts.provider,
    keyCiphertext: encrypted.toString("base64url"),
    keyIv: iv.toString("base64url"),
    keyAuthTag: cipher.getAuthTag().toString("base64url"),
    keyVersion: KEY_VERSION,
  };
}

export function decryptProviderKey(secret: EncryptedProviderKey): string {
  if (secret.keyVersion !== KEY_VERSION) {
    throw new Error(`Unsupported custom build key version: ${secret.keyVersion}`);
  }
  try {
    const decipher = createDecipheriv(
      CIPHER,
      deriveKey(getEncryptionSecret()),
      Buffer.from(secret.keyIv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(secret.keyAuthTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.keyCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Failed to decrypt provider key");
  }
}
