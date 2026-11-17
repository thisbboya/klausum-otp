import { applyD1Migrations, env } from "cloudflare:test";

// Runs before each test file: build the schema in the local, throwaway D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// TEST ONLY: older tests create apps by writing apps.api_key_hash directly. Mirror those
// keys into api_keys (where auth looks since migration 0006) so they keep working.
await env.DB.exec(
  "CREATE TRIGGER IF NOT EXISTS test_mirror_key AFTER INSERT ON apps WHEN NEW.api_key_hash NOT LIKE 'unused:%' " +
  "BEGIN INSERT OR IGNORE INTO api_keys (id, app_id, key_hash, prefix, created_at) VALUES ('key_' || NEW.id, NEW.id, NEW.api_key_hash, NEW.api_key_prefix, NEW.created_at); END;",
);
