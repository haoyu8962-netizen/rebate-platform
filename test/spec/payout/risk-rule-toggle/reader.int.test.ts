// B2-11f: risk's blocklist match reader skips the dimensions whose rule is disabled (BR-ID-36 细则
// 「规则清单的启停」, D10-537 ②, D10-566 ②): the status is read through the caller's handle before each
// dimension, a disabled one is skipped and the next one still decides, a failed read is thrown and
// never counts as disabled, and the answer follows the configuration items' cache period. Every test
// starts with what the reader does not do yet, so each is red on that assertion before the
// implementation; what already holds (an enabled rule still hits) comes after it in the same test.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createRiskRuleStatusReader } from '../../../../apps/api/src/modules/risk/application/risk-rule-status.ts';
import { TIMEOUT, close, open, type Harness } from '../apply/kit.ts';
import {
  AT,
  DIMENSIONS,
  RULE_OF,
  TTL_MS,
  VALUES,
  matchReader,
  recording,
  seedMember,
  setRule,
  settled,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

/** A status reader with no pool of its own: any read not given a handle throws. */
function statusReader(clock: FixedClock) {
  return createRiskRuleStatusReader({ clock });
}

it.each(DIMENSIONS)(
  '[AC-B2-11f#1] %s：规则停用时该维度有生效黑名单行也不命中；enabled、active、无规则行以及其他维度全停用时都命中',
  async (dimension) => {
    const clock = new FixedClock(AT);
    const off = await seedMember(h.db, clock.now());
    await off.block(dimension);
    await off.setRule(dimension, 'disabled');
    expect(await matchReader(statusReader(clock)).read(h.db, off.subject(dimension))).toBeNull();

    for (const status of ['enabled', 'active', null] as const) {
      const on = await seedMember(h.db, clock.now());
      await on.block(dimension);
      if (status !== null) await on.setRule(dimension, status);
      expect(await matchReader(statusReader(clock)).read(h.db, on.subject(dimension))).toEqual({
        risk_msg_code: 'blocklist.other',
      });
    }

    const others = await seedMember(h.db, clock.now());
    await others.block(dimension);
    for (const other of DIMENSIONS) {
      if (other !== dimension) await others.setRule(other, 'disabled');
    }
    expect(await matchReader(statusReader(clock)).read(h.db, others.subject(dimension))).toEqual({
      risk_msg_code: 'blocklist.other',
    });
  },
);

it('[AC-B2-11f#2] 跳过后继续：phone 停用且命中、device 启用且命中 → device 那条的 risk_msg_code（形状不变）；phone 启用时仍是 phone；命中的维度全停用 → null', async () => {
  const clock = new FixedClock(AT);
  const skipped = await seedMember(h.db, clock.now());
  await skipped.block('phone', 'malicious_rights');
  await skipped.block('device', 'fraud_invite');
  await skipped.setRule('phone', 'disabled');
  expect(await matchReader(statusReader(clock)).read(h.db, skipped.subject())).toEqual({
    risk_msg_code: 'blocklist.fraud_invite',
  });

  const payee = await seedMember(h.db, clock.now());
  await payee.block('phone', 'malicious_rights');
  await payee.block('id_no', 'fraud_invite');
  await payee.block('alipay', 'other');
  await payee.setRule('phone', 'disabled');
  await payee.setRule('id_no', 'disabled');
  expect(await matchReader(statusReader(clock)).read(h.db, payee.subject())).toEqual({
    risk_msg_code: 'blocklist.other',
  });

  const first = await seedMember(h.db, clock.now());
  await first.block('phone', 'malicious_rights');
  await first.block('device', 'fraud_invite');
  await first.setRule('phone', 'enabled');
  expect(await matchReader(statusReader(clock)).read(h.db, first.subject())).toEqual({
    risk_msg_code: 'blocklist.malicious_rights',
  });

  const none = await seedMember(h.db, clock.now());
  await none.block('phone', 'malicious_rights');
  await none.block('device', 'fraud_invite');
  await none.setRule('phone', 'disabled');
  await none.setRule('device', 'disabled');
  expect(await matchReader(statusReader(clock)).read(h.db, none.subject())).toBeNull();
});

it('[AC-B2-11f#3] READ ONLY 事务里能跑：状态只经调用方句柄读，每个维度一次', async () => {
  const clock = new FixedClock(AT);
  const m = await seedMember(h.db, clock.now());
  await m.block('phone');
  await m.setRule('phone', 'disabled');
  const { rules, reads } = recording(statusReader(clock));
  await h.db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    expect(await matchReader(rules).read(trx, m.subject())).toBeNull();
    expect(reads.map((read) => read.ruleKey)).toEqual(
      expect.arrayContaining(
        (['phone', 'id_no', 'device', 'alipay'] as const).map((dimension) => ({
          app_id: m.appId,
          rule_id: RULE_OF[dimension],
        })),
      ),
    );
    expect(reads).toHaveLength(4);
    expect(reads.every((read) => read.executor === trx)).toBe(true);
  });
});

