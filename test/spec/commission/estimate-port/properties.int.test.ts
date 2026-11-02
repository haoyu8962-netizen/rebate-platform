// B2-03q 属性：任意有效佣金（结算优先）、预留、淘礼金扣除、补贴、受益比例，refresh 写出的版本都满足 BR-CALC-02 /
// 04 的公式与 BR-CALC-27 的四段关系。oracle 按规则写（baseOf、shareOf），不调 splitCommission。
// 金额覆盖 0、1、奇数、大于 2^31 四档（规划/11 §4.3）。属性体返回布尔，fc.assert 之外只做一次汇总断言。
// 次数与种子只来自 @couli/testing。
import { isDeepStrictEqual } from 'node:util';
import { createTestDatabase } from '@couli/db/testing';
import { addFen, subFen } from '@couli/money';
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { baseOf, shareOf } from '../../settlement/credit/kit.ts';
import { amountsAt, databaseFixture, fixture, storedVersions, totalsAt } from './kit.ts';

const p = databaseFixture(createTestDatabase);

const ABOVE_INT4 = 2n ** 31n;
const TOP = 2n ** 40n;

const commissionFen = fc.oneof(
  fc.constant(0n),
  fc.constant(1n),
  fc.bigInt({ min: -1000n, max: -1n }),
  fc.bigInt({ min: 0n, max: ABOVE_INT4 }).map((n) => n * 2n + 1n),
  fc.bigInt({ min: ABOVE_INT4 + 1n, max: TOP }),
);
const addedFen = fc.oneof(fc.constant(0n), fc.bigInt({ min: 1n, max: TOP }));

const scenario = fc.record({
  est: commissionFen,
  settle: fc.option(commissionFen, { nil: null }),
  reserveBp: fc.integer({ min: 0, max: 10000 }),
  tlj: addedFen,
  subsidy: addedFen,
  redpacket: fc.option(addedFen, { nil: null }),
  own: fc.integer({ min: 0, max: 6000 }),
  direct: fc.integer({ min: 0, max: 1500 }),
  indirect: fc.integer({ min: 0, max: 500 }),
});

it('[AC-B2-03q#51][BR-CALC-02][BR-CALC-27] 属性：refresh 写出的金额行与 totals 等于规则推出的值，四段金额互相对得上', async () => {
  const f = await fixture(p.db);
  const runs = Math.max(10, Math.floor(propRuns() / 100));
  let seen = 0;
  let mismatch: unknown = null;
  await fc.assert(
    fc.asyncProperty(scenario, async (s) => {
      const people = [
        { role: 'self' as const, ratioBp: s.own },
        { role: 'direct' as const, ratioBp: s.direct },
        { role: 'indirect' as const, ratioBp: s.indirect },
      ];
      const o = await f.order({
        people,
        reserveBp: s.reserveBp,
        tljDeductFen: s.tlj,
        subsidyFen: s.subsidy,
        redpacketFen: s.redpacket,
        rebateMode: s.tlj > 0n ? 'normal' : null,
        settleFen: s.settle,
        estFen: addFen(s.est, 1n),
      });
      await f.move(o, { estAfter: s.est });

      await f.refresh(o);

      const n = s.settle ?? s.est;
      const { base } = baseOf(n, s.reserveBp, s.tlj);
      const amounts = people.map((person) => shareOf(base, person.ratioBp));
      const userTotal = amounts.reduce((sum, a) => addFen(sum, a), 0n);
      const nTotal = addFen(n, s.subsidy);
      const expected = {
        amounts: people.map((person, i) => [person.role, base, amounts[i]]),
        totals: {
          n_total_fen: nTotal,
          pre_base_deduct_fen: subFen(nTotal, base),
          base_fen: base,
          user_share_total_fen: userTotal,
          tlj_redpacket_fen: s.redpacket,
          platform_est_profit_fen:
            s.redpacket === null ? null : subFen(subFen(nTotal, userTotal), s.redpacket),
        },
        versions: { amounts: [1, 2], totals: [1, 2] },
      };
      const actual = {
        amounts: await amountsAt(p.db, o, 2),
        totals: await totalsAt(p.db, o, 2),
        versions: await storedVersions(p.db, o),
      };
      seen += 1;
      const same = isDeepStrictEqual(actual, expected);
      if (!same) mismatch ??= { scenario: s, actual, expected };
      return same;
    }),
    { numRuns: runs, seed: propSeed() },
  );
  expect({ seen, mismatch }).toEqual({ seen: runs, mismatch: null });
}, 900_000);
