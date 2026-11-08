// B1-04zzaa 规则测试补强（FU-B104ZZA-PRECREDIT-REOPEN；编排 D10-973 / D10-982 ②）：[AC-B1-04zza#45] / #46 只钉了
// 入账后（CREDITED）的「API 源维权已 FAILED、联盟后来又报扣款成功」，这里钉入账前（ESTIMATED / WAITING）同一路径。
// 规则：08 BR-FUND-06 细则「淘宝维权『从卖家处补扣』」（D10-645 ②、D10-699）——refund_status 14 / 15 按结束、不扣我方
// 处理（效果同 FAILED：解除 rights_pending、不动钱）；同一维权单之后联盟报成功（12 / 13）的，source=API、已落 FAILED 的
// 同一条记录迁到 SUCCEEDED，写审计（原因 union_reported_success_after_closed）并告警；入账前按 BR-FUND-07：
// N_new = 有效联盟佣金（BR-CALC-02：结算佣金优先，否则预估）− 应扣佣金，正数部分为 0 → R6 RIGHTS_FULL（VOID，原因码
// RIGHTS，同事务发 order.invalidated），否则 R7 RIGHTS_PARTIAL（状态不变，按 N_new 重算预估）；入账前不写任何分录。
// FAILED 回到 PROCESSING / WAIT_COMMISSION、SUCCEEDED 之后的任何回退、同一内容重放仍按重复上报不处理。
// 走真实链路（见 kit.ts）：淘宝维权窗口处理器 → orders 写入方 → settlement rights-command（注入 admin 审计端口）→
// rebate → commission 真实估值；断言查库。
// 金额手算（预留 15%，自购 50% / 直推 10% / 间推 5%，分以下舍去）：
//   v1：N 1000 → B 1000 × 85% = 850 → 425 / 85 / 42；
//   应扣 400：N_new 1000 − 400 = 600 → B 600 × 85% = 510 → 255 / 51 / 25（25.5 舍去），用户合计 331、基数前扣除
//   600 − 510 = 90、平台预估 600 − 331 = 269；
//   应扣 1000 / 1600：N_new 1000 − 1000 = 0、1000 − 1600 < 0 取 0 → 全额。
// 用例全部是顶层 it（规划/11 §4.3）；时间只读注入的 Clock。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  REOPEN_ACTION,
  TB_RIGHTS_NO,
  TIMEOUT,
  amountsAt,
  databaseFixture,
  harness,
  storedVersions,
  totalsAt,
  type Harness,
  type SeededPortOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

type PrecreditState = 'ESTIMATED' | 'WAITING';

const V1_AMOUNTS = [
  ['self', 850n, 425n],
  ['direct', 850n, 85n],
  ['indirect', 850n, 42n],
] as const;

/**
 * 同一维权单号先报处理中（4）、再报结束且不扣我方（14 / 15 → FAILED）：同一条记录 FAILED，rights_pending 解除，
 * 返利状态、预估版本与金额都不动，没有凭证、没有这条原因的审计与告警。返回那条 FAILED 记录。
 */
async function closedWithoutCharge(
  h: Harness,
  o: SeededPortOrder,
  state: PrecreditState,
  code: '14' | '15',
  fen: bigint,
) {
  expect(await h.deliver(o, '4', fen)).toBe('applied');
  const processing = await h.onlyRights(o);
  expect(processing).toMatchObject({
    source: 'API',
    type: 'RIGHTS',
    status: 'PROCESSING',
    platform_rights_no: TB_RIGHTS_NO,
  });
  expect(await h.read(o)).toMatchObject({ rebate_status: state, rights_pending: true });

  expect(await h.deliver(o, code, fen)).toBe('applied');
  const failed = await h.onlyRights(o);
  expect(failed).toMatchObject({
    id: processing.id,
    source: 'API',
    type: 'RIGHTS',
    status: 'FAILED',
    platform_rights_no: TB_RIGHTS_NO,
    row_version: processing.row_version + 1,
  });
  expect(await h.read(o)).toMatchObject({
    rebate_status: state,
    reason: null,
    rights_pending: false,
    hold: false,
    est_commission_fen: 1000n,
    settle_commission_fen: null,
    commission_version: 1,
  });
  expect(await h.rebateHistory(o)).toEqual([]);
  expect(await storedVersions(p.db, o)).toEqual({ amounts: [1], totals: [1] });
  expect(await amountsAt(p.db, o, 1)).toEqual(V1_AMOUNTS);
  expect(h.refresh).not.toHaveBeenCalled();
  expect(await h.money()).toEqual({ vouchers: [], entries: [] });
  expect(await h.reasonAudits()).toEqual([]);
  expect(h.reasonAlerts()).toEqual([]);
  return failed;
}

