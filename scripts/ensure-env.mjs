import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const examplePath = path.join(repoRoot, ".env.example");
const envPath = path.join(repoRoot, ".env");
const envLocalPath = path.join(repoRoot, ".env.local");

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

function replaceDirectUrl(envText, newUrl) {
  const re = /^DIRECT_URL\s*=\s*(['"]?)(.*?)\1\s*$/m;
  const match = envText.match(re);
  if (!match) return envText;
  const quote = match[1] || "\"";
  return envText.replace(re, `DIRECT_URL=${quote}${newUrl}${quote}`);
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function getDatabaseUrlFromEnvText(envText) {
  const match = envText.match(/^DATABASE_URL\s*=\s*(['"]?)(.*?)\1\s*$/m);
  return match?.[2];
}

function getDirectUrlFromEnvText(envText) {
  const match = envText.match(/^DIRECT_URL\s*=\s*(['"]?)(.*?)\1\s*$/m);
  return match?.[2];
}

function removeDatabaseUrl(envText) {
  // remove the first DATABASE_URL line, keeping file otherwise untouched
  return envText.replace(/^DATABASE_URL\s*=\s*(['"]?)(.*?)\1\s*\r?\n?/m, "");
}

function appendEnvVar(envText, key, value) {
  const nextLine = `${key}="${value}"`;
  if (envText.length === 0) return `${nextLine}\n`;
  if (envText.endsWith("\n")) return `${envText}${nextLine}\n`;
  return `${envText}\n${nextLine}\n`;
}

async function syncEnvLocalDatabaseUrl(desiredUrl) {
  if (!desiredUrl) return;

  if (!(await fileExists(envLocalPath))) return;
  const currentLocal = await fs.readFile(envLocalPath, "utf8");
  const localUrl = getDatabaseUrlFromEnvText(currentLocal);

  // if .env.local defines DATABASE_URL, make it match .env so runtime + prisma CLI agree
  if (localUrl && localUrl !== desiredUrl) {
    const nextLocal = replaceDatabaseUrl(currentLocal, desiredUrl);
    await fs.writeFile(envLocalPath, nextLocal, "utf8");
    console.log("env: synced DATABASE_URL in .env.local to match .env");
    return;
  }

  // if .env.local has a legacy DATABASE_URL, strip it so .env takes precedence
  if (localUrl && LEGACY_DATABASE_URLS.has(localUrl)) {
    const nextLocal = removeDatabaseUrl(currentLocal);
    await fs.writeFile(envLocalPath, nextLocal, "utf8");
    console.log("env: removed legacy DATABASE_URL from .env.local");
  }
}

async function syncEnvLocalDirectUrl(desiredUrl) {
  if (!desiredUrl) return;

  if (!(await fileExists(envLocalPath))) return;
  const currentLocal = await fs.readFile(envLocalPath, "utf8");
  const localUrl = getDirectUrlFromEnvText(currentLocal);

  // if .env.local defines DIRECT_URL, make it match .env so runtime + prisma CLI agree
  if (localUrl != null && localUrl !== desiredUrl) {
    const nextLocal = replaceDirectUrl(currentLocal, desiredUrl);
    await fs.writeFile(envLocalPath, nextLocal, "utf8");
    console.log("env: synced DIRECT_URL in .env.local to match .env");
  }
}

async function main() {
  if (await fileExists(envPath)) {
    const current = await fs.readFile(envPath, "utf8");
    const currentUrl = getDatabaseUrlFromEnvText(current);
    const currentDirectUrl = getDirectUrlFromEnvText(current);

    if (currentUrl && LEGACY_DATABASE_URLS.has(currentUrl)) {
      const example = await fs.readFile(examplePath, "utf8");
      const nextUrl = getDatabaseUrlFromEnvText(example);

      if (nextUrl && nextUrl !== currentUrl) {
        let next = replaceDatabaseUrl(current, nextUrl);
        const directUrl = getDirectUrlFromEnvText(next);
        if (directUrl == null || directUrl.trim() === "" || LEGACY_DATABASE_URLS.has(directUrl)) {
          next = directUrl == null ? appendEnvVar(next, "DIRECT_URL", nextUrl) : replaceDirectUrl(next, nextUrl);
        }

        await fs.writeFile(envPath, next, "utf8");
        console.log("env: updated DATABASE_URL to match .env.example");
        await syncEnvLocalDatabaseUrl(nextUrl);
        await syncEnvLocalDirectUrl(getDirectUrlFromEnvText(next) ?? nextUrl);
        return;
      }
    }

    let next = current;
    let wrote = false;

    if (currentUrl && (currentDirectUrl == null || currentDirectUrl.trim() === "")) {
      next = currentDirectUrl == null ? appendEnvVar(next, "DIRECT_URL", currentUrl) : replaceDirectUrl(next, currentUrl);
      wrote = true;
      console.log("env: added DIRECT_URL to .env");
    }

    if (wrote) {
      await fs.writeFile(envPath, next, "utf8");
    } else {
      console.log("env: .env already exists");
    }

    await syncEnvLocalDatabaseUrl(getDatabaseUrlFromEnvText(next));
    await syncEnvLocalDirectUrl(getDirectUrlFromEnvText(next));
    return;
  }

  const example = await fs.readFile(examplePath, "utf8");
  await fs.writeFile(envPath, example, "utf8");
  console.log("env: wrote .env from .env.example");
  await syncEnvLocalDatabaseUrl(getDatabaseUrlFromEnvText(example));
  await syncEnvLocalDirectUrl(getDirectUrlFromEnvText(example));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
