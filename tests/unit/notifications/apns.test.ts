import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import {
  __setApnsHttp2ClientForTests,
  closeApnsConnections,
  sendApnsNotification,
  type PushPayload,
} from "../../../lib/notifications/apns";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.APNS_KEY_ID = "KEY1234567";
process.env.APNS_TEAM_ID = "VM6477A6M8";
process.env.APNS_PRIVATE_KEY = String(privateKey.export({ type: "pkcs8", format: "pem" })).replace(/\n/g, "\\n");

const payload: PushPayload = {
  aps: {
    alert: { title: "Build ready", body: "Your generation finished." },
    sound: "default",
    "thread-id": "generation",
  },
  kind: "generation_succeeded",
  id: "gen_123",
  userId: "user_123",
};

type SentRequest = {
  origin: string;
  headers: Record<string | symbol, unknown>;
  body: string;
  session: FakeSession;
  stream: FakeStream;
};

type FakeResponse = { status?: number | string; body?: string; stall?: boolean; closeEarly?: boolean };

// Offline fake: no APNs network calls or real provider credentials.
class FakeStream extends EventEmitter {
  closed = false;
  destroyed = false;
  private body = "";

  constructor(private readonly response: FakeResponse) {
    super();
  }

  setEncoding() {
    return this;
  }

  write(chunk: string) {
    this.body += chunk;
  }

  end(chunk?: string) {
    if (chunk) this.write(chunk);
    if (this.response.stall) return;
    queueMicrotask(() => {
      if (this.response.closeEarly) {
        this.emit("close");
        return;
      }
      if (this.response.status !== undefined) {
        this.emit("response", { [constants.HTTP2_HEADER_STATUS]: this.response.status });
      }
      if (this.response.body) this.emit("data", this.response.body);
      this.emit("end");
    });
  }

  close() {
    this.closed = true;
  }

  destroy() {
    this.destroyed = true;
    return this;
  }

  sentBody() {
    return this.body;
  }
}

class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  streams: FakeStream[] = [];

  constructor(
    readonly origin: string,
    private readonly sent: SentRequest[],
    private readonly nextResponse: () => FakeResponse,
    autoConnect: boolean,
  ) {
    super();
    if (autoConnect) queueMicrotask(() => this.emit("connect"));
  }

  request(headers: Record<string | symbol, unknown>) {
    const stream = new FakeStream(this.nextResponse());
    this.streams.push(stream);
    this.sent.push({ origin: this.origin, headers, body: "", session: this, stream });
    const sent = this.sent[this.sent.length - 1];
    stream.once("response", () => {
      sent.body = stream.sentBody();
    });
    return stream as unknown as ClientHttp2Stream;
  }

  close() {
    this.closed = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

function installFakeHttp2(
  responses: FakeResponse | FakeResponse[],
  options: { timeoutMs?: number; autoConnect?: boolean } = {},
) {
  const sent: SentRequest[] = [];
  const sessions: FakeSession[] = [];
  const responseList = Array.isArray(responses) ? responses : [responses];
  let responseIndex = 0;
  __setApnsHttp2ClientForTests({
    connect: (origin: string) => {
      const session = new FakeSession(
        origin,
        sent,
        () => responseList[Math.min(responseIndex++, responseList.length - 1)] ?? { status: 200 },
        options.autoConnect ?? true,
      );
      sessions.push(session);
      return session as unknown as ClientHttp2Session;
    },
  }, options.timeoutMs);
  return { sent, sessions };
}

function decodeJwt(token: string) {
  const [header, claims, signature] = token.split(".");
  assert.ok(header);
  assert.ok(claims);
  assert.ok(signature);
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as Record<string, unknown>,
    signingInput: `${header}.${claims}`,
    signature,
  };
}

