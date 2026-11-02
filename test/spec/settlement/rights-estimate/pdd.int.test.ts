// B2-03r · 拼多多（BR-CALC-03：N = 佣金 − 技术服务费，服务费缺失是未知，不是 0）：缺服务费时 bases.after 为 null，
// R7 不推版本（推了也写不出金额行，钱包会因当前版本没有行而抛错）；有服务费时新版本按减服务费后的 N。
// 拼多多钱包口径不断言金额（FU-PDD-NET-N），这里只断言不抛错。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  T1,
  T2,
  TIMEOUT,
  amountsAt,
  databaseFixture,
  harness,
  storedVersions,
  totalsAt,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it(
  '[AC-B2-03r#15] 拼多多 R7：缺服务费的单不推版本、不写新行、不抛错，迁移照常记 R7，钱包读取不抛错；同批有服务费的单（佣金 1200、服务费 200、应扣 400）推到 v2，金额行按 1200 − 400 − 200 = 600：510 → 255 / 51 / 25',
  async () => {
    const h = await harness(p.db);
    const missing = await h.estimated({
      platform: 'pdd',
      estFen: 1200n,
      patch: { service_fee_fen: null },
    });
    const known = await h.estimated({
      platform: 'pdd',
      estFen: 1200n,
      patch: { service_fee_fen: 200n },
    });

    await h.deduct(missing, 400n);
    await h.deduct(known, 400n);

    expect(await h.read(missing)).toMatchObject({
      rebate_status: 'ESTIMATED',
      commission_version: 1,
      est_commission_fen: 1200n,
    });
    expect(await storedVersions(p.db, missing)).toEqual({ amounts: [1], totals: [1] });
    expect(await h.rebateHistory(missing)).toEqual([
      { event: 'RIGHTS_PARTIAL', from_status: 'ESTIMATED', to_status: 'ESTIMATED' },
    ]);
    await expect(h.walletOf(missing.user('self'))).resolves.toBeDefined();

    expect((await h.read(known)).commission_version).toBe(2);
    expect(await amountsAt(p.db, known, 2)).toEqual([
      ['self', 510n, 255n],
      ['direct', 510n, 51n],
      ['indirect', 510n, 25n],
    ]);
    expect(await totalsAt(p.db, known, 2)).toMatchObject({ n_total_fen: 600n, base_fen: 510n });
  },
  TIMEOUT,
);

it(
  '[AC-B2-03r#30] 拼多多有服务费的单比的是减服务费后的 N：佣金 1200、服务费 200，应扣 0，净 N 1000 等于当前 N，不推版本；再扣 400 才到 v2，n_total 600',
  async () => {
    const h = await harness(p.db);
    const o = await h.estimated({
      platform: 'pdd',
      estFen: 1200n,
      patch: { service_fee_fen: 200n },
    });

    await h.deduct(o, 0n, 'rights-1', T1);

    expect((await h.read(o)).commission_version).toBe(1);
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1], totals: [1] });

    await h.deduct(o, 400n, 'rights-2', T2);

    expect((await h.read(o)).commission_version).toBe(2);
    expect(await totalsAt(p.db, o, 2)).toMatchObject({ n_total_fen: 600n, base_fen: 510n });
  },
  TIMEOUT,
);