/** 同一条记录（同 id）原地变 SUCCEEDED、应扣佣金照入参、row_version + 1、updated_at = 注入的 now。 */
async function expectReopened(
  h: Harness,
  o: SeededPortOrder,
  failed: Awaited<ReturnType<typeof closedWithoutCharge>>,
  fen: bigint,
) {
  const succeeded = await h.onlyRights(o);
  expect(succeeded).toMatchObject({
    id: failed.id,
    source: 'API',
    type: 'RIGHTS',
    status: 'SUCCEEDED',
    platform_rights_no: TB_RIGHTS_NO,
    deduction_commission_fen: fen,
    row_version: failed.row_version + 1,
    updated_at: h.clock.now(),
  });
  return succeeded;
}

/** 一条原因 union_reported_success_after_closed 的系统审计（与这次 rights.record 同一事务）、告警一条。 */
async function expectAuditedOnce(h: Harness, rightsId: string): Promise<void> {
  const audits = await h.reasonAudits();
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    app_id: h.appId,
    admin_id: null,
    action: REOPEN_ACTION,
    target: `order_rights:${rightsId}`,
  });
  expect(h.auditTrxs).toHaveLength(1);
  expect(h.auditTrxs[0]).toBe(h.recordTrxs.at(-1));
  expect(h.reasonAlerts()).toHaveLength(1);
}

/** API 源 FAILED 之后报 13（应扣 400）：BR-FUND-07 R7 RIGHTS_PARTIAL，预估按 N_new 600 下调，不写凭证。 */
async function partialAfterClosed(state: PrecreditState, code: '14' | '15'): Promise<void> {
  const h = await harness(p.db);
  const o = state === 'ESTIMATED' ? await h.estimated() : await h.waiting();
  const failed = await closedWithoutCharge(h, o, state, code, 400n);
  const rowVersion = (await h.read(o)).row_version;
  const published = h.publish.mock.calls.length;

  expect(await h.deliver(o, '13', 400n)).toBe('applied');

  const succeeded = await expectReopened(h, o, failed, 400n);
  // R7：状态不变、不作废；commission_version 与状态写在同一条 CAS 里，订单只写这一次。
  expect(await h.read(o)).toMatchObject({
    rebate_status: state,
    reason: null,
    rights_pending: false,
    hold: false,
    est_commission_fen: 1000n,
    settle_commission_fen: null,
    booked_base_fen: null,
    booked_n_fen: null,
    commission_version: 2,
    row_version: rowVersion + 1,
  });
  expect(await h.rebateHistory(o)).toEqual([
    { event: 'RIGHTS_PARTIAL', from_status: state, to_status: state },
  ]);
  // 交给 commission 的新佣金 N_new = 1000 − 400 = 600，只重算一次。
  expect(h.refreshValues()).toEqual([{ commissionFen: 600n }]);
  expect(await storedVersions(p.db, o)).toEqual({ amounts: [1, 2], totals: [1, 2] });
  expect(await amountsAt(p.db, o, 2)).toEqual([
    ['self', 510n, 255n],
    ['direct', 510n, 51n],
    ['indirect', 510n, 25n],
  ]);
  expect(await totalsAt(p.db, o, 2)).toEqual({
    n_total_fen: 600n,
    pre_base_deduct_fen: 90n,
    base_fen: 510n,
    user_share_total_fen: 331n,
    tlj_redpacket_fen: 0n,
    platform_est_profit_fen: 269n,
  });
  expect(await amountsAt(p.db, o, 1)).toEqual(V1_AMOUNTS);
  expect(h.publishedSince(published)).toEqual([]);
  expect(await h.money()).toEqual({ vouchers: [], entries: [] });
  await expectAuditedOnce(h, succeeded.id);
}

