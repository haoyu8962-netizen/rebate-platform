// B2-09m tax_ytd rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid, 08 BR-WDR-20 — a paid item adds amount_fen to cum_income_fen and tax_fen to
// cum_withheld_fen of the member's real-name identity, in the +08:00 calendar year of the withdrawal's
// created_at, not of paid_at. Requests go through the real admin entry (manual-paid-harness.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  approved,
  entryOf,
  expectItems,
  fixture,
  fixtureAt,
  paid,
  payee,
  seedTaxRow,
  suite,
  taxOf,
  taxRows,
  withOffset,
  withManualAdmin,
} from './manual-paid-harness.ts';

const s = suite();

it('[AC-B2-09m#8] 没有台账行时新建：年度 2026，SERVICE_FEE，身份是已核实名的 hmac，cum_income 12,560（amount，不是 net），cum_withheld 88；created_at、updated_at 是注入时钟', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);

    await expectItems(await h.manualPaid([entryOf(f, w)]), [paid(w.id)]);

    expect(await taxOf(f, who)).toEqual([
      {
        year: 2026,
        income_type: 'SERVICE_FEE',
        identity_hmac: who.hmac,
        cum_income_fen: 12_560n,
        cum_withheld_fen: 88n,
      },
    ]);
    const rows = await taxRows(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.created_at).toEqual(f.clock.now());
    expect(rows[0]?.updated_at).toEqual(f.clock.now());
  });
});

it('[AC-B2-09m#9] 已有台账行时累加：50,003 / 1,009 上加同一请求的两张单（12,560 / 88 与 5,003 / 41），得 67,566 / 1,138，仍只有一行；别的会员的行不动', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const bystander = await payee(f, h);
    await seedTaxRow(f, who, 2026, 50_003n, 1_009n);
    await seedTaxRow(f, bystander, 2026, 20_011n, 19n);
    const first = await approved(f, h, who);
    const second = await approved(f, h, who, { amount_fen: 5_003n, fee_fen: 13n, tax_fen: 41n });

    await expectItems(await h.manualPaid([entryOf(f, first), entryOf(f, second)]), [
      paid(first.id),
      paid(second.id),
    ]);

    expect(await taxOf(f, who)).toEqual([
      {
        year: 2026,
        income_type: 'SERVICE_FEE',
        identity_hmac: who.hmac,
        cum_income_fen: 67_566n,
        cum_withheld_fen: 1_138n,
      },
    ]);
    expect(await taxOf(f, bystander)).toEqual([
      {
        year: 2026,
        income_type: 'SERVICE_FEE',
        identity_hmac: bystander.hmac,
        cum_income_fen: 20_011n,
        cum_withheld_fen: 19n,
      },
    ]);
  });
});

it('[AC-B2-09m#10] 跨年单：created_at 2026-12-31 23:59 +08:00，paid_at 次年 00:10 +08:00：税年是 created_at 的 2026，不是 paid_at 的 2027；次年已有的台账行不动', async () => {
  const f = fixtureAt(s, '2026-12-31T16:20:00.000Z');
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    await seedTaxRow(f, who, 2027, 7_001n, 11n);
    const w = await approved(f, h, who, {
      created_at: new Date('2026-12-31T15:59:00.000Z'),
      updated_at: new Date('2026-12-31T15:59:00.000Z'),
    });
    const entry = entryOf(f, w, { paid_at: '2027-01-01T00:10:00+08:00' });

    await expectItems(await h.manualPaid([entry]), [paid(w.id)]);

    expect(await taxOf(f, who)).toEqual([
      {
        year: 2026,
        income_type: 'SERVICE_FEE',
        identity_hmac: who.hmac,
        cum_income_fen: 12_560n,
        cum_withheld_fen: 88n,
      },
      {
        year: 2027,
        income_type: 'SERVICE_FEE',
        identity_hmac: who.hmac,
        cum_income_fen: 7_001n,
        cum_withheld_fen: 11n,
      },
    ]);
  });
});

it('[AC-B2-09m#11] 税年按 +08:00：created_at 恰是 2027-01-01 00:00 +08:00（UTC 还在 2026）算 2027；早 1 毫秒算 2026', async () => {
  const f = fixtureAt(s, '2026-12-31T16:20:00.000Z');
  await withManualAdmin(f, async (h) => {
    const newYear = await payee(f, h);
    const lastYear = await payee(f, h);
    const midnight = new Date('2026-12-31T16:00:00.000Z');
    const justBefore = new Date('2026-12-31T15:59:59.999Z');
    const inNewYear = await approved(f, h, newYear, {
      created_at: midnight,
      updated_at: midnight,
    });
    const inLastYear = await approved(f, h, lastYear, {
      created_at: justBefore,
      updated_at: justBefore,
    });
    const paidAt = withOffset(new Date('2026-12-31T16:10:00.000Z'));

    await expectItems(
      await h.manualPaid([
        entryOf(f, inNewYear, { paid_at: paidAt }),
        entryOf(f, inLastYear, { paid_at: paidAt }),
      ]),
      [paid(inNewYear.id), paid(inLastYear.id)],
    );

    expect((await taxOf(f, newYear)).map((row) => row.year)).toEqual([2027]);
    expect((await taxOf(f, lastYear)).map((row) => row.year)).toEqual([2026]);
  });
});
