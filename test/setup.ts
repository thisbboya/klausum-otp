import { applyD1Migrations, env } from "cloudflare:test";

// Runs before each test file: build the schema in the local, throwaway D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
