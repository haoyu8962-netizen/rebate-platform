// Unit tests of the re-verification's discarded Apple token (B1-02zzd; BR-ID-27, BR-ID-28; 编排
// D10-968) over a recording Kysely driver and a recording queue: a passed Apple comparison whose
// settlement wrote nothing (the account entered deletion) answers 0 as before and queues the
// exchanged refresh token for revocation in a transaction of its own; a stored token, a mismatch,
// another provider or a missing token queue nothing. The SQL itself runs against PostgreSQL in the
// rule tests (test/spec/identity/apple-token-after-deletion, test/spec/identity/reverify).
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  type FieldCrypto,
  type JobQueue,
  type TokenPrincipal,
} from '../../platform/index.ts';
import { APPLE_UNBIND_REVOKE_JOB } from './apple-unbind-revocation.ts';
import { DATA_COPY_QUEUE } from './data-copy-worker.ts';
import type { OauthAttemptService } from './oauth-attempts.ts';
import { createReverifyService } from './reverify.ts';
import type { ThirdPartyIdentity } from './step-up.ts';

const APP = 'b1-02zzd-unit';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5e01';
const DEVICE = 'device-1';
const UNION = 'apple-union-1';
const TOKEN = 'apple-rt-unit-c';
const NOW = '2026-11-08T02:00:00.000Z';

interface Options {
  /** The account entered deletion before the settlement (it writes nothing). */
  readonly inDeletion?: boolean;
  /** The union id of the account's binding (default UNION). */
  readonly bound?: string;
  readonly identity?: ThirdPartyIdentity;
  readonly sendFails?: boolean;
}

function setup(options: Options = {}) {
  const events: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const sql = compiled.sql.replace(/\s+/g, ' ').trim();
      let rows: unknown[] = [];
      let label = sql.split(' ').slice(0, 3).join(' ');
      if (sql.startsWith('select "reverify_flagged_at"')) {
        rows = [
          {
            flagged_at: new Date(NOW),
            trusted: { realname: false, providers: ['apple', 'wechat'] },
            fail_count: 0,
            fail_day: null,
          },
        ];
      } else if (sql.startsWith('select "device_hash"')) {
        rows = [{ device_hash: 'device-hash-1' }];
      } else if (sql.startsWith('select "union_id"')) {
        rows = [{ union_id: options.bound ?? UNION }];
      } else if (sql.includes('reverify_fail_count = CASE')) {
        label = 'reserve';
        rows = [{ reverify_fail_count: 1, reverify_fail_epoch: 1 }];
      } else if (sql.includes('reverify_fail_count = 0')) {
        label = 'settle';
        rows = options.inDeletion === true ? [] : [{ id: USER }];
      } else if (sql.startsWith('select "id", "row_version"')) {
        label = 'apple-binding';
        rows = [{ id: 'binding-1', row_version: 1 }];
      } else if (sql.startsWith('update "user_oauth"')) {
        label = 'apple-token-stored';
      }
      events.push(label);
      return Promise.resolve({ rows, numAffectedRows: 1n } as QueryResult<R>);
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
  const crypto = { encrypt: (value: string) => `cipher#${value.length}` } as unknown as FieldCrypto;
  const sent: { queue: string; name: string; payload: unknown }[] = [];
  const queue: Pick<JobQueue, 'send'> = {
    send: (name, jobName, payload) => {
      events.push('send');
      sent.push({ queue: name, name: jobName, payload });
      return options.sendFails === true
        ? Promise.reject(new Error(`queue down ${TOKEN}`))
        : Promise.resolve('job-1');
    },
  };
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const identity: ThirdPartyIdentity = options.identity ?? {
    union_id: UNION,
    apple_refresh_token: TOKEN,
  };
  const service = createReverifyService({
    db,
    queue,
    clock: new FixedClock(NOW),
    crypto,
    logger,
    attempts: {
      consume: () => Promise.resolve({ code: 0, data: { nonce: 'nonce-1' } }),
    } as unknown as OauthAttemptService,
    thirdPartyIdentity: { exchange: () => Promise.resolve(identity) },
  });
  return { service, events, sent, lines };
}