async function main() {
  const reused = installFakeHttp2([
    { status: 200 },
    { status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) },
    { status: 200 },
    { status: 200 },
  ]);
  const ok = await sendApnsNotification({
    token: "00fc13adff785122",
    environment: "development",
    payload,
    collapseId: "gen_123",
  });
  assert.deepEqual(ok, { status: 200 });
  assert.equal(reused.sent.length, 1);
  assert.equal(reused.sessions.length, 1);
  assert.equal(reused.sent[0].origin, "https://api.sandbox.push.apple.com:443");
  assert.equal(reused.sent[0].headers[constants.HTTP2_HEADER_METHOD], "POST");
  assert.equal(reused.sent[0].headers[constants.HTTP2_HEADER_PATH], "/3/device/00fc13adff785122");
  assert.equal(reused.sent[0].headers["apns-topic"], "com.ammaaralam.minebench");
  assert.equal(reused.sent[0].headers["apns-push-type"], "alert");
  assert.equal(reused.sent[0].headers["apns-priority"], "10");
  assert.ok(Number(reused.sent[0].headers["apns-expiration"]) >= Math.floor(Date.now() / 1000) + 86_399);
  assert.equal(reused.sent[0].headers["apns-collapse-id"], "gen_123");
  assert.equal(JSON.parse(reused.sent[0].body).kind, "generation_succeeded");
  assert.equal(reused.sessions[0].closed, false);
  assert.equal(reused.sessions[0].destroyed, false);

  const auth = String(reused.sent[0].headers.authorization);
  assert.match(auth, /^bearer /);
  const jwt = decodeJwt(auth.slice("bearer ".length));
  assert.deepEqual(jwt.header, { alg: "ES256", kid: "KEY1234567" });
  assert.equal(jwt.claims.iss, "VM6477A6M8");
  assert.equal(typeof jwt.claims.iat, "number");
  const verifier = createVerify("SHA256");
  verifier.update(jwt.signingInput);
  verifier.end();
  assert.equal(
    verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(jwt.signature, "base64url")),
    true,
  );

  assert.deepEqual(
    await sendApnsNotification({ token: "bad", environment: "development", payload, collapseId: "bad-token" }),
    { status: 400, reason: "BadDeviceToken" },
  );
  assert.equal(reused.sessions.length, 1);
  assert.equal(reused.sessions[0].closed, false);
  assert.equal(reused.sessions[0].destroyed, false);
  assert.equal(reused.sent[0].headers.authorization, reused.sent[1].headers.authorization);

  await sendApnsNotification({ token: "prod", environment: "production", payload, collapseId: "prod" });
  assert.equal(reused.sessions.length, 2);
  assert.equal(reused.sessions[1].origin, "https://api.push.apple.com:443");
  assert.notEqual(reused.sessions[0], reused.sessions[1]);

  reused.sessions[1].emit("goaway");
  assert.equal(reused.sessions[1].destroyed, true);
  await sendApnsNotification({ token: "prod2", environment: "production", payload, collapseId: "prod2" });
  assert.equal(reused.sessions.length, 3);
  assert.notEqual(reused.sessions[1], reused.sessions[2]);

  closeApnsConnections();
  assert.equal(reused.sessions[0].closed, true);
  assert.equal(reused.sessions[2].closed, true);
  assert.equal(reused.sessions[0].destroyed, false);
  assert.equal(reused.sessions[2].destroyed, false);

  const lifecycle = installFakeHttp2([{ status: 200 }, { status: 200 }, { status: 200 }]);
  await sendApnsNotification({ token: "before-close", environment: "development", payload, collapseId: "before-close" });
  lifecycle.sessions[0].emit("close");
  await sendApnsNotification({ token: "after-close", environment: "development", payload, collapseId: "after-close" });
  assert.equal(lifecycle.sessions.length, 2);
  lifecycle.sessions[1].emit("error", new Error("closed by APNs"));
  assert.equal(lifecycle.sessions[1].destroyed, true);
  await sendApnsNotification({ token: "after-error", environment: "development", payload, collapseId: "after-error" });
  assert.equal(lifecycle.sessions.length, 3);

  const rotated = installFakeHttp2([{ status: 200 }, { status: 200 }]);
  await sendApnsNotification({ token: "first-key", environment: "development", payload, collapseId: "first-key" });
  process.env.APNS_TEAM_ID = "VM6477A6M9";
  await sendApnsNotification({ token: "next-key", environment: "development", payload, collapseId: "next-key" });
  assert.equal(rotated.sessions.length, 2);
  assert.equal(rotated.sessions[0].destroyed, true);
  assert.equal(rotated.sessions[1].destroyed, false);
  process.env.APNS_TEAM_ID = "VM6477A6M8";

  const missingStatus = installFakeHttp2({});
  await assert.rejects(
    sendApnsNotification({ token: "nostatus", environment: "production", payload, collapseId: "nostatus" }),
    /missing or invalid status/,
  );
  assert.equal(missingStatus.sent[0].stream.closed, true);
  assert.equal(missingStatus.sessions[0].destroyed, false);

  const statusZero = installFakeHttp2({ status: 0 });
  await assert.rejects(
    sendApnsNotification({ token: "zerostatus", environment: "production", payload, collapseId: "zerostatus" }),
    /missing or invalid status/,
  );
  assert.equal(statusZero.sent[0].stream.closed, true);
  assert.equal(statusZero.sessions[0].destroyed, false);

  const invalidStatus = installFakeHttp2({ status: "nope" });
  await assert.rejects(
    sendApnsNotification({ token: "badstatus", environment: "production", payload, collapseId: "badstatus" }),
    /missing or invalid status/,
  );
  assert.equal(invalidStatus.sent[0].stream.closed, true);
  assert.equal(invalidStatus.sessions[0].destroyed, false);

  const closedStream = installFakeHttp2({ closeEarly: true });
  await assert.rejects(
    sendApnsNotification({ token: "closed", environment: "production", payload, collapseId: "closed" }),
    /request closed/,
  );
  assert.equal(closedStream.sent[0].stream.closed, true);
  assert.equal(closedStream.sessions[0].destroyed, false);

  const timedOut = installFakeHttp2([{ stall: true }, { status: 200 }], { timeoutMs: 1 });
  const slowPush = sendApnsNotification({ token: "slow", environment: "production", payload, collapseId: "slow" });
  assert.deepEqual(
    await sendApnsNotification({ token: "fast", environment: "production", payload, collapseId: "fast" }),
    { status: 200 },
  );
  await assert.rejects(slowPush, /timed out/);
  assert.equal(timedOut.sessions.length, 1);
  assert.equal(timedOut.sessions[0].closed, false);
  assert.equal(timedOut.sessions[0].destroyed, false);
  assert.equal(timedOut.sent[0].stream.closed, true);
  assert.equal(timedOut.sent[1].stream.closed, false);

  const connectingTimeout = installFakeHttp2({ stall: true }, { timeoutMs: 1, autoConnect: false });
  await assert.rejects(
    sendApnsNotification({ token: "connect", environment: "production", payload, collapseId: "connect" }),
    /timed out/,
  );
  assert.equal(connectingTimeout.sent[0].stream.closed, true);
  assert.equal(connectingTimeout.sessions[0].destroyed, true);

  const rejected = installFakeHttp2({
    status: 410,
    body: JSON.stringify({ reason: "Unregistered", timestamp: 1_762_500_000_000 }),
  });
  assert.deepEqual(
    await sendApnsNotification({ token: "deadbeef", environment: "production", payload, collapseId: "gone" }),
    { status: 410, reason: "Unregistered", invalidatedAt: 1_762_500_000_000 },
  );
  assert.equal(rejected.sessions[0].closed, false);
  assert.equal(rejected.sessions[0].destroyed, false);

  delete process.env.APNS_PRIVATE_KEY;
  await assert.rejects(
    sendApnsNotification({ token: "deadbeef", environment: "production", payload, collapseId: "missing-key" }),
    /Missing APNS_PRIVATE_KEY/,
  );

  __setApnsHttp2ClientForTests(null);
  console.log("APNs transport checks passed");
}

void main();
