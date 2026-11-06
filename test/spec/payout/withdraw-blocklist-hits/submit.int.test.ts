import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type {
  BlocklistOptions,
  BlocklistService,
} from '../../../../apps/api/src/modules/risk/application/blocklist.ts';
import type { RiskRuleStatusReaderOptions } from '../../../../apps/api/src/modules/risk/application/risk-rule-status.ts';
import { IDEMPOTENCY } from '../../../../apps/api/src/modules/platform/idempotency/token.ts';
import type { Idempotency } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import { assertContract } from '../rules/http-kit.ts';
import {
  PHONE,
  UUID_V7,
  client,
  close,
  hits,
  open,
  rule,
  seedBlock,
  type Kit,
} from './http-kit.ts';

// Instrument public ports without replacing their decisions or SQL. The observer is a separate
// connection; it checks the writer is entered only after the applying connection is released.
const audit = vi.hoisted(() => ({
  beforeWrite: null as (() => Promise<void>) | null,
  afterRead: null as ((app: string, ruleId: string) => Promise<void>) | null,
  reads: [] as string[],
}));
// The inherited HTTP kit requests max=12. Make the application pool a single connection:
// an independent hit transaction can succeed only once the request relinquishes that connection.
// The separate observer (max=2) never participates in application writes.
vi.mock('@couli/db', async (original) => {
  const actual = await original<typeof import('@couli/db')>();
  return {
    ...actual,
    createDb(options: Parameters<typeof actual.createDb>[0]) {
      return actual.createDb(options.max === 12 ? { ...options, max: 1 } : options);
    },
  };
});
vi.mock('../../../../apps/api/src/modules/risk/application/blocklist.ts', async (original) => {
  const actual =
    await original<
      typeof import('../../../../apps/api/src/modules/risk/application/blocklist.ts')
    >();
  return {
    ...actual,
    createBlocklistService(options: BlocklistOptions): BlocklistService {
      const service = actual.createBlocklistService(options);
      return {
        ...service,
        async recordHit(input) {
          await audit.beforeWrite?.();
          return service.recordHit(input);
        },
        async recordDecidedHit(input) {
          await audit.beforeWrite?.();
          return service.recordDecidedHit!(input);
        },
        async recordHits(request, rows) {
          await audit.beforeWrite?.();
          return service.recordHits(request, rows);
        },
      };
    },
  };
});
vi.mock(
  '../../../../apps/api/src/modules/risk/application/risk-rule-status.ts',
  async (original) => {
    const actual =
      await original<
        typeof import('../../../../apps/api/src/modules/risk/application/risk-rule-status.ts')
      >();
    return {
      ...actual,
      createRiskRuleStatusReader(options: RiskRuleStatusReaderOptions) {
        const reader = actual.createRiskRuleStatusReader(options);
        return {
          async isEnabled(
            input: { app_id: string; rule_id: string },
            executor?: Parameters<typeof reader.isEnabled>[1],
          ) {
            const enabled = await reader.isEnabled(input, executor);
            audit.reads.push(`${input.app_id}:${input.rule_id}`);
            await audit.afterRead?.(input.app_id, input.rule_id);
            return enabled;
          },
        };
      },
    };
  },
);

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
let observer: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  observer = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  kit = await open(database, redis);
}, 120_000);
afterEach(() => {
  audit.beforeWrite = null;
  audit.afterRead = null;
  audit.reads.length = 0;
});
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      if (observer !== undefined) await destroyDb(observer);
    } finally {
      try {
        await redis?.stop();
      } finally {
        await database?.drop();
      }
    }
  }
}, 60_000);

async function refused(response: Awaited<ReturnType<Awaited<ReturnType<typeof client>>['post']>>) {
  expect(response.statusCode).toBe(403);
  expect(response.json()).toEqual({
    code: 44001,
    msg: '操作未通过安全校验',
    data: { risk_msg_code: 'blocklist.fraud_invite' },
    trace_id: expect.any(String),
  });
  await assertContract(response, 'ErrorEnvelope');
}

