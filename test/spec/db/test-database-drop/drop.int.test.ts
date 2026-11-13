// CT-06zzzzzd §9: real PostgreSQL teardown, with no driver or timer mocks.
// Global setup supplies the disposable cluster through @couli/db/testing.
import type { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Resolve the existing driver from its owning package, as in the pool regression tests.
// No direct pg dependency or administrator credentials are needed in this test package.
interface Client extends EventEmitter {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values: string[]): Promise<{ rows: { datname: string }[] }>;
}
const requireDb = createRequire(new URL('../../../../packages/db/package.json', import.meta.url));
const { Client } = requireDb('pg') as {
  Client: new (config: { connectionString: string }) => Client;
};

const NATURAL_EXIT_MS = 800;
// Acceptance lower bound, not an implementation constant: allow a 1–5 s grace period.
const MIN_GRACE_MS = 1000;
// The specified <=5 s wait plus connection, DROP and CI scheduling overhead.
const COMPLETION_LIMIT_MS = 8000;

let observerDatabase: TestDatabase | undefined;
let observer: Client;

beforeAll(async () => {
  observerDatabase = await createTestDatabase();
  observer = new Client({ connectionString: observerDatabase.urlFor('couli_app') });
  await observer.connect();
});

afterAll(async () => {
  try {
    await observer?.end();
  } finally {
    await observerDatabase?.drop();
  }
});

// Turn a rejection or deadline overrun into an assertion result, not an unhandled error
// or a Vitest timeout. Attach the rejection handler immediately.
async function outcome(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), COMPLETION_LIMIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function databaseRows(name: string) {
  return (await observer.query('SELECT datname FROM pg_database WHERE datname = $1', [name])).rows;
}

async function exerciseDrop(naturalExit: boolean) {
  const database = await createTestDatabase();
  const client = new Client({ connectionString: database.urlFor('couli_app') });
  const errors: { code: unknown; elapsedMs: number; error: unknown }[] = [];
  let startedAt = 0;
  client.on('error', (error: unknown) => {
    errors.push({
      code: typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
      elapsedMs: performance.now() - startedAt,
      error,
    });
  });
  // Register before DROP and wait for socket closure before inspecting errors: a late
  // 57P01 must not escape the assertion merely because the factory query finished first.
  const closed = new Promise<void>((resolve) => client.once('end', resolve));
  let scheduledEnd: ReturnType<typeof outcome> | undefined;
  let dropped = false;
  try {
    await client.connect();
    expect(await databaseRows(database.name), 'the target exists before DROP').toEqual([
      { datname: database.name },
    ]);
    startedAt = performance.now();
    const dropping = database.drop();
    if (naturalExit) {
      scheduledEnd = outcome(delay(NATURAL_EXIT_MS).then(() => client.end()));
    }
    const dropResult = await outcome(dropping);
    const elapsedMs = performance.now() - startedAt;
    dropped = dropResult.status === 'fulfilled';
    expect(dropResult, 'drop must resolve within the bounded grace period plus overhead').toEqual({
      status: 'fulfilled',
    });
    expect(await outcome(closed), 'the target connection must actually close').toEqual({
      status: 'fulfilled',
    });
    if (scheduledEnd) {
      expect(await scheduledEnd, 'the scheduled natural close must succeed').toEqual({
        status: 'fulfilled',
      });
    }
    expect(await databaseRows(database.name), 'successful drop must remove the database').toEqual(
      [],
    );
    return { elapsedMs, errors };
  } finally {
    // Let the scheduled callback finish even on assertion failure; no pending timer may
    // touch a fixture belonging to the next test. Close before cleanup DROP on failure.
    try {
      if (scheduledEnd) await scheduledEnd;
      await client.end();
    } finally {
      if (!dropped) await database.drop();
    }
  }
}

it('[AC-CT-06zzzzzd#1] 等待延迟自然退出的后端再删库，不产生 57P01', async () => {
  const result = await exerciseDrop(true);
  // Baseline FORCE deterministically kills the deliberately open client, rather than
  // depending on the narrow pool.end()/socket-close race of the original incident.
  expect(result.errors.map(({ code }) => code)).not.toContain('57P01');
  expect(result.errors, 'natural close must not emit connection errors').toEqual([]);
  expect(result.elapsedMs).toBeLessThan(COMPLETION_LIMIT_MS);
});

it('[AC-CT-06zzzzzd#2] 后端一直不退出时先等待、再强制删库，57P01 仍传给连接', async () => {
  const result = await exerciseDrop(false);
  const terminated = result.errors.filter(({ code }) => code === '57P01');
  expect(terminated, 'FORCE must remain observable by the connection error listener').toHaveLength(
    1,
  );
  // Check when termination occurs as well as when drop resolves: FORCE followed by a
  // cosmetic sleep must not satisfy the grace-period requirement.
  expect(terminated[0]!.elapsedMs).toBeGreaterThanOrEqual(MIN_GRACE_MS);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(MIN_GRACE_MS);
  expect(result.elapsedMs).toBeLessThan(COMPLETION_LIMIT_MS);
});
