import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// Every test starts from empty tables, so seed() can be called in each test.
beforeEach(async () => {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`,
  ).all<{ name: string }>();
  await env.DB.batch(results.map((t) => env.DB.prepare(`DELETE FROM "${t.name}"`)));
  await env.DB.exec(`DELETE FROM sqlite_sequence`);
});
