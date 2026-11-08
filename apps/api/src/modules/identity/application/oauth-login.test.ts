// Unit tests of the OAuth login's discarded Apple token (B1-02zzd; BR-ID-27, BR-ID-28; 编排 D10-968)
// over a recording Kysely driver and a recording queue: an Apple login of an account in deletion
// answers as before and, after the login transaction rolled back, queues the exchanged refresh token
// for revocation in a transaction of its own; nothing else queues. The SQL itself runs against
// PostgreSQL in the rule tests (test/spec/identity/apple-token-after-deletion).
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
} from '../../platform/index.ts';
import type { TokenService } from './access-tokens.ts';
import { APPLE_UNBIND_REVOKE_JOB } from './apple-unbind-revocation.ts';
import { DATA_COPY_QUEUE } from './data-copy-worker.ts';
import { createOauthLoginService, type OauthLoginCommand } from './oauth-login.ts';
import type { RegistrationService } from './registration.ts';
import type { ThirdPartyIdentity } from './step-up.ts';

const APP = 'b1-02zzd-unit';
const USER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5d01';
const TOKEN = 'apple-rt-unit-b';
const NOW = '2026-11-08T02:00:00.000Z';

interface Options {
  /** The account the binding points at (absent: no binding). */
  readonly account?: { readonly status: string };
  /** What the provider exchange answers. */
  readonly identity?: ThirdPartyIdentity;
  /** The client is below the minimum version (deletion_only scope). */
  readonly restricted?: boolean;
  readonly sendFails?: boolean;
}

function setup(options: Options = {}) {
  const events: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const sql = compiled.sql;
      events.push(sql.startsWith('select') ? 'select' : sql);
      let rows: unknown[] = [];
      if (sql.includes('from "user_oauth" as "oauth"') && options.account !== undefined) {
        rows = [{ id: USER, status: options.account.status, parent_bind_source: null }];
      }
      return Promise.resolve({ rows } as QueryResult<R>);
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
  const crypto = {
    blindIndex: (value: string) => `hmac(${value.length})`,
    encrypt: (value: string) => `cipher#${value.length}`,
  } as unknown as FieldCrypto;
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
    union_id: 'apple-union-1',
    apple_refresh_token: TOKEN,
  };
  const service = createOauthLoginService({
    db,
    queue,
    clock: new FixedClock(NOW),
    crypto,
    logger,
    tokens: {} as TokenService,
    versions: {
      minSupportedVersion: () => Promise.resolve(options.restricted === true ? '9.0.0' : null),
    },
    config: { configValue: () => Promise.resolve(null) },
    attempts: { consume: () => Promise.resolve({ code: 0, data: { nonce: 'nonce-1' } }) },
    thirdPartyIdentity: { exchange: () => Promise.resolve(identity) },
    registration: {} as RegistrationService,
  });
  return { service, events, sent, lines };
}

function command(provider: 'apple' | 'wechat' = 'apple'): OauthLoginCommand {
  const common = {
    app_id: APP,
    device_id: 'device-1',
    platform: 'ios',
    channel: 'appstore',
    version: '1.0.0',
    client_ip: '203.0.113.9',
  } as const;
  const body = {
    attempt_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5d09',
    legal_versions: {},
    consent_at: NOW,
  };
  return provider === 'apple'
    ? {
        ...common,
        provider,
        body: { ...body, identity_token: 'id-token', authorization_code: 'auth-code' } as never,
      }
    : { ...common, provider, body: { ...body, code: 'wx-code' } as never };
}

const REVOKE = { queue: DATA_COPY_QUEUE, name: APPLE_UNBIND_REVOKE_JOB };

it('[AC-B1-02zzd] deleting account: 10007 unchanged, the token queued after the rollback in its own transaction', async () => {
  const { service, events, sent, lines } = setup({ account: { status: 'deleting' } });
  expect(await service.login(command())).toEqual({ code: 10007, data: { stage: 'processing' } });
  expect(sent).toEqual([{ ...REVOKE, payload: { appId: APP, cipher: `cipher#${TOKEN.length}` } }]);
  const rollback = events.indexOf('rollback');
  expect(rollback).toBeGreaterThan(-1);
  expect(events.slice(rollback + 1)).toEqual(['begin', 'send', 'commit']);
  expect(lines.join('\n')).not.toContain(TOKEN);
});

it('[AC-B1-02zzd] deleted account: 50001 unchanged, the token queued once', async () => {
  const { service, sent } = setup({ account: { status: 'deleted' } });
  expect(await service.login(command())).toEqual({ code: 50001 });
  expect(sent).toEqual([{ ...REVOKE, payload: { appId: APP, cipher: `cipher#${TOKEN.length}` } }]);
});

it('[AC-B1-02zzd] no refresh token in the exchange: nothing is queued', async () => {
  const { service, sent } = setup({
    account: { status: 'deleting' },
    identity: { union_id: 'apple-union-1' },
  });
  expect(await service.login(command())).toEqual({ code: 10007, data: { stage: 'processing' } });
  expect(sent).toEqual([]);
});

it('[AC-B1-02zzd] WeChat login of a deleting account: nothing is queued', async () => {
  const { service, sent } = setup({
    account: { status: 'deleting' },
    identity: { union_id: 'wx-union-1', apple_refresh_token: TOKEN },
  });
  expect(await service.login(command('wechat'))).toEqual({
    code: 10007,
    data: { stage: 'processing' },
  });
  expect(sent).toEqual([]);
});

it('[AC-B1-02zzd] restricted login without an account (10405 no_account): nothing is queued', async () => {
  const { service, sent } = setup({ restricted: true });
  expect(await service.login(command())).toEqual({
    code: 10405,
    data: { reason: 'no_account', min_supported_version: '9.0.0' },
  });
  expect(sent).toEqual([]);
});

it('[AC-B1-02zzd] a 50001 that is not a deletion (unknown device of a new identity): nothing is queued', async () => {
  const { service, sent } = setup();
  expect(await service.login(command())).toEqual({ code: 50001 });
  expect(sent).toEqual([]);
});

it('[AC-B1-02zzd] a failed enqueue keeps the answer and logs one warn line without the token', async () => {
  const { service, sent, lines } = setup({ account: { status: 'deleting' }, sendFails: true });
  expect(await service.login(command())).toEqual({ code: 10007, data: { stage: 'processing' } });
  expect(sent).toHaveLength(1);
  const failed = lines.filter((line) =>
    line.includes('identity_apple_discarded_token_enqueue_failed'),
  );
  expect(failed).toHaveLength(1);
  expect(JSON.parse(failed[0]!)).toMatchObject({ level: 40, app_id: APP, provider: 'apple' });
  expect(lines.join('\n')).not.toContain(TOKEN);
});
