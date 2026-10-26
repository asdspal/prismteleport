import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/prism_teleport";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const LOCK_ID = 31611;

export async function runMigrations(
  client: Client,
  dir = MIGRATIONS_DIR,
): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
  try {
    const files = (await readdir(dir))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const applied = new Set(
      (
        await client.query<{ filename: string }>(
          "SELECT filename FROM schema_migrations",
        )
      ).rows.map((row) => row.filename),
    );

    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      ran.push(file);
    }

    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const ran = await runMigrations(client);
    console.log(
      ran.length === 0
        ? "Database schema already up to date."
        : `Applied migrations: ${ran.join(", ")}`,
    );
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