it.each(['phone', 'id_no', 'device', 'alipay', 'bank_card'] as const)(
  '[AC-B2-05q#1][BR-ID-36][BR-WDR-03] %s 拦截：原应答、准确命中、申请回滚且释放连接后独立留痕',
  async (dimension) => {
    const c = await client(kit, dimension === 'bank_card' ? 'bank_card' : 'alipay');
    await seedBlock(kit.db, c.f.appId, dimension, c.values[dimension], kit.clock);
    const before = await c.state();
    const transactions: number[] = [];
    audit.beforeWrite = async () => {
      const result = await sql<{ n: string }>`SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND state = 'idle in transaction'`.execute(observer);
      transactions.push(Number(result.rows[0]!.n));
    };
    const response = await c.post();
    await refused(response);
    expect(await c.state()).toEqual(before);
    const rows = await hits(kit, c.f.appId);
    expect(rows).toEqual([
      expect.objectContaining({
        app_id: c.f.appId,
        user_id: c.f.uid,
        ref_type: 'blocked_request',
        request_type: 'withdraw',
        risk_action: 'block',
        dimension,
        value_hmac: c.values[dimension],
        rule_id: `BLACKLIST_${dimension.toUpperCase()}`,
        amount_fen: 1300n,
        related_phone_hmac: c.phoneHmac,
        related_phone_masked: '138****8000',
        created_at: kit.clock.now(),
      }),
    ]);
    expect(rows[0]!.ref_id).toMatch(UUID_V7);
    expect(transactions).toEqual([0]);
    expect(
      audit.reads.filter((value) => value === `${c.f.appId}:BLACKLIST_${dimension.toUpperCase()}`),
    ).toHaveLength(1);
    const text = kit.lines.join('\n') + response.body;
    for (const value of [PHONE, c.phoneHmac, c.values[dimension], c.deviceHash])
      expect(text).not.toContain(value);
  },
);

it('[AC-B2-05q#2][BR-ID-36] 同键两次被拦各有不同 ref_id，44001 不存档，重试金额分别保留', async () => {
  const c = await client(kit);
  await seedBlock(kit.db, c.f.appId, 'phone', c.phoneHmac, kit.clock);
  const before = await c.state();
  const requestId = randomUUID();
  await refused(await c.post(requestId, 1300));
  await refused(await c.post(requestId, 1700));
  const rows = await hits(kit, c.f.appId);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.amount_fen).sort()).toEqual([1300n, 1700n]);
  expect(new Set(rows.map((row) => row.ref_id)).size).toBe(2);
  for (const row of rows) expect(row.ref_id).toMatch(UUID_V7);
  expect(await c.state()).toEqual(before);
});

it.each(['device', 'alipay'] as const)(
  '[AC-B2-05q#3][BR-ID-36] 无手机号账号在身份等级 ⑧ 被 10005 拦下、不到 ③a 不留痕；绑回手机号同键重试才被 %s 拦截并留痕',
  async (dimension) => {
    const c = await client(kit);
    const originalPhone = await kit.db
      .withSchema('app')
      .selectFrom('users')
      .select(['phone_cipher', 'phone_hmac'])
      .where('app_id', '=', c.f.appId)
      .where('id', '=', c.f.uid)
      .executeTakeFirstOrThrow();
    await sql`UPDATE app.users SET phone_cipher=NULL, phone_hmac=NULL WHERE id=${c.f.uid}`.execute(
      kit.db,
    );
    await seedBlock(kit.db, c.f.appId, dimension, c.values[dimension], kit.clock);
    const before = await c.state();
    const requestId = randomUUID();
    const response = await c.post(requestId);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 10005, msg: '需要绑定手机号' });
    await assertContract(response, 'ErrorEnvelope');
    expect(await hits(kit, c.f.appId)).toEqual([]);
    expect(await c.state()).toEqual(before);

    await kit.db
      .withSchema('app')
      .updateTable('users')
      .set(originalPhone)
      .where('app_id', '=', c.f.appId)
      .where('id', '=', c.f.uid)
      .execute();
    await refused(await c.post(requestId));
    expect(await hits(kit, c.f.appId)).toEqual([
      expect.objectContaining({
        user_id: c.f.uid,
        amount_fen: 1300n,
        dimension,
        value_hmac: c.values[dimension],
        related_phone_hmac: c.phoneHmac,
        related_phone_masked: '138****8000',
        ref_type: 'blocked_request',
      }),
    ]);
    expect(await c.state()).toEqual(before);
  },
);

