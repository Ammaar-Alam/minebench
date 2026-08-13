import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Every Prisma model must have row level security enabled by some migration,
// so a new table cannot silently ship without it

const schema = readFileSync("prisma/schema.prisma", "utf8");
const modelNames = [...schema.matchAll(/^model (\w+) \{/gm)].map(([, name]) => name);
assert.ok(modelNames.length >= 11, "expected the Prisma schema to declare its models");

const migrationsDir = "prisma/migrations";
const migrationSql = readdirSync(migrationsDir)
  .map((entry) => join(migrationsDir, entry))
  .filter((path) => statSync(path).isDirectory())
  .map((dir) => readFileSync(join(dir, "migration.sql"), "utf8"))
  .join("\n");

const rlsEnabledTables = new Set(
  [...migrationSql.matchAll(/ALTER TABLE "(\w+)" ENABLE ROW LEVEL SECURITY/g)].map(
    ([, table]) => table,
  ),
);

for (const model of modelNames) {
  assert.ok(
    rlsEnabledTables.has(model),
    `Table ${model} has no ENABLE ROW LEVEL SECURITY migration`,
  );
}

assert.ok(
  rlsEnabledTables.has("_prisma_migrations"),
  "_prisma_migrations has no ENABLE ROW LEVEL SECURITY migration",
);

console.log(`RLS coverage checks passed for ${modelNames.length} models`);
