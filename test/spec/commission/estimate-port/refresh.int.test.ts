// B2-03q · refresh，ESTIMATED / WAITING（D10-565）：在调用方事务里对 orders 当前 commission_version 追加金额行
// 与 totals；比例、预留、淘礼金扣除、补贴取快照冻结值，N 取有效佣金（结算优先），forfeited 行 0、held 照算
// （BR-CALC-13、BR-CALC-27）；该版本已有行就不写；不补中间版本；不改余额、不写分录、不加版本号。
// 拼多多 N = 佣金 − 服务费，服务费缺失不写不抛错（同快照 pending），不按 0（BR-CALC-02、BR-CALC-03）。
// 默认单：预留 1500，self 5000 / direct 1000 / indirect 500。N=2000 → B=1700，850 / 170 / 85，合计 1105。
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  LATER,
  NOW,
  TIMEOUT,
  amountRows,
  amountsAt,
  commission,
  databaseFixture,
  fixture,
  frozenRows,
  moneyRows,
  storedVersions,
  syncColumns,
  totalsAt,
  totalsRows,
  tracing,
  type PersonInput,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

it.each(['ESTIMATED', 'WAITING'])(
  '[AC-B2-03q#13][BR-CALC-27] %s：按当前版本追加金额行与 totals，四段金额落齐，读取端口认这个版本',
  async (rebateStatus) => {
    const f = await fixture(p.db);
    const o = await f.order({ rebateStatus });
    await f.move(o, { estAfter: 2000n });

    await f.refresh(o);

    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 1700n, 850n],
      ['direct', 1700n, 170n],
      ['indirect', 1700n, 85n],
    ]);
    expect(await totalsAt(p.db, o, 2)).toEqual({
      n_total_fen: 2000n,
      pre_base_deduct_fen: 300n,
      base_fen: 1700n,
      user_share_total_fen: 1105n,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: 895n,
    });
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
    // 上一版本原样留着（只追加），当前版本读得出来。
    expect(await amountsAt(p.db, o, 1)).toEqual([
      ['self', 850n, 425n],
      ['direct', 850n, 85n],
      ['indirect', 850n, 42n],
    ]);
    const read = await p.db.transaction().execute((trx) =>
      commission.readCommissionSnapshot(trx, {
        appId: o.appId,
        orderId: o.orderId,
        commissionVersion: 2,
      }),
    );
    expect(read).toMatchObject({ commissionVersion: 2, baseFen: 1700n, reserveBp: 1500 });
  },
  TIMEOUT,
);

it('[AC-B2-03q#14][BR-CALC-02] 结算优先：有结算佣金时按结算额算，预估只存档', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    rebateStatus: 'WAITING',
    platformStatus: 'SETTLED',
    estFen: 1000n,
    settleFen: 2000n,
  });
  await f.move(o, { estAfter: 9999n });

  await f.refresh(o);

  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 1700n, 850n],
    ['direct', 1700n, 170n],
    ['indirect', 1700n, 85n],
  ]);
  expect(await totalsAt(p.db, o, 2)).toMatchObject({ n_total_fen: 2000n, base_fen: 1700n });
});

it('[AC-B2-03q#15][BR-CALC-02][BR-CALC-27] 冻结条款：预留、淘礼金扣除、补贴、比例都取快照值，淘礼金面额同上一版本，新规则进不来', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    reserveBp: 2000,
    tljDeductFen: 30n,
    subsidyFen: 111n,
    redpacketFen: 50n,
    rebateMode: 'normal',
  });
  // 新版本：预留 90%、本人 10%、间推关闭。
  await f.newerRules();
  await f.move(o, { estAfter: 2000n });
  const frozen = await frozenRows(p.db, o);

  await f.refresh(o);

  // 2000 × 80% = 1600，扣 30 → B=1570；785 / 157 / 78，合计 1020。
  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 1570n, 785n],
    ['direct', 1570n, 157n],
    ['indirect', 1570n, 78n],
  ]);
  // n_total = 2000 + 111；基数前扣除 = 2111 − 1570；利润 = 2111 − 1020 − 50。
  expect(await totalsAt(p.db, o, 2)).toEqual({
    n_total_fen: 2111n,
    pre_base_deduct_fen: 541n,
    base_fen: 1570n,
    user_share_total_fen: 1020n,
    tlj_redpacket_fen: 50n,
    platform_est_profit_fen: 1041n,
  });
  expect(await frozenRows(p.db, o)).toEqual(frozen);
});