it.each(['14', '15'] as const)(
  '[AC-B1-04zzaa#1] WAITING（无结算记录，有效联盟佣金 = 预估 1000）：API 源维权先处理中、再 %s（结束且不扣我方 → FAILED：rights_pending 解除、不动钱），同一维权单号后来 13（扣款成功、应扣佣金 400）→ 同一条记录（同 id）变 SUCCEEDED → BR-FUND-07 R7 RIGHTS_PARTIAL：rebate_status 仍 WAITING，预估按 N_new 1000 − 400 = 600 下调（v2 金额行 255 / 51 / 25、基数 510），不写任何凭证；审计一条 union_reported_success_after_closed、告警一条',
  async (code) => {
    await partialAfterClosed('WAITING', code);
  },
  TIMEOUT,
);

it.each([1000n, 1600n])(
  '[AC-B1-04zzaa#2] WAITING：API 源维权先处理中、再 14（FAILED），同一维权单号后来 13 且应扣佣金 %s → N_new 正数部分为 0 → 同一条记录变 SUCCEEDED，按 R6 RIGHTS_FULL 置 VOID（原因码 RIGHTS），同一事务发 order.invalidated，预估版本不再推进，不写任何凭证；审计一条、告警一条',
  async (fen) => {
    const h = await harness(p.db);
    const o = await h.waiting();
    const failed = await closedWithoutCharge(h, o, 'WAITING', '14', fen);
    const published = h.publish.mock.calls.length;

    expect(await h.deliver(o, '13', fen)).toBe('applied');

    const succeeded = await expectReopened(h, o, failed, fen);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'VOID',
      reason: 'RIGHTS',
      rights_pending: false,
      hold: false,
      est_commission_fen: 1000n,
      booked_base_fen: null,
      booked_n_fen: null,
      commission_version: 1,
    });
    expect(await h.rebateHistory(o)).toEqual([
      { event: 'RIGHTS_FULL', from_status: 'WAITING', to_status: 'VOID' },
    ]);
    expect(h.publishedSince(published)).toEqual(['order.invalidated']);
    const last = h.publish.mock.calls.at(-1);
    expect(last?.[0]).toBe(h.recordTrxs.at(-1));
    expect(last?.[1]).toMatchObject({
      name: 'order.invalidated',
      payload: expect.objectContaining({ order_id: o.orderId, reason: 'RIGHTS' }),
    });
    expect((await h.everything()).events.map((row) => row.name)).toEqual(['order.invalidated']);
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1], totals: [1] });
    expect(await amountsAt(p.db, o, 1)).toEqual(V1_AMOUNTS);
    expect(await h.money()).toEqual({ vouchers: [], entries: [] });
    await expectAuditedOnce(h, succeeded.id);
  },
  TIMEOUT,
);

it.each(['14', '15'] as const)(
  '[AC-B1-04zzaa#3] ESTIMATED（平台 PAID，有效联盟佣金 = 预估 1000）：API 源维权先处理中、再 %s（FAILED），同一维权单号后来 13（应扣 400）→ 同一条记录变 SUCCEEDED → R7 RIGHTS_PARTIAL：rebate_status 仍 ESTIMATED，预估按 N_new 600 下调（255 / 51 / 25），不写凭证；审计一条、告警一条',
  async (code) => {
    await partialAfterClosed('ESTIMATED', code);
  },
  TIMEOUT,
);

const REPLAYS = [
  { label: 'WAITING、应扣 400（R7 之后）', state: 'WAITING', fen: 400n },
  { label: 'ESTIMATED、应扣 400（R7 之后）', state: 'ESTIMATED', fen: 400n },
  { label: 'WAITING、应扣 1000（R6 作废之后）', state: 'WAITING', fen: 1000n },
] as const;

