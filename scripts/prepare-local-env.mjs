import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const repoRoot = process.cwd();
const outputPath = path.join(repoRoot, ".env.localdb.local");
const LOCAL_DB_URL = "postgresql://minebench:minebench@localhost:54327/minebench?schema=public";

function parseIfExists(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath, "utf8"));
}

function shellQuote(value) {
  return JSON.stringify(value ?? "");
}

function main() {
  const merged = {
    ...parseIfExists(path.join(repoRoot, ".env.example")),
    ...parseIfExists(path.join(repoRoot, ".env")),
    ...parseIfExists(path.join(repoRoot, ".env.local")),
  };

  merged.DATABASE_URL = LOCAL_DB_URL;
  merged.DIRECT_URL = LOCAL_DB_URL;
  merged.ADMIN_TOKEN = merged.ADMIN_TOKEN || "local-dev-admin";
  merged.MINEBENCH_LOCAL_ENV = "1";

  const lines = Object.keys(merged)
    .sort()
    .map((key) => `${key}=${shellQuote(merged[key])}`);

  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`wrote ${path.relative(repoRoot, outputPath)}`);
  console.log(`DATABASE_URL -> ${LOCAL_DB_URL}`);
  console.log("Supabase storage credentials preserved so storage-backed builds can be read locally");
}

main();
