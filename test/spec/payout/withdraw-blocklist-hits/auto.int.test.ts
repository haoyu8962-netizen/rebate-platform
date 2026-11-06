import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { AutoPayoutOptions } from '../../../../apps/api/src/modules/payout/application/auto-payout.ts';
import type { RiskRuleStatusReaderOptions } from '../../../../apps/api/src/modules/risk/application/risk-rule-status.ts';
import { assembled } from '../../notification/risk-state-message/worker-kit.ts';
import { setup, fenced, type AutoFixture } from '../auto-payout/kit.ts';
import { close, hits, identity, open, rule, seedBlock, type Harness } from './db-kit.ts';

// Capture the actual worker factory arguments: tests exercise AppModule's all-session device
// lookup and risk writer wiring. Only identity's adult/decryption port and external execution
// are supplied by the existing auto-payout kit; no fake matcher or fake hit writer.
const capture = vi.hoisted(() => ({
  options: null as AutoPayoutOptions | null,
  reads: [] as string[],
}));
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
          async isEnabled(...args: Parameters<typeof reader.isEnabled>) {
            capture.reads.push(`${args[0].app_id}:${args[0].rule_id}`);
            return reader.isEnabled(...args);
          },
        };
      },
    };
  },
);
vi.mock('../../../../apps/api/src/modules/payout/application/auto-payout.ts', async (original) => {
  const actual =
    await original<
      typeof import('../../../../apps/api/src/modules/payout/application/auto-payout.ts')
    >();
  return {
    ...actual,
    createAutoPayoutConsumer(options: AutoPayoutOptions) {
      capture.options = options;
      return actual.createAutoPayoutConsumer(options);
    },
  };
});

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, 60_000);

