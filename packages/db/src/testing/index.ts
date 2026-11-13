// Test database helper (`@couli/db/testing`), ADR-0001 §4.2 #9.
// Requires the globalSetup in the vitest config, given as the relative path of the source file
// packages/db/src/testing/global-setup.ts (e.g. '../packages/db/src/testing/global-setup.ts' in
// test/vitest.integration.config.ts), never as the package specifier: Vitest resolves globalSetup
// without the `couli-src` condition, so the specifier would load packages/db/dist.
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';
import { inject } from 'vitest';

import { pgUrl } from '../pg-url.ts';
import { TEST_DB_CONTEXT_KEY, type TestDbContext, type TestDbRole } from './context.ts';
import { PG_TEST_IMAGE, quoteIdent, randomHex } from './provision.ts';

export { PG_TEST_IMAGE };
export { TEST_DB_ROLES } from './context.ts';
export type { TestDbContext, TestDbRole } from './context.ts';
// One-shot Redis (B1-01y §9.3): TEST_REDIS_URL or a Testcontainers container; needs no globalSetup.
export { REDIS_TEST_IMAGE, acquireTestRedis } from './redis.ts';
export type { TestRedis } from './redis.ts';

export type TestDatabase = {
  /** Database name, unique within the cluster. */
  name: string;
  /** Connection URL for one of the business roles. Tests never connect as superuser. */
  urlFor(role: TestDbRole): string;
  /**
   * Drops the database. Waits up to DROP_GRACE_MS for other connections to exit on their own,
   * then terminates any that are still open (they receive 57P01).
   */
  drop(): Promise<void>;
};

function context(): TestDbContext {
  const value = inject(TEST_DB_CONTEXT_KEY);
  // `inject` returns undefined at runtime when the globalSetup did not run.
  if ((value as TestDbContext | undefined) === undefined) {
    throw new Error(
      'No test database context: add the source file packages/db/src/testing/global-setup.ts ' +
        'to globalSetup as a relative path (integrationConfig in vitest.shared.ts; see ' +
        'test/vitest.integration.config.ts), not the package specifier.',
    );
  }
  return value;
}

async function withFactory<T>(
  ctx: TestDbContext,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: ctx.factoryUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function asFactory(ctx: TestDbContext, statement: string): Promise<void> {
  await withFactory(ctx, async (client) => {
    await client.query(statement);
  });
}

/** Upper bound on how long `drop()` waits for other backends to exit before forcing. */
export const DROP_GRACE_MS = 3000;
const DROP_POLL_MS = 25;

/**
 * Clones a fresh database from the migrated template. Call it once per test file (in
 * `beforeAll`) and `drop()` it in `afterAll`; leftovers are removed by the global teardown.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const ctx = context();
  const name = `couli_t_${ctx.runId}_${randomHex(6)}`;
  await asFactory(ctx, `CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(ctx.template)}`);
  return {
    name,
    urlFor(role: TestDbRole): string {
      return pgUrl(ctx.factoryUrl, {
        user: role,
        password: ctx.rolePasswords[role],
        database: name,
      });
    },
    async drop(): Promise<void> {
      // pg-pool's end() resolves once client.end() is called, before the socket has closed, so
      // the backend may still be connected here. Forcing at once would kill it with 57P01, which
      // lands on a pool nobody listens to any more. Poll until such backends are gone (bounded);
      // only connections still open after the grace period are terminated by FORCE.
      await withFactory(ctx, async (client) => {
        const deadline = performance.now() + DROP_GRACE_MS;
        for (;;) {
          const { rows } = await client.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
            [name],
          );
          if (rows[0]?.n === 0 || performance.now() >= deadline) break;
          await delay(DROP_POLL_MS);
        }
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
      });
    },
  };
}