it('[AC-B2-11f#4] 调用方事务里未提交的停用行可见（状态确实读自调用方句柄）；回滚后同一规则按无行生效', async () => {
  const clock = new FixedClock(AT);
  const m = await seedMember(h.db, clock.now());
  await m.block('phone');
  const rollback = new Error('synthetic rollback');
  let inside: unknown;
  await h.db
    .transaction()
    .execute(async (trx) => {
      await setRule(trx, m.appId, RULE_OF.phone, 'disabled', clock.now());
      inside = await matchReader(statusReader(clock)).read(trx, m.subject());
      throw rollback;
    })
    .catch((error: unknown) => {
      if (error !== rollback) throw error;
    });
  expect(inside).toBeNull();
  expect(await matchReader(statusReader(clock)).read(h.db, m.subject())).toEqual({
    risk_msg_code: 'blocklist.other',
  });
});

it('[AC-B2-11f#5] 读状态抛错原样抛出，不当作停用：不返回 null，也不返回命中', async () => {
  const clock = new FixedClock(AT);
  const m = await seedMember(h.db, clock.now());
  await m.block('phone');
  const boom = new Error('synthetic status failure');
  const failing = matchReader({
    isEnabled: async () => {
      throw boom;
    },
  });
  const outcome = await settled(() => failing.read(h.db, m.subject()));
  expect(outcome).toEqual({ ok: false, error: boom });

  // A later dimension's failure too: phone has no row, id_no's status cannot be read.
  const later = await seedMember(h.db, clock.now());
  await later.block('device');
  const inner = statusReader(clock);
  const partly = matchReader({
    isEnabled: async (ruleKey, executor) => {
      if (ruleKey.rule_id === RULE_OF.id_no) throw boom;
      return inner.isEnabled(ruleKey, executor);
    },
  });
  expect(await settled(() => partly.read(h.db, later.subject()))).toEqual({
    ok: false,
    error: boom,
  });
});

it('[AC-B2-11f#6] 启用→停用：周期内按旧状态仍命中（不追溯），满一个配置项周期才生效；再启用同样隔一个周期', async () => {
  const clock = new FixedClock(AT);
  const m = await seedMember(h.db, clock.now());
  await m.block('phone');
  await m.setRule('phone', 'enabled');
  const reader = matchReader(statusReader(clock));
  const hit = { risk_msg_code: 'blocklist.other' };
  expect(await reader.read(h.db, m.subject())).toEqual(hit);

  await m.setRule('phone', 'disabled');
  expect(await reader.read(h.db, m.subject())).toEqual(hit);
  clock.advanceMs(TTL_MS - 1);
  expect(await reader.read(h.db, m.subject())).toEqual(hit);
  clock.advanceMs(1);
  expect(await reader.read(h.db, m.subject())).toBeNull();

  await m.setRule('phone', 'enabled');
  expect(await reader.read(h.db, m.subject())).toBeNull();
  clock.advanceMs(TTL_MS);
  expect(await reader.read(h.db, m.subject())).toEqual(hit);
});

it('[AC-B2-11f#7] 停用→启用：周期内仍不命中，满一个配置项周期才恢复命中', async () => {
  const clock = new FixedClock(AT);
  const m = await seedMember(h.db, clock.now());
  await m.block('phone');
  await m.setRule('phone', 'disabled');
  const reader = matchReader(statusReader(clock));
  expect(await reader.read(h.db, m.subject())).toBeNull();

  await m.setRule('phone', 'enabled');
  clock.advanceMs(TTL_MS - 1);
  expect(await reader.read(h.db, m.subject())).toBeNull();
  clock.advanceMs(1);
  expect(await reader.read(h.db, m.subject())).toEqual({ risk_msg_code: 'blocklist.other' });
});

it('[AC-B2-11f#8] 读状态失败时错误不带手机号摘要、收款账号摘要等主体值（BR-ID-33）', async () => {
  const clock = new FixedClock(AT);
  const m = await seedMember(h.db, clock.now());
  await m.block('phone');
  const failing = matchReader({
    isEnabled: async () => {
      throw new Error('synthetic status failure');
    },
  });
  const outcome = await settled(() => failing.read(h.db, m.subject()));
  expect(outcome.ok).toBe(false);
  const text = outcome.ok ? '' : String(outcome.error);
  for (const digest of [VALUES.phone, VALUES.id_no, VALUES.device, VALUES.alipay]) {
    expect(text.includes(digest)).toBe(false);
  }
});
