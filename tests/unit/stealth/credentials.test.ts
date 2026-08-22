import assert from "node:assert/strict";
import {
  decryptStealthEndpointConfig,
  encryptStealthEndpointConfig,
  generateStealthConfigEncryptionKey,
  stealthEndpointConfigToGenerateVoxelBuildArgs,
} from "../../../lib/stealth/credentials";

const originalKey = process.env.STEALTH_CONFIG_ENCRYPTION_KEY;

try {
  const key = generateStealthConfigEncryptionKey();
  process.env.STEALTH_CONFIG_ENCRYPTION_KEY = key;
  assert.equal(Buffer.from(key, "base64").length, 32);

  const encrypted = encryptStealthEndpointConfig({
    protocol: "openai-compatible",
    endpointUrl: "https://checkpoints.example.ai/v1/",
    apiKey: "Bearer private-lab-key",
    modelId: "checkpoint-2026-08-21",
    maxOutputTokens: 131_072,
    requireStructuredOutput: true,
    enableTools: true,
    reasoning: "high",
  });
  assert.match(encrypted.encryptedConfig, /^v1\./);
  assert.match(encrypted.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(encrypted.encryptedConfig.includes("private-lab-key"), false);
  assert.deepEqual(decryptStealthEndpointConfig(encrypted.encryptedConfig), {
    protocol: "openai-compatible",
    endpointUrl: "https://checkpoints.example.ai/v1",
    apiKey: "private-lab-key",
    modelId: "checkpoint-2026-08-21",
    maxOutputTokens: 131_072,
    requireStructuredOutput: true,
    enableTools: true,
    reasoning: "high",
  });
  assert.deepEqual(
    stealthEndpointConfigToGenerateVoxelBuildArgs(
      decryptStealthEndpointConfig(encrypted.encryptedConfig),
      { key: "stealth_variant", displayName: "Ox Alpha" },
    ),
    {
      model: {
        key: "stealth_variant",
        provider: "custom",
        modelId: "checkpoint-2026-08-21",
        displayName: "Ox Alpha",
        baseUrl: "https://checkpoints.example.ai/v1",
        requireStructuredOutput: true,
      },
      providerKeys: { custom: "private-lab-key" },
      allowServerKeys: false,
      enableTools: true,
      reasoning: "high",
      maxOutputTokens: 131_072,
    },
  );

  const legacyEncrypted = encryptStealthEndpointConfig({
    protocol: "openai-chat-completions",
    endpointUrl: "https://legacy-checkpoints.example.ai/v1/",
    apiKey: "legacy-key",
    modelId: "legacy-checkpoint",
  });
  assert.equal(
    decryptStealthEndpointConfig(legacyEncrypted.encryptedConfig).protocol,
    "openai-compatible",
  );

  const openRouterEncrypted = encryptStealthEndpointConfig({
    protocol: "openrouter",
    apiKey: 'Bearer "openrouter-key"',
    modelId: "stealth/ox-alpha",
    maxOutputTokens: 65_536,
    requireStructuredOutput: true,
    enableTools: false,
    reasoning: "max",
  });
  assert.deepEqual(
    stealthEndpointConfigToGenerateVoxelBuildArgs(
      decryptStealthEndpointConfig(openRouterEncrypted.encryptedConfig),
      { key: "stealth_openrouter", displayName: "Ox OpenRouter" },
    ),
    {
      model: {
        key: "stealth_openrouter",
        provider: "custom",
        modelId: "stealth/ox-alpha",
        displayName: "Ox OpenRouter",
        openRouterModelId: "stealth/ox-alpha",
        forceOpenRouter: true,
      },
      providerKeys: { openrouter: "openrouter-key" },
      allowServerKeys: false,
      enableTools: false,
      reasoning: "max",
      maxOutputTokens: 65_536,
    },
  );

  assert.deepEqual(
    stealthEndpointConfigToGenerateVoxelBuildArgs(
      decryptStealthEndpointConfig(
        encryptStealthEndpointConfig({
          protocol: "anthropic",
          apiKey: "anthropic-key",
          modelId: "claude-checkpoint",
        }).encryptedConfig,
      ),
      { key: "stealth_anthropic", displayName: "Ox Anthropic" },
    ).model,
    {
      key: "stealth_anthropic",
      provider: "anthropic",
      modelId: "claude-checkpoint",
      displayName: "Ox Anthropic",
    },
  );
  assert.deepEqual(
    stealthEndpointConfigToGenerateVoxelBuildArgs(
      decryptStealthEndpointConfig(
        encryptStealthEndpointConfig({
          protocol: "gemini",
          apiKey: "gemini-key",
          modelId: "gemini-checkpoint",
          enableTools: false,
        }).encryptedConfig,
      ),
      { key: "stealth_gemini", displayName: "Ox Gemini" },
    ).providerKeys,
    { gemini: "gemini-key" },
  );

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
  assert.throws(
    () => encryptStealthEndpointConfig({
      protocol: "openrouter",
      endpointUrl: "https://openrouter.example/v1",
      apiKey: "key",
      modelId: "provider/model",
    }),
    /endpointUrl is only supported/,
  );
  assert.throws(
    () => encryptStealthEndpointConfig({
      protocol: "gemini",
      apiKey: "key",
      modelId: "gemini-checkpoint",
      maxOutputTokens: 2_000_000,
    }),
  );

  console.log("stealth credential envelope checks passed");
} finally {
  if (originalKey === undefined) delete process.env.STEALTH_CONFIG_ENCRYPTION_KEY;
  else process.env.STEALTH_CONFIG_ENCRYPTION_KEY = originalKey;
}