it('[AC-B2-03q#16][BR-CALC-27] 淘礼金面额匹配不到：null 保持 null，利润也是 null，不按 0 算', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    rebateMode: 'none',
    redpacketFen: null,
    people: [{ role: 'self', ratioBp: 0 }],
  });
  await f.move(o, { estAfter: 2000n });

  await f.refresh(o);

  expect(await amountsAt(p.db, o, 2)).toEqual([['self', 1700n, 0n]]);
  expect(await totalsAt(p.db, o, 2)).toEqual({
    n_total_fen: 2000n,
    pre_base_deduct_fen: 300n,
    base_fen: 1700n,
    user_share_total_fen: 0n,
    tlj_redpacket_fen: null,
    platform_est_profit_fen: null,
  });
});

it('[AC-B2-03q#17][BR-CALC-13][BR-CALC-27] forfeited 份额 0、held 照算：初始没收与后来没收都留行，利润计入 held 不计 forfeited', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, initialStatus: 'forfeited' },
      { role: 'indirect', ratioBp: 500 },
    ],
  });
  await f.event(o, 'self', 'held', 'frozen');
  await f.event(o, 'indirect', 'forfeited', 'banned');
  await f.move(o, { estAfter: 2000n });

  await f.refresh(o);

  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 1700n, 850n],
    ['direct', 1700n, 0n],
    ['indirect', 1700n, 0n],
  ]);
  expect(await totalsAt(p.db, o, 2)).toMatchObject({
    user_share_total_fen: 850n,
    platform_est_profit_fen: 1150n,
  });
});

it('[AC-B2-03q#18][BR-CALC-13] 份额状态只看最新事件（D10-481 ②）：初始没收后恢复、没收后转 held 都照算', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, initialStatus: 'forfeited' },
      { role: 'indirect', ratioBp: 500 },
    ],
  });
  await f.event(o, 'direct', 'active', null);
  await f.event(o, 'indirect', 'forfeited', 'banned');
  await f.event(o, 'indirect', 'held', 'appealing');
  await f.move(o, { estAfter: 2000n });

  await f.refresh(o);

  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 1700n, 850n],
    ['direct', 1700n, 170n],
    ['indirect', 1700n, 85n],
  ]);
});

it('[AC-B2-03q#19][BR-CALC-10] 受益人行数与快照一致：分享单只有 share、direct 两行，角色不变', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    people: [
      { role: 'share', ratioBp: 4000 },
      { role: 'direct', ratioBp: 1000 },
    ],
  });
  await f.move(o, { estAfter: 2000n });

  await f.refresh(o);

  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['share', 1700n, 680n],
    ['direct', 1700n, 170n],
  ]);
  const rows = (await amountRows(p.db, o)).filter((r) => r.commission_version === 2);
  expect(rows.map((r) => r.user_id)).toEqual([o.user('share'), o.user('direct')]);
});

it('[AC-B2-03q#20][BR-CALC-27] 四段金额的分项关系：向下取整的尾差归平台', async () => {
  const f = await fixture(p.db);
  const o = await f.order();
  await f.move(o, { estAfter: 333n });

  await f.refresh(o);

  // 333 × 85% = 283.05 → B=283；141 / 28 / 14，合计 183。
  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 283n, 141n],
    ['direct', 283n, 28n],
    ['indirect', 283n, 14n],
  ]);
  expect(await totalsAt(p.db, o, 2)).toEqual({
    n_total_fen: 333n,
    pre_base_deduct_fen: 50n,
    base_fen: 283n,
    user_share_total_fen: 183n,
    tlj_redpacket_fen: 0n,
    platform_est_profit_fen: 150n,
  });
});