async function worker(f: AutoFixture) {
  capture.options = null;
  const app = await assembled('worker', h.db, f.clock);
  try {
    expect(capture.options).not.toBeNull();
    const options = capture.options!;
    return {
      app,
      options,
      consumer: f.consumer({ ...options, adult: f.options.adult, execute: f.options.execute }),
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function seed(
  f: AutoFixture,
  dimension: 'phone' | 'id_no' | 'device' | 'alipay' | 'bank_card',
) {
  const values = await identity(f);
  // D10-571: the account has no current-device restriction; a revoked historical session counts.
  await sql`INSERT INTO app.sessions (id,app_id,sid,user_id,device_id,revoked_at,revoke_reason)
    VALUES (${randomUUID()},${f.appId},${randomUUID()},${f.actor.userId},${f.actor.deviceId},
      ${f.clock.now()},'logout')`.execute(h.db);
  await seedBlock(h.db, f.appId, dimension, values[dimension], f.clock, {
    expires: new Date('2027-01-01T00:00:00Z'),
  });
  return {
    dimension,
    value_hmac: values[dimension],
    rule_id: `BLACKLIST_${dimension.toUpperCase()}`,
  };
}

function expected(
  f: AutoFixture,
  id: string,
  target: { dimension: string; value_hmac: string; rule_id: string },
) {
  return expect.objectContaining({
    app_id: f.appId,
    user_id: f.actor.userId,
    ...target,
    ref_type: 'withdrawal',
    ref_id: id,
    risk_action: 'manual_review',
    request_type: null,
    amount_fen: null,
    related_phone_hmac: null,
    related_phone_masked: null,
    created_at: f.clock.now(),
  });
}

it.each(['phone', 'id_no', 'device', 'alipay', 'bank_card'] as const)(
  '[AC-B2-05q#20][BR-WDR-29][BR-ID-36] 申请后 %s 命中：worker 实际装配转人工、同事务记一条，不退款不发款',
  async (dimension) => {
    const f = await setup(h, { method: dimension === 'bank_card' ? 'bank_card' : 'alipay' });
    const id = await f.start(100n);
    const target = await seed(f, dimension);
    const balances = await f.ledger.getBalances(h.db, {
      appId: f.appId,
      userIds: [f.actor.userId],
    });
    const w = await worker(f);
    try {
      await w.consumer.consume(await f.event(id));
      expect(await f.row(id)).toMatchObject({
        status: 'PENDING_REVIEW',
        review_mode: 'manual',
        auto_decision: {
          result: 'manual',
          failed_conditions: expect.arrayContaining(['risk_flag:blacklist_hit']),
        },
      });
      expect(await hits(h, f.appId)).toEqual([expected(f, id, target)]);
      expect(
        await f.ledger.getBalances(h.db, { appId: f.appId, userIds: [f.actor.userId] }),
      ).toEqual(balances);
      expect(f.execute).not.toHaveBeenCalled();
      expect(await f.approvals(id)).toEqual([]);
      expect(JSON.stringify((await f.row(id)).auto_decision)).not.toContain(target.value_hmac);
    } finally {
      await w.app.close();
    }
  },
);

it('[AC-B2-05q#21][BR-ID-36] ⑨ 无命中、停用无记录；同规则启用后下一单才转人工并记录', async () => {
  const f = await setup(h);
  const clean = await f.start(100n);
  const w = await worker(f);
  try {
    await w.consumer.consume(await f.event(clean));
    expect(await hits(h, f.appId)).toEqual([]);
    expect((await f.row(clean)).auto_decision).toMatchObject({ result: 'auto' });
    const disabled = await f.start(100n);
    const target = await seed(f, 'phone');
    await rule({ db: h.db, clock: f.clock }, f.appId, 'phone', 'disabled');
    f.clock.advanceMs(60_001);
    await w.consumer.consume(await f.event(disabled));
    expect(await hits(h, f.appId)).toEqual([]);
    expect((await f.row(disabled)).auto_decision).toMatchObject({
      failed_conditions: expect.not.arrayContaining(['risk_flag:blacklist_hit']),
    });
    await rule({ db: h.db, clock: f.clock }, f.appId, 'phone', 'enabled');
    f.clock.advanceMs(60_001);
    const blocked = await f.start(100n);
    await w.consumer.consume(await f.event(blocked));
    expect(await hits(h, f.appId)).toEqual([expected(f, blocked, target)]);
  } finally {
    await w.app.close();
  }
});

it('[AC-B2-05q#22][BR-ID-36] 判定事务回滚撤回命中；重投后判定、命中及事件认领一起提交', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  const target = await seed(f, 'phone');
  const event = await f.event(id);
  const before = await f.row(id);
  const w = await worker(f);
  const abort = new Error('synthetic decision abort');
  try {
    await expect(
      h.db.transaction().execute(async (trx) => {
        await w.consumer.handle(event, trx);
        expect(await hits({ db: trx }, f.appId)).toEqual([expected(f, id, target)]);
        expect(await hits({ db: h.observer }, f.appId)).toEqual([]);
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(await hits(h, f.appId)).toEqual([]);
    expect(await f.row(id)).toEqual(before);
    expect(await f.claims(event.eventId)).toEqual([]);
    await w.consumer.consume(event);
    expect(await hits(h, f.appId)).toEqual([expected(f, id, target)]);
    expect(await f.claims(event.eventId)).toHaveLength(1);
  } finally {
    await w.app.close();
  }
});

it('[AC-B2-05q#23][BR-ID-36] 同事件重投、同单不同事件及并发判定，至多一条命中', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  const target = await seed(f, 'phone');
  const first = await f.event(id);
  const second = await f.event(id);
  const w = await worker(f);
  try {
    const result = await fenced(
      h,
      (trx) => w.consumer.handle(first, trx),
      () => w.consumer.consume(second),
    );
    expect(result.waited).toBe(true);
    await w.consumer.consume(first);
    await w.consumer.consume(second);
    expect(await hits(h, f.appId)).toEqual([expected(f, id, target)]);
    expect(f.execute).not.toHaveBeenCalled();
  } finally {
    await w.app.close();
  }
});

it('[AC-B2-05q#24][BR-ID-36] ⑨ 判定后规则停用仍留本次命中，不二次判定、不把规则重新启用', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  const target = await seed(f, 'phone');
  await rule({ db: h.db, clock: f.clock }, f.appId, 'phone', 'enabled');
  const w = await worker(f);
  try {
    expect(w.options.blacklist.match).toBeTypeOf('function');
    const original = w.options.blacklist.match!.bind(w.options.blacklist);
    const read = vi.fn(async (...args: Parameters<typeof original>) => {
      const matched = await original(...args);
      await rule({ db: h.db, clock: f.clock }, f.appId, 'phone', 'disabled');
      f.clock.advanceMs(60_001);
      return matched;
    });
    const consumer = f.consumer({
      ...w.options,
      adult: f.options.adult,
      execute: f.options.execute,
      blacklist: {
        hit: w.options.blacklist.hit.bind(w.options.blacklist),
        match: read,
      },
    });
    await consumer.consume(await f.event(id));
    expect(read).toHaveBeenCalledTimes(1);
    expect(capture.reads.filter((value) => value === `${f.appId}:BLACKLIST_PHONE`)).toHaveLength(1);
    const rows = await hits(h, f.appId);
    expect(rows).toEqual([
      expect.objectContaining({ ...target, ref_id: id, risk_action: 'manual_review' }),
    ]);
    expect(
      await h.db
        .withSchema('app')
        .selectFrom('risk_rules')
        .select('status')
        .where('app_id', '=', f.appId)
        .where('rule_id', '=', target.rule_id)
        .execute(),
    ).toEqual([{ status: 'disabled' }]);
  } finally {
    await w.app.close();
  }
});
