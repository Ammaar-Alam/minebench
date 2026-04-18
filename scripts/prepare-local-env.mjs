import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const repoRoot = process.cwd();
const outputPath = path.join(repoRoot, ".env.localdb.local");
const DEFAULT_LOCAL_DB_URL =
  "postgresql://minebench:minebench@localhost:54327/minebench?schema=public";

function parseIfExists(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath, "utf8"));
}

function shellQuote(value) {
  return JSON.stringify(value ?? "");
}

function isManagedMinebenchLocalDbUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol.startsWith("postgres") &&
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      url.username === "minebench" &&
      decodeURIComponent(url.password) === "minebench" &&
      url.pathname.replace(/^\/+/, "") === "minebench"
    );
  } catch {
    return false;
  }
}

function main() {
  const existingLocal = parseIfExists(outputPath);
  const merged = {
    ...parseIfExists(path.join(repoRoot, ".env.example")),
    ...parseIfExists(path.join(repoRoot, ".env")),
    ...parseIfExists(path.join(repoRoot, ".env.local")),
  };

  const localDbUrl =
    (isManagedMinebenchLocalDbUrl(process.env.MINEBENCH_LOCAL_DB_URL) &&
      process.env.MINEBENCH_LOCAL_DB_URL) ||
    (isManagedMinebenchLocalDbUrl(existingLocal.DATABASE_URL) && existingLocal.DATABASE_URL) ||
    (isManagedMinebenchLocalDbUrl(existingLocal.DIRECT_URL) && existingLocal.DIRECT_URL) ||
    DEFAULT_LOCAL_DB_URL;

  merged.DATABASE_URL = localDbUrl;
  merged.DIRECT_URL = localDbUrl;
  merged.ADMIN_TOKEN = merged.ADMIN_TOKEN || "local-dev-admin";
  merged.MINEBENCH_LOCAL_ENV = "1";

  const lines = Object.keys(merged)
    .sort()
    .map((key) => `${key}=${shellQuote(merged[key])}`);

  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`wrote ${path.relative(repoRoot, outputPath)}`);
  console.log(`DATABASE_URL -> ${localDbUrl}`);
  console.log("Supabase storage credentials preserved so storage-backed builds can be read locally");
}

main();