it('[AC-B2-03q#21][BR-CALC-02][BR-CALC-27] 负 N：基数与份额为 0，n_total 保留负的联盟佣金加补贴', async () => {
  const f = await fixture(p.db);
  const o = await f.order({ subsidyFen: 111n });
  await f.move(o, { estAfter: -50n });

  await f.refresh(o);

  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 0n, 0n],
    ['direct', 0n, 0n],
    ['indirect', 0n, 0n],
  ]);
  expect(await totalsAt(p.db, o, 2)).toEqual({
    n_total_fen: 61n,
    pre_base_deduct_fen: 61n,
    base_fen: 0n,
    user_share_total_fen: 0n,
    tlj_redpacket_fen: 0n,
    platform_est_profit_fen: 61n,
  });
});

it('[AC-B2-03q#22] 跳号：快照才写 v1 而订单版本已到 3，直接写 v3，不补 v2', async () => {
  const f = await fixture(p.db);
  const o = await f.order({ commissionVersion: 3, estFen: 1600n });

  await f.refresh(o);

  // 1600 × 85% = 1360；680 / 136 / 68。
  expect(await amountsAt(p.db, o, 3)).toEqual([
    ['self', 1360n, 680n],
    ['direct', 1360n, 136n],
    ['indirect', 1360n, 68n],
  ]);
  expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 3], totals: [1, 3] });
});

it('[AC-B2-03q#23] 首次 refresh 版本恰为 1：该版本已有快照行，不写也不报错', async () => {
  const f = await fixture(p.db);
  const o = await f.order({ commissionVersion: 1, estFen: 2000n });
  const amounts = await amountRows(p.db, o);
  const totals = await totalsRows(p.db, o);

  await f.refresh(o);

  expect(await amountRows(p.db, o)).toEqual(amounts);
  expect(await totalsRows(p.db, o)).toEqual(totals);
});

it('[AC-B2-03q#24] 订单版本 0（首次入库默认值，rebate 的 R2 也调 refresh）：没有可写的版本，不报错', async () => {
  const f = await fixture(p.db);
  const o = await f.order({ commissionVersion: 0, estFen: 2000n });
  const amounts = await amountRows(p.db, o);
  const totals = await totalsRows(p.db, o);

  await f.refresh(o);

  expect(await amountRows(p.db, o)).toEqual(amounts);
  expect(await totalsRows(p.db, o)).toEqual(totals);
});

it('[AC-B2-03q#25] 无快照（快照待处理的单 rebate 也调 refresh）：什么也不写，不报错，订单照常提交', async () => {
  const f = await fixture(p.db);
  const o = await f.order({ snapshot: false, commissionVersion: 2, estFen: 2000n });

  await f.refresh(o);

  expect(await storedVersions(p.db, o)).toEqual({ amounts: [], totals: [] });
});

it('[AC-B2-03q#26] 同一版本 refresh 两次：不报错、不多行；至少一次投递重放时第一次的行不变', async () => {
  const f = await fixture(p.db);
  const o = await f.order();
  await f.move(o, { estAfter: 2000n });
  await f.refresh(o);
  const amounts = await amountRows(p.db, o);
  const totals = await totalsRows(p.db, o);
  expect(amounts).toHaveLength(6);
  expect(totals).toHaveLength(2);

  // 重放时列值、时钟都可能已不同（不改版本号的列变化）：该版本已有行就不写。
  f.clock.set(LATER);
  await p.db
    .updateTable('orders')
    .set({ est_commission_fen: 7000n })
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .execute();
  await f.refresh(o);

  expect(await amountRows(p.db, o)).toEqual(amounts);
  expect(await totalsRows(p.db, o)).toEqual(totals);
});

