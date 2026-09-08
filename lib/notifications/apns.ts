import { createHash, createPrivateKey, createSign } from "node:crypto";
import {
  connect,
  constants,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type OutgoingHttpHeaders,
} from "node:http2";

export type PushPayload = {
  aps: {
    alert: { title: string; body: string };
    sound: "default";
    "thread-id": string;
  };
  kind: "generation_succeeded" | "generation_failed" | "gallery_upvotes" | "gallery_contribution";
  id: string;
  userId: string;
};

export type ApnsNotificationResult = { status: number; reason?: string; invalidatedAt?: number };

const APNS_TOPIC = "com.ammaaralam.minebench";
const APNS_TIMEOUT_MS = 10_000;
const APNS_TOKEN_TTL_MS = 50 * 60 * 1000;

type ApnsEnvironment = "development" | "production";
type ApnsHttp2Client = { connect(origin: string): ClientHttp2Session };
type ApnsCredentials = { keyId: string; teamId: string; privateKey: string; fingerprint: string };
type ApnsSessionEntry = {
  credentialsFingerprint: string;
  connected: boolean;
  session: ClientHttp2Session;
};

let http2Client: ApnsHttp2Client = { connect };
let apnsTimeoutMs = APNS_TIMEOUT_MS;
let cachedProviderToken:
  | {
      credentialsFingerprint: string;
      token: string;
      expiresAtMs: number;
    }
  | null = null;
const apnsSessions = new Map<ApnsEnvironment, ApnsSessionEntry>();

export function __setApnsHttp2ClientForTests(client: ApnsHttp2Client | null, timeoutMs = APNS_TIMEOUT_MS) {
  destroyApnsConnections();
  http2Client = client ?? { connect };
  apnsTimeoutMs = timeoutMs;
  cachedProviderToken = null;
}

export function closeApnsConnections() {
  for (const [environment, entry] of apnsSessions) {
    apnsSessions.delete(environment);
    if (!entry.session.closed && !entry.session.destroyed) entry.session.close();
  }
}

function destroyApnsConnections() {
  for (const [environment, entry] of apnsSessions) {
    apnsSessions.delete(environment);
    if (!entry.session.destroyed) entry.session.destroy();
  }
}

export async function sendApnsNotification(input: {
  token: string;
  environment: ApnsEnvironment;
  payload: PushPayload;
  collapseId: string;
}): Promise<ApnsNotificationResult> {
  const credentials = readApnsCredentials();
  closeSessionsForCredentialChange(credentials.fingerprint);
  const authorization = `bearer ${providerToken(credentials)}`;
  const entry = apnsSession(input.environment, credentials.fingerprint);
  const body = JSON.stringify(input.payload);
  const headers: OutgoingHttpHeaders = {
    [constants.HTTP2_HEADER_METHOD]: "POST",
    [constants.HTTP2_HEADER_PATH]: `/3/device/${input.token}`,
    authorization,
    "apns-topic": APNS_TOPIC,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(Date.now() / 1000) + 24 * 60 * 60),
    "apns-collapse-id": input.collapseId,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let stream: ClientHttp2Stream | null = null;
    let status = 0;
    let responseBody = "";

    const finish = (callback: () => void, hardCancel = false, destroySession = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanupRequest(input.environment, entry, stream, hardCancel, destroySession);
      callback();
    };
    const fail = (message: string, destroySession = false) =>
      finish(() => reject(new Error(message)), true, destroySession);
    const timeout = setTimeout(() => fail("APNs request timed out"), apnsTimeoutMs);

    try {
      stream = entry.session.request(headers);
      stream.setEncoding("utf8");
      stream.on("response", (responseHeaders) => {
        const responseStatus = responseHeaders[constants.HTTP2_HEADER_STATUS];
        status = typeof responseStatus === "number" ? responseStatus : Number(responseStatus ?? 0);
      });
      stream.on("data", (chunk: string) => {
        responseBody += chunk;
      });
      stream.on("error", () => fail("APNs request failed"));
      stream.on("close", () => fail("APNs request closed"));
      stream.on("end", () => {
        if (!isValidHttpStatus(status)) {
          fail("APNs response missing or invalid status");
          return;
        }
        finish(() => resolve(parseApnsResponse(status, responseBody)));
      });
      stream.end(body);
    } catch {
      fail("APNs request failed", true);
    }
  });
}

