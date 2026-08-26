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

export type EncryptedSecretValue = {
  ciphertext: string;
  iv: string;
  authTag: string;
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

export function encryptSecretValue(value: string, binding?: string): EncryptedSecretValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, deriveKey(getEncryptionSecret()), iv);
  if (binding) cipher.setAAD(Buffer.from(binding, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);

  return {
    ciphertext: encrypted.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    keyVersion: KEY_VERSION,
  };
}

export function decryptSecretValue(secret: EncryptedSecretValue, binding?: string): string {
  if (secret.keyVersion !== KEY_VERSION) {
    throw new Error(`Unsupported custom build key version: ${secret.keyVersion}`);
  }
  try {
    const decipher = createDecipheriv(
      CIPHER,
      deriveKey(getEncryptionSecret()),
      Buffer.from(secret.iv, "base64url"),
    );
    if (binding) decipher.setAAD(Buffer.from(binding, "utf8"));
    decipher.setAuthTag(Buffer.from(secret.authTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Failed to decrypt provider key");
  }
}

export function encryptProviderKey(
  providerKey: string,
  opts: { provider: string; binding?: string },
): EncryptedProviderKey {
  const encrypted = encryptSecretValue(providerKey, opts.binding);
  return {
    provider: opts.provider,
    keyCiphertext: encrypted.ciphertext,
    keyIv: encrypted.iv,
    keyAuthTag: encrypted.authTag,
    keyVersion: encrypted.keyVersion,
  };
}

export function decryptProviderKey(secret: EncryptedProviderKey, binding?: string): string {
  return decryptSecretValue(
    {
      ciphertext: secret.keyCiphertext,
      iv: secret.keyIv,
      authTag: secret.keyAuthTag,
      keyVersion: secret.keyVersion,
    },
    binding,
  );
}
