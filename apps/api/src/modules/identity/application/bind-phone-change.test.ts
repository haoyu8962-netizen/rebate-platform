// Unit tests of the change branch's guards under the users row lock (B1-20b, Codex money r1 S0 #1 /
// #2), without a database: a fake Kysely driver answers the locked users row and the request's
// session; SMS, the switch, revocation and audit are stubs. The SMS stub answers 20002, so a request
// that passes every guard stops at the new number's code and nothing is written either way.
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
import { expect, it, vi } from 'vitest';
import { FixedClock, type FieldCrypto, type RedisHandle } from '../../platform/index.ts';
import { createBindPhoneService, type BindPhoneResult } from './bind-phone.ts';
import { phoneChangeBinding } from './phone-change-binding.ts';
import type { JudgedStepUp } from './step-up-verify.ts';

const APP = 'couli';
const USER = '019a0000-0000-7000-8000-0000000000a1';
const SID = 'sid-of-this-request';
const OLD_HMAC = 'hmac:13900000000';
const JTI = '019a0000-0000-7000-8000-0000000000f1';

interface Scenario {
  /** The request's session row under the lock: live, revoked or gone. */
  readonly session: 'live' | 'revoked' | 'none';
  /** What ⑫ passed in this request (null: nothing judged). */
  readonly stepUp: JudgedStepUp | null;
}

interface Run {
  readonly result: BindPhoneResult;
  readonly queries: readonly CompiledQuery[];
  readonly smsCalls: number;
  readonly switchCalls: number;
}

function judged(overrides: Partial<JudgedStepUp> = {}): JudgedStepUp {
  return {
    action: 'phone_change',
    jti: JTI,
    phone_binding: phoneChangeBinding(JTI, OLD_HMAC),
    ...overrides,
  };
}

async function run(scenario: Scenario): Promise<Run> {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      const text = query.sql;
      if (text.includes('from "app"."users"') && text.endsWith('for update')) {
        return Promise.resolve({
          rows: [
            {
              phone_hmac: OLD_HMAC,
              phone_cipher: Buffer.from('enc:13900000000', 'utf8'),
              register_method: 'sms',
              parent_id: null,
              status: 'normal',
              row_version: 4,
            },
          ],
        } as QueryResult<R>);
      }
      if (text.includes('from "app"."sessions"')) {
        const rows =
          scenario.session === 'none'
            ? []
            : [
                {
                  revoked_at:
                    scenario.session === 'revoked' ? new Date('2026-10-31T00:00:00Z') : null,
                },
              ];
        return Promise.resolve({ rows } as QueryResult<R>);
      }
      throw new Error(`unexpected query: ${text}`);
    },
    async *streamQuery() {
      throw new Error('streamQuery is not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
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
  const verifyAndConsume = vi.fn(async () => ({ code: 20002 as const }));
  const enabled = vi.fn(async () => true);
  const service = createBindPhoneService({
    clock: new FixedClock('2026-10-31T00:00:00Z'),
    crypto: {
      blindIndex: (value: string) => `hmac:${value}`,
      encrypt: (value: string) => `enc:${value}`,
      decrypt: (value: string) => value.replace(/^enc:/, ''),
    } as unknown as FieldCrypto,
    redis: {} as RedisHandle,
    sms: { verifyAndConsume },
    blocklist: null,
    risk: { isBanned: () => Promise.resolve(false) },
    assets: {
      countOrders: () => Promise.resolve(0),
      hasClaims: () => Promise.resolve(false),
      hasLedgerEntries: () => Promise.resolve(false),
    },
    barriers: {
      hasAdjustments: () => Promise.resolve(false),
      hasDisabledBindings: () => Promise.resolve(false),
    },
    change: {
      switch: { enabled },
      revokeOthers: () => Promise.reject(new Error('revokeOthers must not run')),
      audit: { appendAction: () => Promise.reject(new Error('audit must not run')) },
    },
  });
  const result = await db.transaction().execute((trx) =>
    service.bind(trx, {
      app_id: APP,
      user_id: USER,
      device_id: 'device-1',
      sid: SID,
      step_up: scenario.stepUp,
      body: { phone: '13800000002', code: '123456' },
    }),
  );
  return {
    result,
    queries,
    smsCalls: verifyAndConsume.mock.calls.length,
    switchCalls: enabled.mock.calls.length,
  };
}

function onlyReads(queries: readonly CompiledQuery[]): void {
  for (const query of queries) expect(query.sql).toMatch(/^select /);
}

it('[B1-20b][Codex money r1 S0 #1] 锁外读到未绑号（⑫ 未核令牌）、锁内已有号：按锁内判为换号，无已核 phone_change 令牌 → 10003，不核 bind 码、不写库', async () => {
  const { result, queries, smsCalls, switchCalls } = await run({ session: 'live', stepUp: null });
  expect(result).toEqual({ code: 10003 });
  expect(smsCalls).toBe(0);
  expect(switchCalls).toBe(0);
  onlyReads(queries);
  expect(queries[0]?.sql).toMatch(/for update$/);
});

it('[B1-20b][Codex money r1 S0 #1] ⑫ 通过的不是 phone_change 令牌（另一 action）→ 10003，不核码、不写库', async () => {
  const { result, queries, smsCalls } = await run({
    session: 'live',
    stepUp: judged({ action: 'account_deletion' }),
  });
  expect(result).toEqual({ code: 10003 });
  expect(smsCalls).toBe(0);
  onlyReads(queries);
});

it('[B1-20b][Codex money r1 S0 #2] 令牌验证的旧号与锁内当前号不一致（签发后号码已被另一笔换掉）或令牌无绑定声明 → 10003，不核码、不写库', async () => {
  for (const stepUp of [
    judged({ phone_binding: phoneChangeBinding(JTI, 'hmac:13700000000') }),
    judged({ phone_binding: phoneChangeBinding('another-jti', OLD_HMAC) }),
    judged({ phone_binding: null }),
  ]) {
    const { result, queries, smsCalls } = await run({ session: 'live', stepUp });
    expect(result).toEqual({ code: 10003 });
    expect(smsCalls).toBe(0);
    onlyReads(queries);
  }
});

it('[B1-20b][Codex money r1 S0 #2] 锁内发起会话已被吊销或不存在 → 10002（被吊销会话的现有码），先于令牌判定，不核码、不写库', async () => {
  for (const session of ['revoked', 'none'] as const) {
    const { result, queries, smsCalls, switchCalls } = await run({ session, stepUp: judged() });
    expect(result).toEqual({ code: 10002 });
    expect(smsCalls).toBe(0);
    expect(switchCalls).toBe(0);
    onlyReads(queries);
    const sessionQuery = queries.find((query) => query.sql.includes('from "app"."sessions"'));
    expect(sessionQuery?.parameters).toEqual(expect.arrayContaining([APP, SID, USER]));
    expect(queries.indexOf(sessionQuery!)).toBeGreaterThan(0);
  }
});

it('[B1-20b][Codex money r1 S0 #1 / #2] 会话有效且令牌绑定锁内当前号：守卫放行，才轮到开关与新号 bind 码', async () => {
  const { result, smsCalls, switchCalls } = await run({ session: 'live', stepUp: judged() });
  expect(result).toEqual({ code: 20002 });
  expect(switchCalls).toBe(1);
  expect(smsCalls).toBe(1);
});
