import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const examplePath = path.join(repoRoot, ".env.example");
const envPath = path.join(repoRoot, ".env");

const LEGACY_DATABASE_URLS = new Set([
  "postgresql://minebench:minebench@localhost:5432/minebench?schema=public",
  "postgresql://minebench:minebench@127.0.0.1:5432/minebench?schema=public",
  "postgresql://minebench:minebench@localhost:54322/minebench?schema=public",
  "postgresql://minebench:minebench@127.0.0.1:54322/minebench?schema=public",
]);

function replaceDatabaseUrl(envText, newUrl) {
  const re = /^DATABASE_URL\s*=\s*(['"]?)(.*?)\1\s*$/m;
  const match = envText.match(re);
  if (!match) return envText;
  const quote = match[1] || "\"";
  return envText.replace(re, `DATABASE_URL=${quote}${newUrl}${quote}`);
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (await fileExists(envPath)) {
    const current = await fs.readFile(envPath, "utf8");
    const match = current.match(/^DATABASE_URL\s*=\s*(['"]?)(.*?)\1\s*$/m);
    const currentUrl = match?.[2];

    if (currentUrl && LEGACY_DATABASE_URLS.has(currentUrl)) {
      const example = await fs.readFile(examplePath, "utf8");
      const exampleMatch = example.match(/^DATABASE_URL\s*=\s*(['"]?)(.*?)\1\s*$/m);
      const nextUrl = exampleMatch?.[2];

      if (nextUrl && nextUrl !== currentUrl) {
        const next = replaceDatabaseUrl(current, nextUrl);
        await fs.writeFile(envPath, next, "utf8");
        console.log("env: updated DATABASE_URL to match .env.example");
        return;
      }
    }

    console.log("env: .env already exists");
    return;
  }

  const example = await fs.readFile(examplePath, "utf8");
  await fs.writeFile(envPath, example, "utf8");
  console.log("env: wrote .env from .env.example");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