it('[AC-B2-03q#27] 写入时间取注入的 Clock，不用 SQL 时钟', async () => {
  const f = await fixture(p.db);
  const o = await f.order();
  await f.move(o, { estAfter: 2000n });

  await f.refresh(o);

  const at = new Date(NOW);
  const amounts = (await amountRows(p.db, o)).filter((r) => r.commission_version === 2);
  expect(amounts.map((r) => r.created_at)).toEqual([at, at, at]);
  const totals = (await totalsRows(p.db, o)).filter((t) => t.commission_version === 2);
  expect(totals.map((t) => t.created_at)).toEqual([at]);
});

it('[AC-B2-03q#28] 只写金额行与 totals：不写 orders、快照、事件、余额、分录，不加版本号', async () => {
  const f = await fixture(p.db);
  const o = await f.order();
  await f.move(o, { estAfter: 2000n });
  const frozen = await frozenRows(p.db, o);
  const money = await moneyRows(p.db, o.appId);
  const traced = tracing(p.db);

  await traced.db
    .transaction()
    .execute((trx) =>
      f.estimates.refresh(trx, { appId: o.appId, orderId: o.orderId, attrAt: o.attrAt }),
    );

  const writes = traced.queries
    .map((q) => q.sql)
    .filter((text) => /^\s*(insert|update|delete|merge|truncate)\b/i.test(text));
  expect(writes.length).toBeGreaterThan(0);
  for (const text of writes) {
    expect(text).toMatch(/^\s*insert into (?:"app"\.)?"commission_split_(?:amounts|totals)"/i);
  }
  expect(await frozenRows(p.db, o)).toEqual(frozen);
  expect(frozen.order.commission_version).toBe(2);
  expect(await moneyRows(p.db, o.appId)).toEqual(money);
});

it('[AC-B2-03q#29] 在调用方事务里：看得见未提交的订单版本，提交前别的连接看不到，回滚归调用方', async () => {
  const f = await fixture(p.db);
  const o = await f.order();
  const rollback = new Error('caller rollback');
  await expect(
    p.db.transaction().execute(async (trx) => {
      await syncColumns(trx, o, { estAfter: 2000n });
      await f.estimates.refresh(trx, { appId: o.appId, orderId: o.orderId, attrAt: o.attrAt });
      expect(await amountsAt(trx, o, 2)).toEqual([
        ['self', 1700n, 850n],
        ['direct', 1700n, 170n],
        ['indirect', 1700n, 85n],
      ]);
      // 第二个连接：实现不能私自提交调用方事务。
      expect(await storedVersions(p.db, o)).toEqual({ amounts: [1], totals: [1] });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await storedVersions(p.db, o)).toEqual({ amounts: [1], totals: [1] });
});

it('[AC-B2-03q#30] 跨 App、跨订单不串：只写传入的这一单，同一受益人在别的 App 和同 App 的别的单都不动', async () => {
  const f = await fixture(p.db);
  const other = await fixture(p.db);
  const people: readonly PersonInput[] = [
    { role: 'self', ratioBp: 5000 },
    { role: 'direct', ratioBp: 1000, userId: randomUUID() },
  ];
  const mine = await f.order({ people });
  const sibling = await f.order({ people });
  const theirs = await other.order({ people });
  await f.move(mine, { estAfter: 2000n });
  await f.move(sibling, { estAfter: 4000n });
  await other.move(theirs, { estAfter: 8000n });

  await f.refresh(mine);

  expect(await amountsAt(p.db, mine, 2)).toEqual([
    ['self', 1700n, 850n],
    ['direct', 1700n, 170n],
  ]);
  expect(await storedVersions(p.db, sibling)).toEqual({ amounts: [1], totals: [1] });
  expect(await storedVersions(p.db, theirs)).toEqual({ amounts: [1], totals: [1] });

  await other.refresh(theirs);
  expect(await amountsAt(p.db, theirs, 2)).toEqual([
    ['self', 6800n, 3400n],
    ['direct', 6800n, 680n],
  ]);
  expect(await amountsAt(p.db, mine, 2)).toEqual([
    ['self', 1700n, 850n],
    ['direct', 1700n, 170n],
  ]);
});

it('[AC-B2-03q#56][BR-CALC-02][BR-CALC-03][BR-CALC-27] 拼多多：N 按佣金减服务费，四段金额都用这个 N', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    platform: 'pdd',
    estFen: 1200n,
    patch: { service_fee_fen: 200n },
  });
  await f.move(o, { estAfter: 2000n });

  await f.refresh(o);

  // N = 2000 − 200 = 1800；B = 1530；765 / 153 / 76，合计 994。
  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 1530n, 765n],
    ['direct', 1530n, 153n],
    ['indirect', 1530n, 76n],
  ]);
  expect(await totalsAt(p.db, o, 2)).toEqual({
    n_total_fen: 1800n,
    pre_base_deduct_fen: 270n,
    base_fen: 1530n,
    user_share_total_fen: 994n,
    tlj_redpacket_fen: 0n,
    platform_est_profit_fen: 806n,
  });
});

