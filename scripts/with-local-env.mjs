import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import dotenv from "dotenv";

const repoRoot = process.cwd();
const envPath = path.join(repoRoot, ".env.localdb.local");

if (!fs.existsSync(envPath)) {
  console.error("Missing .env.localdb.local. Run `pnpm env:localdb` first.");
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("Usage: node scripts/with-local-env.mjs <command> [args...]");
  process.exit(1);
}

const [command, ...args] = argv;
const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
const child = spawn(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    ...parsed,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
