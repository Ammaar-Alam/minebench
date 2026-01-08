import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const examplePath = path.join(repoRoot, ".env.example");
const envPath = path.join(repoRoot, ".env");

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

