// B1-10n: an upload through the real admin entry, then its rights_import job on the handler the real
// worker assembly registered, before credit: rights and punish rows reach order_rights through
// settlement's rights command (08 BR-FUND-06 细则「维权导入任务」, BR-FUND-07), channel rows reach
// blocklist through risk's port (BR-ATTR-26 ②, 细则「渠道单导入」). One #29 goes on to the credit, on
// the worker's real settle handler. The templates are synthetic (./templates.ts), injected over the
// real job. Top-level it() only (规划/11 §4.3).
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ANSWER,
  GRANTS,
  IMPORTS,
  NOW,
  OCCURRED,
  TEMPLATES,
  accepted,
  attributedOrder,
  available,
  detailOf,
  estimatedOrder,
  imported,
  orderNow,
  rightsOf,
  runBatch,
  seedUnionAccount,
  settledAtEstimate,
  setup,
  shareImportStore,
  subjectNet,
  voucherKeys,
  voucherLines,
  worker,
  type Scenario,
} from './kit.ts';
import type { RightsImportJob } from './templates.ts';

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) =>
  (await import('./templates.ts')).withTemplates(await importOriginal<RightsImportJob>()),
);

const h = useHarness();

/** The worker's clock when the job runs: after the upload (kit NOW, the admin entry's clock). */
const JOB_RUNS_AT = '2026-10-09T02:30:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
});

it('[AC-B1-10n#11] 维权单行经真实 rights 端口落 order_rights（来源 IMPORT，金额元转分），订单 rights_pending；查不到的子订单是行失败；详情与列表读到结果', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const w = await worker(h);
  const order = await attributedOrder(s);
  const importId = await imported(s, w, { kind: 'rights', platform: 'jd' }, [
    Object.values(TEMPLATES.rights.columns),
    [order.sub_order_id, 'RN-1', 'PROCESSING', '12.34', null, OCCURRED],
    ['NO-SUCH-SUB-ORDER', 'RN-2', 'PROCESSING', '1.00', null, OCCURRED],
  ]);

  const rights = await rightsOf(s);
  expect(rights).toHaveLength(1);
  expect(rights[0]).toMatchObject({
    order_id: order.order_id,
    source: 'IMPORT',
    type: 'RIGHTS',
    status: 'PROCESSING',
    platform_rights_no: 'RN-1',
    amount_fen: 1234n,
    deduction_commission_fen: null,
    occurred_at: new Date(OCCURRED),
  });
  expect(await orderNow(s, order.order_id)).toMatchObject({
    rights_pending: true,
    rebate_status: 'ESTIMATED',
  });

  expect(await detailOf(s, importId)).toMatchObject({
    import_id: importId,
    kind: 'rights',
    status: 'done',
    total_rows: 2,
    succeeded_rows: 1,
    failed_rows: 1,
    created_by: s.admin.id,
    failures: [{ row_no: 3, reason: 'order_not_found' }],
  });
  const page = await accepted(await s.get(`${IMPORTS}?page=1&page_size=20`), ANSWER.list);
  expect(page).toMatchObject({ items: [{ import_id: importId, status: 'done' }], total: 1 });
}, 120_000);

it('[AC-B1-10n#12] 违规单行经真实 rights 端口：order_rights type PUNISH、SUCCEEDED，入账前的订单经真实 rebate 走 R6 作废（原因码 PUNISH，发 order.invalidated），不写分录', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.punish });
  const w = await worker(h);
  const order = await attributedOrder(s);
  await imported(s, w, { kind: 'punish', platform: 'jd' }, [
    Object.values(TEMPLATES.punish.columns),
    [order.sub_order_id, 'PN-1', '3.00', null, OCCURRED],
  ]);
  const rights = await rightsOf(s);
  expect(rights).toHaveLength(1);
  expect(rights[0]).toMatchObject({
    order_id: order.order_id,
    source: 'IMPORT',
    type: 'PUNISH',
    status: 'SUCCEEDED',
    platform_rights_no: 'PN-1',
  });
  expect(await orderNow(s, order.order_id)).toMatchObject({
    rebate_status: 'VOID',
    reason: 'PUNISH',
  });
  expect(await s.events()).toContain('order.invalidated');
  expect(await voucherKeys(s, ':')).toEqual([]);
}, 120_000);