function readApnsCredentials(): ApnsCredentials {
  const keyId = requiredEnv("APNS_KEY_ID");
  const teamId = requiredEnv("APNS_TEAM_ID");
  const privateKey = requiredEnv("APNS_PRIVATE_KEY").replace(/\\n/g, "\n");
  return {
    keyId,
    teamId,
    privateKey,
    fingerprint: `${keyId}:${teamId}:${createHash("sha256").update(privateKey).digest("hex")}`,
  };
}

function providerToken(credentials: ApnsCredentials) {
  const nowMs = Date.now();

  if (
    cachedProviderToken &&
    cachedProviderToken.credentialsFingerprint === credentials.fingerprint &&
    cachedProviderToken.expiresAtMs > nowMs
  ) {
    return cachedProviderToken.token;
  }

  const signingInput = [
    base64urlJson({ alg: "ES256", kid: credentials.keyId }),
    base64urlJson({ iss: credentials.teamId, iat: Math.floor(nowMs / 1000) }),
  ].join(".");
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer
    .sign({ key: createPrivateKey(credentials.privateKey), dsaEncoding: "ieee-p1363" })
    .toString("base64url");

  const token = `${signingInput}.${signature}`;
  cachedProviderToken = {
    credentialsFingerprint: credentials.fingerprint,
    token,
    expiresAtMs: nowMs + APNS_TOKEN_TTL_MS,
  };
  return token;
}

function base64urlJson(value: Record<string, string | number>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} for APNs`);
  return value;
}

function apnsOrigin(environment: ApnsEnvironment) {
  return environment === "development"
    ? "https://api.sandbox.push.apple.com:443"
    : "https://api.push.apple.com:443";
}

function apnsSession(environment: ApnsEnvironment, credentialsFingerprint: string) {
  const existing = apnsSessions.get(environment);
  if (
    existing &&
    existing.credentialsFingerprint === credentialsFingerprint &&
    !existing.session.closed &&
    !existing.session.destroyed
  ) {
    return existing;
  }
  if (existing) evictApnsSession(environment, existing, true);

  const session = http2Client.connect(apnsOrigin(environment));
  const entry: ApnsSessionEntry = { credentialsFingerprint, connected: false, session };
  apnsSessions.set(environment, entry);

  session.once("connect", () => {
    entry.connected = true;
  });
  session.once("error", () => evictApnsSession(environment, entry, true));
  session.once("close", () => evictApnsSession(environment, entry, false));
  session.once("goaway", () => evictApnsSession(environment, entry, true));

  return entry;
}

function closeSessionsForCredentialChange(credentialsFingerprint: string) {
  for (const [environment, entry] of apnsSessions) {
    if (entry.credentialsFingerprint !== credentialsFingerprint) evictApnsSession(environment, entry, true);
  }
}

function evictApnsSession(environment: ApnsEnvironment, entry: ApnsSessionEntry, destroy: boolean) {
  if (apnsSessions.get(environment) === entry) apnsSessions.delete(environment);
  if (destroy && !entry.session.destroyed) entry.session.destroy();
}

function parseApnsResponse(status: number, body: string): ApnsNotificationResult {
  if (!body) return { status };

  try {
    const parsed = JSON.parse(body) as { reason?: unknown; timestamp?: unknown };
    return {
      status,
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
      ...(status === 410 && typeof parsed.timestamp === "number" ? { invalidatedAt: parsed.timestamp } : {}),
    };
  } catch {
    return { status };
  }
}

function isValidHttpStatus(status: number) {
  return Number.isInteger(status) && status >= 100 && status <= 599;
}

function cleanupRequest(
  environment: ApnsEnvironment,
  entry: ApnsSessionEntry,
  stream: ClientHttp2Stream | null,
  hardCancel: boolean,
  destroySession: boolean,
) {
  if (hardCancel && stream && !stream.closed && !stream.destroyed) stream.close(constants.NGHTTP2_CANCEL);
  if (hardCancel && (destroySession || !entry.connected)) {
    evictApnsSession(environment, entry, true);
    return;
  }
}
