import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import {
  __setApnsHttp2ClientForTests,
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
};

type FakeResponse = { status?: number | string; body?: string; stall?: boolean };

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
  stream?: FakeStream;

  constructor(
    private readonly origin: string,
    private readonly sent: SentRequest[],
    private readonly response: FakeResponse,
  ) {
    super();
  }

  request(headers: Record<string | symbol, unknown>) {
    this.stream = new FakeStream(this.response);
    this.sent.push({ origin: this.origin, headers, body: "", session: this });
    const sent = this.sent[this.sent.length - 1];
    this.stream.once("response", () => {
      sent.body = this.stream?.sentBody() ?? "";
    });
    return this.stream as unknown as ClientHttp2Stream;
  }

  close() {
    this.closed = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

function installFakeHttp2(response: FakeResponse, timeoutMs?: number) {
  const sent: SentRequest[] = [];
  __setApnsHttp2ClientForTests({
    connect: (origin: string) => new FakeSession(origin, sent, response) as unknown as ClientHttp2Session,
  }, timeoutMs);
  return sent;
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
  const sent = installFakeHttp2({ status: 200 });
  const ok = await sendApnsNotification({
    token: "00fc13adff785122",
    environment: "development",
    payload,
    collapseId: "gen_123",
  });
  assert.deepEqual(ok, { status: 200 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].origin, "https://api.sandbox.push.apple.com:443");
  assert.equal(sent[0].headers[constants.HTTP2_HEADER_METHOD], "POST");
  assert.equal(sent[0].headers[constants.HTTP2_HEADER_PATH], "/3/device/00fc13adff785122");
  assert.equal(sent[0].headers["apns-topic"], "com.ammaaralam.minebench");
  assert.equal(sent[0].headers["apns-push-type"], "alert");
  assert.equal(sent[0].headers["apns-priority"], "10");
  assert.ok(Number(sent[0].headers["apns-expiration"]) >= Math.floor(Date.now() / 1000) + 86_399);
  assert.equal(sent[0].headers["apns-collapse-id"], "gen_123");
  assert.equal(JSON.parse(sent[0].body).kind, "generation_succeeded");
  assert.equal(sent[0].session.closed, true);
  assert.equal(sent[0].session.destroyed, false);
  assert.equal(sent[0].session.stream?.closed, false);
  assert.equal(sent[0].session.stream?.destroyed, false);

  const auth = String(sent[0].headers.authorization);
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

  const cached = installFakeHttp2({ status: 200 });
  await sendApnsNotification({ token: "a", environment: "production", payload, collapseId: "same" });
  await sendApnsNotification({ token: "b", environment: "production", payload, collapseId: "same" });
  assert.equal(cached[0].origin, "https://api.push.apple.com:443");
  assert.equal(cached[0].headers.authorization, cached[1].headers.authorization);

  const badToken = installFakeHttp2({
    status: 400,
    body: JSON.stringify({ reason: "BadDeviceToken" }),
  });
  assert.deepEqual(
    await sendApnsNotification({ token: "bad", environment: "production", payload, collapseId: "bad-token" }),
    { status: 400, reason: "BadDeviceToken" },
  );
  assert.equal(badToken[0].session.closed, true);

  const missingStatus = installFakeHttp2({});
  await assert.rejects(
    sendApnsNotification({ token: "nostatus", environment: "production", payload, collapseId: "nostatus" }),
    /missing or invalid status/,
  );
  assert.equal(missingStatus[0].session.destroyed, true);
  assert.equal(missingStatus[0].session.stream?.destroyed, true);

  const statusZero = installFakeHttp2({ status: 0 });
  await assert.rejects(
    sendApnsNotification({ token: "zerostatus", environment: "production", payload, collapseId: "zerostatus" }),
    /missing or invalid status/,
  );
  assert.equal(statusZero[0].session.destroyed, true);
  assert.equal(statusZero[0].session.stream?.destroyed, true);

  const invalidStatus = installFakeHttp2({ status: "nope" });
  await assert.rejects(
    sendApnsNotification({ token: "badstatus", environment: "production", payload, collapseId: "badstatus" }),
    /missing or invalid status/,
  );
  assert.equal(invalidStatus[0].session.destroyed, true);
  assert.equal(invalidStatus[0].session.stream?.destroyed, true);

  const timedOut = installFakeHttp2({ stall: true }, 1);
  await assert.rejects(
    sendApnsNotification({ token: "slow", environment: "production", payload, collapseId: "slow" }),
    /timed out/,
  );
  assert.equal(timedOut[0].session.closed, false);
  assert.equal(timedOut[0].session.destroyed, true);
  assert.equal(timedOut[0].session.stream?.destroyed, true);

  const rejected = installFakeHttp2({
    status: 410,
    body: JSON.stringify({ reason: "Unregistered", timestamp: 1_762_500_000_000 }),
  });
  assert.deepEqual(
    await sendApnsNotification({ token: "deadbeef", environment: "production", payload, collapseId: "gone" }),
    { status: 410, reason: "Unregistered", invalidatedAt: 1_762_500_000_000 },
  );
  assert.equal(rejected[0].session.closed, true);

  delete process.env.APNS_PRIVATE_KEY;
  await assert.rejects(
    sendApnsNotification({ token: "deadbeef", environment: "production", payload, collapseId: "missing-key" }),
    /Missing APNS_PRIVATE_KEY/,
  );

  __setApnsHttp2ClientForTests(null);
  console.log("APNs transport checks passed");
}

void main();