it('[AC-B1-10n#13] 入账前维权全额成功（应扣佣金 12.00 不低于有效联盟佣金 1200 分）：经真实 rebate 走 R6 RIGHTS_FULL 作废（原因码 RIGHTS），不写分录', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const w = await worker(h);
  const order = await attributedOrder(s);
  await imported(s, w, { kind: 'rights', platform: 'jd' }, [
    Object.values(TEMPLATES.rights.columns),
    [order.sub_order_id, 'RN-1', 'SUCCEEDED', '12.34', '12.00', OCCURRED],
  ]);
  expect((await rightsOf(s))[0]).toMatchObject({
    status: 'SUCCEEDED',
    deduction_commission_fen: 1200n,
  });
  expect(await orderNow(s, order.order_id)).toMatchObject({
    rebate_status: 'VOID',
    reason: 'RIGHTS',
    rights_pending: false,
  });
  expect(await voucherKeys(s, ':')).toEqual([]);
}, 120_000);

it('[AC-B1-10n#14] 渠道单行经 risk 的真实端口写 blocklist：渠道维度、任务的联盟账号、start_at 为受理时间、created_by 为导入人；任务 done', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.channel });
  const w = await worker(h, { now: JOB_RUNS_AT });
  const accountId = await seedUnionAccount(s);
  const relationId = `REL-${s.appId}`;
  const importId = await imported(
    s,
    w,
    { kind: 'channel', platform: 'taobao', union_account_id: accountId },
    [Object.values(TEMPLATES.channel.columns), [relationId, null]],
    { stepUp: await s.stepUp(s.admin) },
  );
  const entries = await s.h.db
    .selectFrom('blocklist')
    .selectAll()
    .where('app_id', '=', s.appId)
    .execute();
  expect(entries).toEqual([
    expect.objectContaining({
      dimension: 'channel',
      value: relationId,
      platform: 'taobao',
      union_account_id: accountId,
      start_at: new Date(NOW),
      end_at: null,
      status: 'active',
      created_by: s.admin.id,
    }),
  ]);
  expect(await detailOf(s, importId)).toMatchObject({
    kind: 'channel',
    status: 'done',
    succeeded_rows: 1,
    failures: [],
  });
}, 120_000);

// A partial rights result before credit is R7: status and ledger stay. orders.est_commission_fen is
// the column the union reports, so the result leaves it alone, and N_new is no column
// (settlement/rights/rights-command.ts). commission's revaluation is FU-R7-RIGHTS-ESTIMATE, not
// this task's: the figures here are the order's, the rights rows and the credit.

/** The order's rights rows by 维权单号 (their ids are random UUIDs, so id order says nothing). */
async function deductions(s: Scenario) {
  const rows = await rightsOf(s);
  return Object.fromEntries(
    rows.map((row) => [
      String(row.platform_rights_no),
      [row.status, row.deduction_commission_fen, row.answered_at],
    ]),
  );
}

// BR-CALC-02: without a settlement record the effective union commission is the estimate, and a
// deduction is on the same N scale: 1200 − 400 = 800 > 0, so R7, never R6.
it('[AC-B1-10n#27] ESTIMATED 且无结算记录的订单，维权单行部分成功（应扣佣金 4.00 元）：order_rights 记应扣 400 分，orders.est_commission_fen 保持 1200，状态不变（R7），不写分录', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const w = await worker(h);
  const { order } = await estimatedOrder(s);
  await imported(s, w, { kind: 'rights', platform: 'taobao' }, [
    Object.values(TEMPLATES.rights.columns),
    [order.sub_order_id, 'RN-1', 'SUCCEEDED', '29.90', '4.00', OCCURRED],
  ]);
  expect((await rightsOf(s))[0]).toMatchObject({
    status: 'SUCCEEDED',
    deduction_commission_fen: 400n,
  });
  expect(await orderNow(s, order.order_id)).toMatchObject({
    rebate_status: 'ESTIMATED',
    est_commission_fen: 1200n,
    settle_commission_fen: null,
    rights_pending: false,
  });
  expect((await s.state()).history).toEqual([
    expect.objectContaining({
      field: 'rebate',
      from_status: 'ESTIMATED',
      to_status: 'ESTIMATED',
      event: 'RIGHTS_PARTIAL',
    }),
  ]);
  expect(await voucherKeys(s, ':')).toEqual([]);
}, 120_000);

