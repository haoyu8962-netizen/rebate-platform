// Unit tests of enqueueDiscardedAppleToken (B1-02zzd; BR-ID-27, BR-ID-28; 编排 D10-968) over a
// recording Kysely driver and a recording queue: the token is encrypted with the Apple refresh-token
// context and one apple_unbind_revoke job is sent inside a short transaction of its own. The job
// against PostgreSQL is the rule tests' (test/spec/identity/apple-token-after-deletion).
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  Transaction,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import type { FieldCrypto, JobQueue } from '../../platform/index.ts';
import { APPLE_REFRESH_TOKEN_CONTEXT } from '../infra/oauth-accounts.ts';
import { APPLE_UNBIND_REVOKE_JOB, enqueueDiscardedAppleToken } from './apple-unbind-revocation.ts';
import { DATA_COPY_QUEUE } from './data-copy-worker.ts';

const APP = 'b1-02zzd-unit';
const TOKEN = 'apple-rt-unit-a';

function setup(options: { sendFails?: boolean } = {}) {
  const events: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      events.push(compiled.sql);
      return Promise.resolve({ rows: [] } as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => void events.push('begin'),
    commitTransaction: async () => void events.push('commit'),
    rollbackTransaction: async () => void events.push('rollback'),
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const contexts: string[] = [];
  const crypto = {
    encrypt: (value: string, context: string) => {
      contexts.push(context);
      return `cipher#${value.length}`;
    },
  } as unknown as FieldCrypto;
  const sent: { queue: string; name: string; payload: unknown; inTransaction: boolean }[] = [];
  const queue: Pick<JobQueue, 'send'> = {
    send: (name, jobName, payload, sendOptions) => {
      events.push('send');
      const trx = (sendOptions as { trx?: unknown } | undefined)?.trx;
      sent.push({
        queue: name,
        name: jobName,
        payload,
        inTransaction: trx instanceof Transaction,
      });
      return options.sendFails === true
        ? Promise.reject(new Error(`queue down ${TOKEN}`))
        : Promise.resolve('job-1');
    },
  };
  return { db, crypto, queue, events, sent, contexts };
}

it('[AC-B1-02zzd] encrypts with the Apple refresh-token context and sends one job in its own transaction', async () => {
  const { db, crypto, queue, events, sent, contexts } = setup();
  await enqueueDiscardedAppleToken({ queue, db, crypto }, { appId: APP, refreshToken: TOKEN });
  expect(contexts).toEqual([APPLE_REFRESH_TOKEN_CONTEXT]);
  expect(events).toEqual(['begin', 'send', 'commit']);
  expect(sent).toEqual([
    {
      queue: DATA_COPY_QUEUE,
      name: APPLE_UNBIND_REVOKE_JOB,
      payload: { appId: APP, cipher: `cipher#${TOKEN.length}` },
      inTransaction: true,
    },
  ]);
  expect(JSON.stringify(sent)).not.toContain(TOKEN);
});

it('[AC-B1-02zzd] a failed send rolls its transaction back and rejects', async () => {
  const { db, crypto, queue, events } = setup({ sendFails: true });
  await expect(
    enqueueDiscardedAppleToken({ queue, db, crypto }, { appId: APP, refreshToken: TOKEN }),
  ).rejects.toThrow();
  expect(events).toEqual(['begin', 'send', 'rollback']);
});