it.each(REPLAYS)(
  '[AC-B1-04zzaa#4] 重放（$label）：FAILED → SUCCEEDED 放开一次之后，同一维权单号同一内容再报 13、再报 12（同为扣款成功）→ duplicate，什么都不写（维权记录、订单与预估版本、金额行、历史、事件、凭证、审计都不变，告警仍一条、不再调估值）；之后再报 14 也不回退',
  async ({ state, fen }) => {
    const h = await harness(p.db);
    const o = state === 'ESTIMATED' ? await h.estimated() : await h.waiting();
    await closedWithoutCharge(h, o, state, '14', fen);
    expect(await h.deliver(o, '13', fen)).toBe('applied');
    const settled = await h.everything();
    const published = h.publish.mock.calls.length;
    const refreshed = h.refresh.mock.calls.length;
    expect(settled.rights).toHaveLength(1);
    expect(settled.audits.length).toBeGreaterThan(0);

    for (const code of ['13', '12', '14'] as const) {
      expect(await h.deliver(o, code, fen)).toBe('duplicate');
      expect(await h.everything()).toEqual(settled);
    }
    expect(h.publishedSince(published)).toEqual([]);
    expect(h.refresh.mock.calls).toHaveLength(refreshed);
    expect(await h.reasonAudits()).toHaveLength(1);
    expect(h.auditTrxs).toHaveLength(1);
    expect(h.reasonAlerts()).toHaveLength(1);
  },
  TIMEOUT,
);

it.each(['ESTIMATED', 'WAITING'] as const)(
  '[AC-B1-04zzaa#5] %s：API 源维权处理中之后报扣款成功但不带应扣佣金（BR-FUND-06 例「部分成功、佣金未更新」）→ 同一条记录变 WAIT_COMMISSION，rights_pending 仍为 true（继续阻止入账），rebate_status 不变、不作废、不重算预估、不动钱；这不是已关闭记录的重开，不写这条原因的审计、不告警',
  async (state) => {
    const h = await harness(p.db);
    const o = state === 'ESTIMATED' ? await h.estimated() : await h.waiting();
    expect(await h.deliver(o, '4', 400n)).toBe('applied');
    const processing = await h.onlyRights(o);
    const published = h.publish.mock.calls.length;

    expect(await h.write(o, { status: 'SUCCEEDED', deduction_commission_fen: null })).toBe(
      'applied',
    );

    expect(await h.onlyRights(o)).toMatchObject({
      id: processing.id,
      source: 'API',
      type: 'RIGHTS',
      status: 'WAIT_COMMISSION',
      deduction_commission_fen: null,
      row_version: processing.row_version + 1,
    });
    expect(await h.read(o)).toMatchObject({
      rebate_status: state,
      reason: null,
      rights_pending: true,
      est_commission_fen: 1000n,
      commission_version: 1,
    });
    expect(await h.rebateHistory(o)).toEqual([]);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(await storedVersions(p.db, o)).toEqual({ amounts: [1], totals: [1] });
    expect(h.publishedSince(published)).toEqual([]);
    expect(await h.money()).toEqual({ vouchers: [], entries: [] });
    expect(await h.reasonAudits()).toEqual([]);
    expect(h.reasonAlerts()).toEqual([]);
  },
  TIMEOUT,
);

it.each(['ESTIMATED', 'WAITING'] as const)(
  '[AC-B1-04zzaa#6] %s：API 源维权已 FAILED 之后报扣款成功但不带应扣佣金（会落 WAIT_COMMISSION，即 FAILED 回到 WAIT_COMMISSION）→ 仍按重复上报不处理：duplicate，什么都不写、不审计不告警；同一维权单号随后带应扣佣金 400 报 13 → 照样放开（同一条记录 SUCCEEDED、R7 按 N_new 600 重算预估、审计一条告警一条）',
  async (state) => {
    const h = await harness(p.db);
    const o = state === 'ESTIMATED' ? await h.estimated() : await h.waiting();
    const failed = await closedWithoutCharge(h, o, state, '15', 400n);
    const before = await h.everything();

    expect(await h.write(o, { status: 'SUCCEEDED', deduction_commission_fen: null })).toBe(
      'duplicate',
    );
    expect(await h.everything()).toEqual(before);
    expect(await h.reasonAudits()).toEqual([]);
    expect(h.reasonAlerts()).toEqual([]);

    expect(await h.deliver(o, '13', 400n)).toBe('applied');
    const succeeded = await expectReopened(h, o, failed, 400n);
    expect(await h.read(o)).toMatchObject({ rebate_status: state, commission_version: 2 });
    expect(h.refreshValues()).toEqual([{ commissionFen: 600n }]);
    expect(await amountsAt(p.db, o, 2)).toEqual([
      ['self', 510n, 255n],
      ['direct', 510n, 51n],
      ['indirect', 510n, 25n],
    ]);
    expect(await h.money()).toEqual({ vouchers: [], entries: [] });
    await expectAuditedOnce(h, succeeded.id);
  },
  TIMEOUT,
);