it('[AC-B2-03q#57][BR-CALC-02][BR-CALC-03] 拼多多结算优先：结算额同样减服务费，预估不参与', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    platform: 'pdd',
    rebateStatus: 'WAITING',
    platformStatus: 'SETTLED',
    estFen: 1200n,
    settleFen: 2000n,
    patch: { service_fee_fen: 200n },
  });
  await f.move(o, { estAfter: 9999n });

  await f.refresh(o);

  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 1530n, 765n],
    ['direct', 1530n, 153n],
    ['indirect', 1530n, 76n],
  ]);
  expect(await totalsAt(p.db, o, 2)).toMatchObject({ n_total_fen: 1800n, base_fen: 1530n });
});

it('[AC-B2-03q#58][BR-CALC-03] 拼多多服务费缺失：什么也不写、不抛错，不按服务费 0 算', async () => {
  const f = await fixture(p.db);
  const o = await f.order({
    platform: 'pdd',
    estFen: 1200n,
    patch: { service_fee_fen: null },
  });
  await f.move(o, { estAfter: 2000n });

  await f.refresh(o);

  expect(await storedVersions(p.db, o)).toEqual({ amounts: [1], totals: [1] });
});

it('[AC-B2-03q#59][BR-CALC-03] 拼多多服务费 0 是已知值：照常写，N 等于佣金', async () => {
  const f = await fixture(p.db);
  const o = await f.order({ platform: 'pdd', estFen: 1200n, patch: { service_fee_fen: 0n } });
  await f.move(o, { estAfter: 2000n });

  await f.refresh(o);

  expect(await totalsAt(p.db, o, 2)).toMatchObject({ n_total_fen: 2000n, base_fen: 1700n });
});

it('[AC-B2-03q#60][BR-CALC-03] 不扣服务费的平台：列里有值也不减', async () => {
  const f = await fixture(p.db);
  const o = await f.order({ platform: 'jd', patch: { service_fee_fen: 200n } });
  await f.move(o, { estAfter: 2000n });

  await f.refresh(o);

  expect(await totalsAt(p.db, o, 2)).toMatchObject({ n_total_fen: 2000n, base_fen: 1700n });
});

it('[AC-B2-03q#61][BR-CALC-27] 金额超过 2^31：逐分准确，不被窄化', async () => {
  const f = await fixture(p.db);
  const o = await f.order();
  await f.move(o, { estAfter: 3_000_000_000n });

  await f.refresh(o);

  // 3,000,000,000 × 85% = 2,550,000,000；份额 50% / 10% / 5%。
  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 2_550_000_000n, 1_275_000_000n],
    ['direct', 2_550_000_000n, 255_000_000n],
    ['indirect', 2_550_000_000n, 127_500_000n],
  ]);
  expect(await totalsAt(p.db, o, 2)).toEqual({
    n_total_fen: 3_000_000_000n,
    pre_base_deduct_fen: 450_000_000n,
    base_fen: 2_550_000_000n,
    user_share_total_fen: 1_657_500_000n,
    tlj_redpacket_fen: 0n,
    platform_est_profit_fen: 1_342_500_000n,
  });
});
