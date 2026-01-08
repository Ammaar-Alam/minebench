import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";

function parseDotenv(text) {
  const out = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(process.cwd(), ".env");
  const envText = await fs.readFile(envPath, "utf8");
  const env = parseDotenv(envText);
  return env.DATABASE_URL;
}

async function canConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function main() {
  const url = await readDatabaseUrl();
  if (!url) throw new Error("DATABASE_URL not found (set it in .env)");

  const u = new URL(url);
  const host = u.hostname;
  const port = u.port ? Number(u.port) : 5432;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await canConnect(host, port, 800);
    if (ok) {
      console.log(`db: reachable at ${host}:${port}`);
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }

  throw new Error(`db: timed out waiting for ${host}:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