it('[AC-B2-05q#4][BR-ID-36] 不命中与规则停用均无留痕；同一规则启用并重新申请后才拦截留痕', async () => {
  const clean = await client(kit);
  expect((await clean.post()).json()).toMatchObject({ code: 0 });
  expect(await hits(kit, clean.f.appId)).toEqual([]);
  const c = await client(kit);
  await seedBlock(kit.db, c.f.appId, 'phone', c.phoneHmac, kit.clock, {
    expires: new Date('2027-01-01T00:00:00Z'),
  });
  await rule(kit, c.f.appId, 'phone', 'disabled');
  expect((await c.post()).json()).toMatchObject({ code: 0 });
  expect(await hits(kit, c.f.appId)).toEqual([]);
  await rule(kit, c.f.appId, 'phone', 'enabled');
  kit.clock.advanceMs(60_001);
  await refused(await c.post());
  expect(await hits(kit, c.f.appId)).toHaveLength(1);
});

it('[AC-B2-05q#5][BR-ID-36] 判定后规则立刻停用：不二读、不漏掉已作出的拦截，已有规则不被重新启用', async () => {
  const c = await client(kit);
  await seedBlock(kit.db, c.f.appId, 'phone', c.phoneHmac, kit.clock, {
    expires: new Date('2027-01-01T00:00:00Z'),
  });
  await rule(kit, c.f.appId, 'phone', 'enabled');
  let changed = false;
  audit.afterRead = async (app, ruleId) => {
    if (app !== c.f.appId || ruleId !== 'BLACKLIST_PHONE' || changed) return;
    changed = true;
    await rule({ db: observer, clock: kit.clock }, c.f.appId, 'phone', 'disabled');
    kit.clock.advanceMs(60_001);
  };
  await refused(await c.post());
  expect(changed).toBe(true);
  expect(await hits(kit, c.f.appId)).toHaveLength(1);
  expect(audit.reads.filter((value) => value === `${c.f.appId}:BLACKLIST_PHONE`)).toHaveLength(1);
  expect(
    await kit.db
      .withSchema('app')
      .selectFrom('risk_rules')
      .select('status')
      .where('app_id', '=', c.f.appId)
      .where('rule_id', '=', 'BLACKLIST_PHONE')
      .execute(),
  ).toEqual([{ status: 'disabled' }]);
});

it('[AC-B2-05q#6][BR-ID-36] 记录失败按 bind-phone 先例返回 5xx，仍不建单、不扣款、不缓存 44001', async () => {
  const c = await client(kit);
  await seedBlock(kit.db, c.f.appId, 'phone', c.phoneHmac, kit.clock);
  const before = await c.state();
  let calls = 0;
  audit.beforeWrite = async () => {
    calls += 1;
    throw new Error('synthetic audit unavailable');
  };
  const requestId = randomUUID();
  const response = await c.post(requestId);
  expect(response.statusCode).toBeGreaterThanOrEqual(500);
  expect(calls).toBe(1);
  expect(await hits(kit, c.f.appId)).toEqual([]);
  expect(await c.state()).toEqual(before);
  audit.beforeWrite = null;
  await refused(await c.post(requestId));
  expect(await hits(kit, c.f.appId)).toHaveLength(1);
});

it('[AC-B2-05q#7][BR-ID-36] 仅本次处理器的 44001 记命中，幂等层直接应答不得复用上次的命中目标', async () => {
  const c = await client(kit);
  await seedBlock(kit.db, c.f.appId, 'phone', c.phoneHmac, kit.clock);
  const first = await c.post();
  await refused(first);
  const before = await hits(kit, c.f.appId);
  expect(before).toHaveLength(1);
  const idempotency = kit.app.get<Idempotency>(IDEMPOTENCY);
  const spy = vi.spyOn(idempotency, 'executeInTransaction').mockResolvedValue({
    status: first.statusCode,
    body: first.body,
    source: 'idempotency',
  });
  try {
    await refused(await c.post());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await hits(kit, c.f.appId)).toEqual(before);
  } finally {
    spy.mockRestore();
  }
});
