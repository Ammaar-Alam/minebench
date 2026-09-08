import { createPrivateKey, createSign } from "node:crypto";
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

type ApnsHttp2Client = { connect(origin: string): ClientHttp2Session };

let http2Client: ApnsHttp2Client = { connect };
let apnsTimeoutMs = APNS_TIMEOUT_MS;
let cachedProviderToken:
  | {
      keyId: string;
      teamId: string;
      privateKey: string;
      token: string;
      expiresAtMs: number;
    }
  | null = null;

export function __setApnsHttp2ClientForTests(client: ApnsHttp2Client | null, timeoutMs = APNS_TIMEOUT_MS) {
  http2Client = client ?? { connect };
  apnsTimeoutMs = timeoutMs;
  cachedProviderToken = null;
}

export async function sendApnsNotification(input: {
  token: string;
  environment: "development" | "production";
  payload: PushPayload;
  collapseId: string;
}): Promise<ApnsNotificationResult> {
  const authorization = `bearer ${providerToken()}`;
  const session = http2Client.connect(apnsOrigin(input.environment));
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

    const finish = (callback: () => void, hardCancel = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanupSession(session, stream, hardCancel);
      callback();
    };
    const fail = (message: string) => finish(() => reject(new Error(message)), true);
    const timeout = setTimeout(() => fail("APNs request timed out"), apnsTimeoutMs);

    session.on("error", () => fail("APNs request failed"));
    session.on("close", () => fail("APNs connection closed"));

    try {
      stream = session.request(headers);
      stream.setEncoding("utf8");
      stream.on("response", (responseHeaders) => {
        const responseStatus = responseHeaders[constants.HTTP2_HEADER_STATUS];
        status = typeof responseStatus === "number" ? responseStatus : Number(responseStatus ?? 0);
      });
      stream.on("data", (chunk: string) => {
        responseBody += chunk;
      });
      stream.on("error", () => fail("APNs request failed"));
      stream.on("end", () => {
        if (!isValidHttpStatus(status)) {
          fail("APNs response missing or invalid status");
          return;
        }
        finish(() => resolve(parseApnsResponse(status, responseBody)));
      });
      stream.end(body);
    } catch {
      fail("APNs request failed");
    }
  });
}

function providerToken() {
  const keyId = requiredEnv("APNS_KEY_ID");
  const teamId = requiredEnv("APNS_TEAM_ID");
  const privateKey = requiredEnv("APNS_PRIVATE_KEY").replace(/\\n/g, "\n");
  const nowMs = Date.now();

  if (
    cachedProviderToken &&
    cachedProviderToken.keyId === keyId &&
    cachedProviderToken.teamId === teamId &&
    cachedProviderToken.privateKey === privateKey &&
    cachedProviderToken.expiresAtMs > nowMs
  ) {
    return cachedProviderToken.token;
  }

  const signingInput = [
    base64urlJson({ alg: "ES256", kid: keyId }),
    base64urlJson({ iss: teamId, iat: Math.floor(nowMs / 1000) }),
  ].join(".");
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer
    .sign({ key: createPrivateKey(privateKey), dsaEncoding: "ieee-p1363" })
    .toString("base64url");

  const token = `${signingInput}.${signature}`;
  cachedProviderToken = {
    keyId,
    teamId,
    privateKey,
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

function apnsOrigin(environment: "development" | "production") {
  return environment === "development"
    ? "https://api.sandbox.push.apple.com:443"
    : "https://api.push.apple.com:443";
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

function cleanupSession(session: ClientHttp2Session, stream: ClientHttp2Stream | null, hardCancel: boolean) {
  if (hardCancel) {
    if (stream && !stream.destroyed) stream.destroy();
    if (!session.destroyed) session.destroy();
    return;
  }
  if (!session.closed && !session.destroyed) session.close();
}