const PRINCIPAL: TokenPrincipal = {
  uid: USER,
  app_id: APP,
  sid: 'sid-1',
  device_id: DEVICE,
  scp: 'full',
};
const SIGNED = { appId: APP, deviceId: DEVICE };
const ATTEMPT = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5e09';
const APPLE_BODY = {
  provider: 'apple',
  attempt_id: ATTEMPT,
  identity_token: 'id-token',
  authorization_code: 'auth-code',
} as const;
const WECHAT_BODY = { provider: 'wechat', attempt_id: ATTEMPT, code: 'wx-code' } as const;

it('[AC-B1-02zzd] a pass of an account in deletion answers 0 and queues the token after the settlement, in its own transaction', async () => {
  const { service, events, sent, lines } = setup({ inDeletion: true });
  expect(await service.byOauth(PRINCIPAL, SIGNED, APPLE_BODY)).toEqual({ code: 0 });
  expect(sent).toEqual([
    {
      queue: DATA_COPY_QUEUE,
      name: APPLE_UNBIND_REVOKE_JOB,
      payload: { appId: APP, cipher: `cipher#${TOKEN.length}` },
    },
  ]);
  expect(events).not.toContain('apple-token-stored');
  const settle = events.indexOf('settle');
  expect(events.slice(settle + 1)).toEqual(['commit', 'begin', 'send', 'commit']);
  expect(lines.join('\n')).not.toContain(TOKEN);
  expect(lines.join('\n')).not.toContain('identity_reverify_passed');
});

it('[AC-B1-02zzd] a normal pass stores the token and queues nothing', async () => {
  const { service, events, sent } = setup();
  expect(await service.byOauth(PRINCIPAL, SIGNED, APPLE_BODY)).toEqual({ code: 0 });
  expect(events).toContain('apple-token-stored');
  expect(sent).toEqual([]);
});

it('[AC-B1-02zzd] a mismatch (20005) of an account in deletion queues nothing', async () => {
  const { service, sent } = setup({ inDeletion: true, bound: 'apple-union-other' });
  expect(await service.byOauth(PRINCIPAL, SIGNED, APPLE_BODY)).toMatchObject({ code: 20005 });
  expect(sent).toEqual([]);
});

it('[AC-B1-02zzd] no refresh token, or a WeChat pass, of an account in deletion queues nothing', async () => {
  const noToken = setup({ inDeletion: true, identity: { union_id: UNION } });
  expect(await noToken.service.byOauth(PRINCIPAL, SIGNED, APPLE_BODY)).toEqual({ code: 0 });
  expect(noToken.sent).toEqual([]);
  const wechat = setup({
    inDeletion: true,
    identity: { union_id: UNION, apple_refresh_token: TOKEN },
  });
  expect(await wechat.service.byOauth(PRINCIPAL, SIGNED, WECHAT_BODY)).toEqual({ code: 0 });
  expect(wechat.sent).toEqual([]);
});

it('[AC-B1-02zzd] a failed enqueue keeps the answer 0 and logs one warn line without the token', async () => {
  const { service, sent, lines } = setup({ inDeletion: true, sendFails: true });
  expect(await service.byOauth(PRINCIPAL, SIGNED, APPLE_BODY)).toEqual({ code: 0 });
  expect(sent).toHaveLength(1);
  const failed = lines.filter((line) =>
    line.includes('identity_apple_discarded_token_enqueue_failed'),
  );
  expect(failed).toHaveLength(1);
  expect(JSON.parse(failed[0]!)).toMatchObject({ level: 40, app_id: APP, user_id: USER });
  expect(lines.join('\n')).not.toContain(TOKEN);
});
