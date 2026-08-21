import assert from "node:assert/strict";
import {
  decryptStealthEndpointConfig,
  encryptStealthEndpointConfig,
  generateStealthConfigEncryptionKey,
} from "../../../lib/stealth/credentials";

const originalKey = process.env.STEALTH_CONFIG_ENCRYPTION_KEY;

try {
  const key = generateStealthConfigEncryptionKey();
  process.env.STEALTH_CONFIG_ENCRYPTION_KEY = key;
  assert.equal(Buffer.from(key, "base64").length, 32);

  const encrypted = encryptStealthEndpointConfig({
    protocol: "openai-chat-completions",
    endpointUrl: "https://checkpoints.example.ai/v1/",
    apiKey: "Bearer private-lab-key",
    modelId: "checkpoint-2026-08-21",
    requireStructuredOutput: true,
    enableTools: true,
    reasoning: "high",
  });
  assert.match(encrypted.encryptedConfig, /^v1\./);
  assert.match(encrypted.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(encrypted.encryptedConfig.includes("private-lab-key"), false);
  assert.deepEqual(decryptStealthEndpointConfig(encrypted.encryptedConfig), {
    protocol: "openai-chat-completions",
    endpointUrl: "https://checkpoints.example.ai/v1",
    apiKey: "private-lab-key",
    modelId: "checkpoint-2026-08-21",
    requireStructuredOutput: true,
    enableTools: true,
    reasoning: "high",
  });

  const tampered = `${encrypted.encryptedConfig.slice(0, -1)}${encrypted.encryptedConfig.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => decryptStealthEndpointConfig(tampered), /could not be decrypted/);
  assert.throws(
    () => decryptStealthEndpointConfig(encrypted.encryptedConfig, generateStealthConfigEncryptionKey()),
    /could not be decrypted/,
  );
  assert.throws(
    () => encryptStealthEndpointConfig({
      protocol: "openai-chat-completions",
      endpointUrl: "not-a-url",
      apiKey: "key",
      modelId: "checkpoint",
      requireStructuredOutput: true,
      enableTools: true,
    }),
  );

  console.log("stealth credential envelope checks passed");
} finally {
  if (originalKey === undefined) delete process.env.STEALTH_CONFIG_ENCRYPTION_KEY;
  else process.env.STEALTH_CONFIG_ENCRYPTION_KEY = originalKey;
}