// D10-474 ①: the deductions the union has not answered add up, over the estimate they all came off:
// 400 + 100 = 500 and 1200 − 500 = 700. Two rows of 4.00: 400 + 400 = 800 and 1200 − 800 = 400 > 0,
// so no void; taking the second row off the first one's 800 would reach 0 (R6). Each row is one R7.
it.each([
  ['1.00', 100n],
  ['4.00', 400n],
] as const)(
  '[AC-B1-10n#29] ESTIMATED 且无结算记录的订单，先后两条部分成功的维权行（应扣 4.00 元、%s 元）：两行累计应扣 500 或 800 分，orders.est_commission_fen 保持 1200，状态不变（R7），订单不作废，不写分录',
  async (second, secondFen) => {
    shareImportStore();
    const s = await setup(h, { grants: GRANTS.rights });
    const w = await worker(h);
    const { order } = await estimatedOrder(s);
    const importId = await imported(s, w, { kind: 'rights', platform: 'taobao' }, [
      Object.values(TEMPLATES.rights.columns),
      [order.sub_order_id, 'RN-1', 'SUCCEEDED', '29.90', '4.00', OCCURRED],
      [order.sub_order_id, 'RN-2', 'SUCCEEDED', '29.90', second, OCCURRED],
    ]);
    expect(await detailOf(s, importId)).toMatchObject({
      status: 'done',
      succeeded_rows: 2,
      failed_rows: 0,
    });
    expect(await deductions(s)).toEqual({
      'RN-1': ['SUCCEEDED', 400n, null],
      'RN-2': ['SUCCEEDED', secondFen, null],
    });
    expect(await orderNow(s, order.order_id)).toMatchObject({
      rebate_status: 'ESTIMATED',
      est_commission_fen: 1200n,
      settle_commission_fen: null,
      rights_pending: false,
      reason: null,
    });
    const partial = expect.objectContaining({
      field: 'rebate',
      from_status: 'ESTIMATED',
      to_status: 'ESTIMATED',
      event: 'RIGHTS_PARTIAL',
    });
    expect((await s.state()).history).toEqual([partial, partial]);
    expect(await voucherKeys(s, ':')).toEqual([]);
  },
  120_000,
);

// B2-04lb: the credit's N is the settlement record less the deductions still open. The record has
// to come first: one that arrives after the rows answers them on its sync transaction (D10-483,
// closeAnsweredRights in settlement/rebate) and already carries them, so N would be the record
// alone. Hence a WAITING order on a record of 1200, the two rows after it, then the real settle
// job.
// By hand, reserve 1500, then 5000 / 1000 / 500 bp of B, each share floored (BR-CALC-08):
//   400 + 100: N = 1200 − 500 = 700; reserve 105, B 595; 297 / 59 / 29, users 385, platform 315.
//   400 + 400: N = 1200 − 800 = 400; reserve 60, B 340; 170 / 34 / 17, users 221, platform 179.
// The old amount would book 1020 / 1200 and 510 / 102 / 51.
it.each([
  ['1.00', 100n, 700n, 595n, [297n, 59n, 29n], 315n],
  ['4.00', 400n, 400n, 340n, [170n, 34n, 17n], 179n],
] as const)(
  '[AC-B1-10n#29] WAITING 且结算记录 1200 的订单，其后两条部分成功的维权行（应扣 4.00 元、%s 元）：状态不变（R7）、不作废、不写分录，orders.est_commission_fen 保持 1200；真实批次按结算记录减两条未关闭应扣入账（N 700 或 400），不按旧额',
  async (second, secondFen, n, base, [self, direct, indirect], platform) => {
    shareImportStore();
    const s = await setup(h, { grants: GRANTS.rights });
    const w = await worker(h);
    const c = await settledAtEstimate(s);
    const orderId = c.order.order_id;
    const untouched = { est_commission_fen: 1200n, settle_commission_fen: 1200n };

    await imported(s, w, { kind: 'rights', platform: 'taobao' }, [
      Object.values(TEMPLATES.rights.columns),
      [c.order.sub_order_id, 'RN-1', 'SUCCEEDED', '29.90', '4.00', OCCURRED],
      [c.order.sub_order_id, 'RN-2', 'SUCCEEDED', '29.90', second, OCCURRED],
    ]);

    expect(await deductions(s)).toEqual({
      'RN-1': ['SUCCEEDED', 400n, null],
      'RN-2': ['SUCCEEDED', secondFen, null],
    });
    expect(await orderNow(s, orderId)).toMatchObject({
      ...untouched,
      rebate_status: 'WAITING',
      rights_pending: false,
      reason: null,
    });
    expect(await voucherKeys(s, ':')).toEqual([]);

    expect(await runBatch(s, w, c.order)).toMatchObject({ result: 'credited' });

    expect(await orderNow(s, orderId)).toMatchObject({
      ...untouched,
      rebate_status: 'CREDITED',
      booked_base_fen: base,
      booked_n_fen: n,
    });
    expect(await available(s, c.self)).toBe(self);
    expect(await available(s, c.direct)).toBe(direct);
    expect(await available(s, c.indirect)).toBe(indirect);
    const key = `${c.order.platform}:${c.order.sub_order_id}`;
    expect(await voucherLines(s, `${key}:PLATFORM:CREDIT`)).toEqual(
      [
        `UNION_RECEIVABLE:taobao|platform|${String(platform)}`,
        `COMMISSION_REVENUE|platform|${String(-platform)}`,
      ].sort(),
    );
    expect(await subjectNet(s, 'UNION_RECEIVABLE:taobao')).toBe(n);
  },
  120_000,
);
