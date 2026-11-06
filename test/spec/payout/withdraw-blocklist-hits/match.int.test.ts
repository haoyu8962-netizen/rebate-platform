import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createBlocklistMatchReader,
  type RiskRuleStatusReader,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { close, fixture, hits, identity, open, seedBlock, type Harness } from './db-kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, 60_000);

it.each(['phone', 'id_no', 'device', 'alipay', 'bank_card', 'wechat_openid'] as const)(
  '[AC-B2-05q#10][BR-WDR-03][BR-ID-36] %s 只读匹配保留当次目标及原文案码；停用和异 app 不命中',
  async (dimension) => {
    const f = await fixture(h);
    const values = await identity(f);
    await seedBlock(h.db, f.actor.appId, dimension, values[dimension], f.clock);
    let enabled = false;
    const checks = vi.fn<RiskRuleStatusReader['isEnabled']>(async () => enabled);
    const reader = createBlocklistMatchReader({ rules: { isEnabled: checks } });
    const subject = {
      ...f.actor,
      payeeHmac: f.hmac,
      payoutMethod:
        dimension === 'bank_card'
          ? ('bank_card' as const)
          : dimension === 'wechat_openid'
            ? ('wechat' as const)
            : ('alipay' as const),
      now: f.clock.now(),
    };
    // A read-only PG transaction prevents a reader from quietly writing risk_hits or rules.
    await h.db
      .transaction()
      .setAccessMode('read only')
      .execute(async (trx) => {
        // read() is frozen: callers still receive only the message code, never the target.
        expect(await reader.read(trx, subject)).toBeNull();
        enabled = true;
        expect(await reader.read(trx, { ...subject, appId: 'another-app' })).toBeNull();
        expect(await reader.read(trx, subject)).toEqual({
          risk_msg_code: 'blocklist.fraud_invite',
        });
        // Missing optional capability must fail an assertion, never a TypeError.
        expect(reader.match).toBeTypeOf('function');
        enabled = false;
        expect(await reader.match!(trx, subject)).toBeNull();
        enabled = true;
        expect(await reader.match!(trx, { ...subject, appId: 'another-app' })).toBeNull();
        checks.mockClear();
        expect(await reader.match!(trx, subject)).toEqual({
          risk_msg_code: 'blocklist.fraud_invite',
          hit: {
            dimension,
            value_hmac: values[dimension],
            rule_id: `BLACKLIST_${dimension.toUpperCase()}`,
          },
        });
        expect(
          checks.mock.calls.filter(
            ([input]) => input.rule_id === `BLACKLIST_${dimension.toUpperCase()}`,
          ),
        ).toHaveLength(1);
        expect(checks.mock.calls.every(([, executor]) => executor === trx)).toBe(true);
      });
    expect(await hits(h, f.actor.appId)).toEqual([]);
    expect(
      await h.db
        .withSchema('app')
        .selectFrom('risk_rules')
        .selectAll()
        .where('app_id', '=', f.actor.appId)
        .execute(),
    ).toEqual([]);
  },
);

it('[AC-B2-05q#11][BR-WDR-03] 多维命中只选首个生效维度：phone → id_no → device → 收款账号', async () => {
  const f = await fixture(h);
  const values = await identity(f);
  const disabled = new Set<string>();
  const checks = vi.fn(async (input: { rule_id: string }) => !disabled.has(input.rule_id));
  const reader = createBlocklistMatchReader({ rules: { isEnabled: checks } });
  expect(reader.match).toBeTypeOf('function');
  const dimensions = ['phone', 'id_no', 'device', 'alipay'] as const;
  for (const dimension of dimensions)
    await seedBlock(h.db, f.actor.appId, dimension, values[dimension], f.clock);
  for (const dimension of dimensions) {
    checks.mockClear();
    expect(
      await reader.match!(h.db, {
        ...f.actor,
        payeeHmac: f.hmac,
        payoutMethod: 'alipay',
        now: f.clock.now(),
      }),
    ).toEqual({
      risk_msg_code: 'blocklist.fraud_invite',
      hit: {
        dimension,
        value_hmac: values[dimension],
        rule_id: `BLACKLIST_${dimension.toUpperCase()}`,
      },
    });
    expect(
      checks.mock.calls.filter(
        ([input]) => input.rule_id === `BLACKLIST_${dimension.toUpperCase()}`,
      ),
    ).toHaveLength(1);
    disabled.add(`BLACKLIST_${dimension.toUpperCase()}`);
  }
  expect(
    await reader.match!(h.db, {
      ...f.actor,
      payeeHmac: f.hmac,
      payoutMethod: 'alipay',
      now: f.clock.now(),
    }),
  ).toBeNull();
  expect(await hits(h, f.actor.appId)).toEqual([]);
});
