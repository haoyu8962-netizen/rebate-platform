// B1-10n: rows of an import on orders the real settle handler credited (08 BR-FUND-06 维权结果,
// BR-FUND-08 ② ③, BR-FUND-01 R8 / R9, BR-FUND-05; 任务书第 9 节第 5 条). The entry under test is the
// rights_import job on the worker's real order-sync handler: its rights.record must reach the real
// clawback (createClawbackOrder over the real ledger, gate, commission snapshot and orders' pending
// port). Expected amounts by hand, from ./kit.ts' order: N 1000, reserve 1500 → B 850; 425 / 85 / 42,
// platform 448.
//   - full (PUNISH, or a deduction ≥ booked_n): R8 gives back 425 / 85 / 42, platform 448.
//   - deduction 400: N_new 600 → reserve 90, B 510 → 255 / 51 / 25, platform 179 + 90 = 269: R9 gives
//     back 170 / 34 / 17, platform 179.
// The same N_new before credit (#23) must be what the credit books: 255 / 51 / 25, platform 269,
// never the old 1000 (B2-04lb, D10-463 / D10-470). The templates are synthetic (./templates.ts),
// injected over the real job. #30 is the sync's way to the same clawback, on a jd order: taobao has
// neither a status map nor a sync window yet. Top-level it() only (规划/11 §4.3).
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  CHECKPOINT_FAILURE,
  GRANTS,
  OCCURRED,
  TEMPLATES,
  available,
  checkpointFault,
  creditedOrder,
  detailOf,
  imported,
  insertRecorder,
  lines,
  moneyState,
  orderNow,
  queued,
  reported,
  rightsOf,
  runBatch,
  seedProcessingDeletion,
  seedUnionAccount,
  setup,
  shareImportStore,
  subjectNet,
  versionRows,
  voucherKeys,
  voucherLines,
  waitingOrder,
  worker,
  type CreditableOrder,
  type Scenario,
} from './kit.ts';
import type { RightsImportJob } from './templates.ts';

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) =>
  (await import('./templates.ts')).withTemplates(await importOriginal<RightsImportJob>()),
);

const h = useHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

const RECEIVABLE = 'UNION_RECEIVABLE:taobao';
const RIGHTS_FIELDS = { kind: 'rights', platform: 'taobao' } as const;
const PUNISH_FIELDS = { kind: 'punish', platform: 'taobao' } as const;

const rightsRows = (subOrderId: string, status: string, deduction: string | null) => [
  Object.values(TEMPLATES.rights.columns),
  [subOrderId, 'RN-1', status, '29.90', deduction, OCCURRED],
];
const punishRows = (subOrderId: string) => [
  Object.values(TEMPLATES.punish.columns),
  [subOrderId, 'PN-1', '3.00', null, OCCURRED],
];

const orderKey = (c: CreditableOrder) => `${c.order.platform}:${c.order.sub_order_id}`;

/** The one order_rights row of the scenario, as the event id of its vouchers. */
async function eventOf(s: Scenario): Promise<string> {
  const rows = await rightsOf(s);
  expect(rows).toHaveLength(1);
  return `R${rows[0]!.id}`;
}

/** A user CLAWBACK voucher: debit USER_BALANCE.available, credit UNION_RECEIVABLE. */
function userLines(receivable: string, userId: string, amount: bigint): string[] {
  return [
    `USER_BALANCE|${userId}|${String(amount)}`,
    `${receivable}|platform|${String(-amount)}`,
  ].sort();
}

/** A bad-debt CLAWBACK voucher (BR-FUND-08): debit BAD_DEBT, credit UNION_RECEIVABLE. */
function badDebtLines(receivable: string, amount: bigint): string[] {
  return [
    `BAD_DEBT|platform|${String(amount)}`,
    `${receivable}|platform|${String(-amount)}`,
  ].sort();
}

/**
 * One set of CLAWBACK vouchers under `event`, and nothing else: self, direct, indirect, platform.
 * `deleting`: the direct beneficiary is in deletion processing, so that voucher is the bad debt.
 */
async function expectClawback(
  s: Scenario,
  c: CreditableOrder,
  event: string,
  [self, direct, indirect, platform]: readonly [bigint, bigint, bigint, bigint],
  type: string,
  deleting = false,
): Promise<void> {
  const key = orderKey(c);
  const receivable = `UNION_RECEIVABLE:${c.order.platform}`;
  const vouchers = {
    [`${key}:${c.self}:self:CLAWBACK:${event}`]: userLines(receivable, c.self, self),
    [`${key}:${c.direct}:direct:CLAWBACK:${event}`]: deleting
      ? badDebtLines(receivable, direct)
      : userLines(receivable, c.direct, direct),
    [`${key}:${c.indirect}:indirect:CLAWBACK:${event}`]: userLines(
      receivable,
      c.indirect,
      indirect,
    ),
    [`${key}:PLATFORM:CLAWBACK:${event}`]: [
      `COMMISSION_REVENUE|platform|${String(platform)}`,
      `${receivable}|platform|${String(-platform)}`,
    ].sort(),
  };
  expect(await voucherKeys(s, ':CLAWBACK:')).toEqual(Object.keys(vouchers).sort());
  for (const [uniqKey, expected] of Object.entries(vouchers)) {
    expect(await voucherLines(s, uniqKey), uniqKey).toEqual(expected);
  }
  const types = (await lines(s))
    .filter((line) => line.uniq_key.includes(':CLAWBACK:'))
    .map((line) => `${line.ledger_type}|${String(line.sub_type)}`);
  expect([...new Set(types)]).toEqual([type]);
}

async function expectBalances(
  s: Scenario,
  c: CreditableOrder,
  [self, direct, indirect]: readonly [bigint, bigint, bigint],
): Promise<void> {
  expect(await available(s, c.self)).toBe(self);
  expect(await available(s, c.direct)).toBe(direct);
  expect(await available(s, c.indirect)).toBe(indirect);
}

/** The rebate history rows after the credit's own. */
async function historyAfterCredit(s: Scenario) {
  return (await s.state()).history.filter(
    (row) => row.field === 'rebate' && row.event !== 'SETTLE_BATCH_CREDIT',
  );
}

it('[AC-B1-10n#16] 已入账订单的违规单行经真实装配全额扣回（R8）：扣回 425 / 85 / 42、平台 448，键带 R{order_rights.id}，sub_type PUNISH，订单 CLAWED_BACK、原因码 PUNISH、booked 0 / 0，余额归零，联盟应收净额 0，发 order.clawed_back', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.punish });
  const w = await worker(h);
  const c = await creditedOrder(s, w);
  await expectBalances(s, c, [425n, 85n, 42n]);

  const importId = await imported(s, w, PUNISH_FIELDS, punishRows(c.order.sub_order_id));

  expect((await rightsOf(s))[0]).toMatchObject({
    order_id: c.order.order_id,
    source: 'IMPORT',
    type: 'PUNISH',
    status: 'SUCCEEDED',
  });
  await expectClawback(s, c, await eventOf(s), [425n, 85n, 42n, 448n], 'CLAWBACK|PUNISH');
  expect(await orderNow(s, c.order.order_id)).toMatchObject({
    rebate_status: 'CLAWED_BACK',
    reason: 'PUNISH',
    booked_base_fen: 0n,
    booked_n_fen: 0n,
    rights_pending: false,
  });
  await expectBalances(s, c, [0n, 0n, 0n]);
  expect(await subjectNet(s, RECEIVABLE)).toBe(0n);
  expect(await historyAfterCredit(s)).toEqual([
    expect.objectContaining({
      from_status: 'CREDITED',
      to_status: 'CLAWED_BACK',
      event: 'PUNISH',
    }),
  ]);
  expect(await s.events()).toContain('order.clawed_back');
  expect(await detailOf(s, importId)).toMatchObject({
    status: 'done',
    succeeded_rows: 1,
    failed_rows: 0,
  });
}, 120_000);

it('[AC-B1-10n#17] 已入账订单的维权单行部分成功（应扣佣金 4.00 元）按部分维权额扣回（R9）：N_new 600，扣回 170 / 34 / 17、平台 179，sub_type RIGHTS，订单仍 CREDITED、booked 510 / 600、差额原因 PART_REFUND，余额 255 / 51 / 25，联盟应收净额 600', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const w = await worker(h);
  const c = await creditedOrder(s, w);

  await imported(s, w, RIGHTS_FIELDS, rightsRows(c.order.sub_order_id, 'SUCCEEDED', '4.00'));

  expect((await rightsOf(s))[0]).toMatchObject({
    source: 'IMPORT',
    type: 'RIGHTS',
    status: 'SUCCEEDED',
    amount_fen: 2990n,
    deduction_commission_fen: 400n,
  });
  await expectClawback(s, c, await eventOf(s), [170n, 34n, 17n, 179n], 'CLAWBACK|RIGHTS');
  expect(await orderNow(s, c.order.order_id)).toMatchObject({
    rebate_status: 'CREDITED',
    booked_base_fen: 510n,
    booked_n_fen: 600n,
    diff_reason_code: 'PART_REFUND',
    reason: null,
    rights_pending: false,
  });
  await expectBalances(s, c, [255n, 51n, 25n]);
  expect(await subjectNet(s, RECEIVABLE)).toBe(600n);
  expect(await historyAfterCredit(s)).toEqual([
    expect.objectContaining({
      from_status: 'CREDITED',
      to_status: 'CREDITED',
      event: 'RIGHTS_PARTIAL',
    }),
  ]);
}, 120_000);

it('[AC-B1-10n#18] 已入账订单的维权单行全额成功（应扣佣金 12.00 元不低于 booked_n）按 R8 全额扣回：425 / 85 / 42、平台 448，订单 CLAWED_BACK、原因码 RIGHTS，发 order.clawed_back', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const w = await worker(h);
  const c = await creditedOrder(s, w);

  await imported(s, w, RIGHTS_FIELDS, rightsRows(c.order.sub_order_id, 'SUCCEEDED', '12.00'));

  await expectClawback(s, c, await eventOf(s), [425n, 85n, 42n, 448n], 'CLAWBACK|RIGHTS');
  expect(await orderNow(s, c.order.order_id)).toMatchObject({
    rebate_status: 'CLAWED_BACK',
    reason: 'RIGHTS',
    booked_base_fen: 0n,
    booked_n_fen: 0n,
  });
  await expectBalances(s, c, [0n, 0n, 0n]);
  expect(await s.events()).toContain('order.clawed_back');
}, 120_000);

it('[AC-B1-10n#19] 已入账订单的维权单行成功而无应扣佣金（BR-FUND-08 ③）：不扣回，记录 WAIT_COMMISSION，rights_pending=true，经 orders 真实待处理端口落 CLAWBACK_NO_COMMISSION，booked 与余额不变', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const w = await worker(h);
  const c = await creditedOrder(s, w);

  await imported(s, w, RIGHTS_FIELDS, rightsRows(c.order.sub_order_id, 'SUCCEEDED', null));

  expect((await rightsOf(s))[0]).toMatchObject({ type: 'RIGHTS', status: 'WAIT_COMMISSION' });
  expect(await voucherKeys(s, ':CLAWBACK:')).toEqual([]);
  expect(await orderNow(s, c.order.order_id)).toMatchObject({
    rebate_status: 'CREDITED',
    booked_base_fen: 850n,
    booked_n_fen: 1000n,
    rights_pending: true,
  });
  await expectBalances(s, c, [425n, 85n, 42n]);
  expect((await s.state()).pending).toEqual([
    expect.objectContaining({
      order_id: c.order.order_id,
      reason: 'CLAWBACK_NO_COMMISSION',
      status: 'open',
    }),
  ]);
}, 120_000);

it('[AC-B1-10n#20] 同一作业重投（至少一次投递，已跑完的任务）：不重复扣——凭证、余额、booked、记录、事件与计数都不变', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const w = await worker(h);
  const c = await creditedOrder(s, w);
  const importId = await imported(
    s,
    w,
    RIGHTS_FIELDS,
    rightsRows(c.order.sub_order_id, 'SUCCEEDED', '4.00'),
  );
  const first = await moneyState(s, c);
  const tallies = await detailOf(s, importId);

  await w.run(s.importJob(importId));
  await w.run(s.importJob(importId));

  expect(await moneyState(s, c)).toEqual(first);
  expect(await detailOf(s, importId)).toEqual(tallies);
  await expectClawback(s, c, await eventOf(s), [170n, 34n, 17n, 179n], 'CLAWBACK|RIGHTS');
}, 120_000);

it('[AC-B1-10n#21] 行检查点提交前崩溃（扣回已在该行事务里写完）：记录、凭证、余额、booked 随行事务一起回滚，任务仍 running；重投后只扣一次，计数 succeeded 1、duplicate 0', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const fault = checkpointFault();
  const w = await worker(h, { plugin: fault.plugin });
  const c = await creditedOrder(s, w);
  const before = await moneyState(s, c);
  const importId = await queued(
    s,
    RIGHTS_FIELDS,
    rightsRows(c.order.sub_order_id, 'SUCCEEDED', '4.00'),
  );
  const job = s.importJob(importId);

  fault.armed = true;
  await expect(w.run(job)).rejects.toThrow(CHECKPOINT_FAILURE);

  expect(await moneyState(s, c)).toEqual(before);
  expect(await detailOf(s, importId)).toMatchObject({ status: 'running', total_rows: 0 });

  await w.run(job);

  expect(await detailOf(s, importId)).toMatchObject({
    status: 'done',
    total_rows: 1,
    succeeded_rows: 1,
    duplicate_rows: 0,
    failed_rows: 0,
  });
  await expectClawback(s, c, await eventOf(s), [170n, 34n, 17n, 179n], 'CLAWBACK|RIGHTS');
  await expectBalances(s, c, [255n, 51n, 25n]);
}, 120_000);

it('[AC-B1-10n#22] 同一文件重新上传是新任务：已导入的行计 duplicate_rows，不重复扣（BR-FUND-06 去重键）', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const w = await worker(h);
  const c = await creditedOrder(s, w);
  const rows = rightsRows(c.order.sub_order_id, 'SUCCEEDED', '4.00');
  const firstId = await imported(s, w, RIGHTS_FIELDS, rows);
  const first = await moneyState(s, c);

  const secondId = await imported(s, w, RIGHTS_FIELDS, rows);

  expect(secondId).not.toBe(firstId);
  expect(await detailOf(s, secondId)).toMatchObject({
    status: 'done',
    total_rows: 1,
    succeeded_rows: 0,
    duplicate_rows: 1,
    failed_rows: 0,
  });
  expect(await moneyState(s, c)).toEqual(first);
}, 120_000);

it('[AC-B1-10n#23] 入账前部分维权（结算佣金 1000、应扣 4.00 元）不得按旧额入账（B2-04lb）：R7 保持 WAITING、不写分录；随后真实批次按 N_new 600 入账，booked 510 / 600，255 / 51 / 25、平台 269，联盟应收净额 600', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const w = await worker(h);
  const c = await waitingOrder(s);

  await imported(s, w, RIGHTS_FIELDS, rightsRows(c.order.sub_order_id, 'SUCCEEDED', '4.00'));

  expect((await rightsOf(s))[0]).toMatchObject({
    status: 'SUCCEEDED',
    deduction_commission_fen: 400n,
  });
  expect(await orderNow(s, c.order.order_id)).toMatchObject({
    rebate_status: 'WAITING',
    reason: null,
    rights_pending: false,
  });
  expect((await s.state()).history).toEqual([
    expect.objectContaining({
      field: 'rebate',
      from_status: 'WAITING',
      to_status: 'WAITING',
      event: 'RIGHTS_PARTIAL',
    }),
  ]);
  expect(await voucherKeys(s, ':')).toEqual([]);

  expect(await runBatch(s, w, c.order)).toMatchObject({ result: 'credited' });

  const key = orderKey(c);
  expect(await orderNow(s, c.order.order_id)).toMatchObject({
    rebate_status: 'CREDITED',
    booked_base_fen: 510n,
    booked_n_fen: 600n,
  });
  await expectBalances(s, c, [255n, 51n, 25n]);
  expect(await voucherLines(s, `${key}:PLATFORM:CREDIT`)).toEqual(
    [`${RECEIVABLE}|platform|269`, 'COMMISSION_REVENUE|platform|-269'].sort(),
  );
  expect(await subjectNet(s, RECEIVABLE)).toBe(600n);
}, 120_000);

it('[AC-B1-10n#24] 入账前维权成功而无应扣佣金：记录 WAIT_COMMISSION、rights_pending=true，真实批次跳过（rights_pending），不按旧额入账', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.rights });
  const w = await worker(h);
  const c = await waitingOrder(s);

  await imported(s, w, RIGHTS_FIELDS, rightsRows(c.order.sub_order_id, 'SUCCEEDED', null));

  expect((await rightsOf(s))[0]).toMatchObject({ status: 'WAIT_COMMISSION' });
  expect(await orderNow(s, c.order.order_id)).toMatchObject({
    rebate_status: 'WAITING',
    rights_pending: true,
  });

  expect(await runBatch(s, w, c.order)).toMatchObject({
    result: 'skipped',
    skip_reason: 'rights_pending',
  });
  expect((await orderNow(s, c.order.order_id)).rebate_status).toBe('WAITING');
  expect(await voucherKeys(s, ':')).toEqual([]);
}, 120_000);

it('[AC-B1-10n#28] 直推入账后进入注销 processing（净额 85 > 0），违规单行全额扣回（R8）：直推这笔同键改借 BAD_DEBT 85 / 贷联盟应收，不扣 USER_BALANCE、余额仍 85，类型 CLAWBACK|PUNISH；本人 425、间推 42、平台 448 照常，订单 CLAWED_BACK，联盟应收净额 0', async () => {
  shareImportStore();
  const s = await setup(h, { grants: GRANTS.punish });
  const w = await worker(h);
  const c = await creditedOrder(s, w);
  await seedProcessingDeletion(s, c.direct);

  await imported(s, w, PUNISH_FIELDS, punishRows(c.order.sub_order_id));

  await expectClawback(s, c, await eventOf(s), [425n, 85n, 42n, 448n], 'CLAWBACK|PUNISH', true);
  expect(await orderNow(s, c.order.order_id)).toMatchObject({
    rebate_status: 'CLAWED_BACK',
    reason: 'PUNISH',
    booked_base_fen: 0n,
    booked_n_fen: 0n,
  });
  await expectBalances(s, c, [0n, 85n, 0n]);
  expect(await subjectNet(s, 'BAD_DEBT')).toBe(85n);
  expect(await subjectNet(s, RECEIVABLE)).toBe(0n);
}, 120_000);

// D10-565: this report's estimate moves commission_version (BR-FUND-03) and the clawback reads the
// snapshot of the current version, so orders' onUpdated must run rebate (R9b's copy of the amount
// rows and totals) before the clawback. jd 3 is PLATFORM_INVALID: P6 from RECEIVED, R8 with ref
// platform, sub_type FULL, reason REFUND (BR-FUND-08 细则), the same 425 / 85 / 42, platform 448.
// The copy keeps the snapshot's own figures whatever the new estimate says. Goes green once the
// update step's rebate port is the real one (B1-09n's wiring); the order must not be weakened.
it('[AC-B1-10n#30] 已入账订单的同步更新（预估变化，平台失效）经真实 worker 的 order-sync 作业：commission 新版本行先于扣回凭证写入（rebate 在前，扣回在后），v2 逐行等于 v1；全额扣回 425 / 85 / 42、平台 448，sub_type FULL，订单 CLAWED_BACK、原因码 REFUND、booked 0 / 0，余额归零，联盟应收净额 0', async () => {
  const s = await setup(h);
  const writes = insertRecorder([
    'commission_split_amounts',
    'commission_split_totals',
    'ledger_vouchers',
  ]);
  const w = await worker(h, { plugin: writes.plugin });
  const c = await creditedOrder(s, w, 'jd');
  const accountId = await seedUnionAccount(s, 'jd');

  const before = await versionRows(s, c.order.order_id, 1);
  expect(before.amounts).toHaveLength(3);
  expect(before.totals).toHaveLength(1);

  writes.armed = true;
  await w.sync(s.appId, accountId, reported(c.order, '3', 2000n));
  writes.armed = false;

  const phases = writes.inserts
    .map((table) => (table === 'ledger_vouchers' ? 'voucher' : 'version'))
    .filter((phase, at, all) => phase !== all[at - 1]);
  expect(phases).toEqual(['version', 'voucher']);

  expect(await versionRows(s, c.order.order_id, 1)).toEqual(before);
  expect(await versionRows(s, c.order.order_id, 2)).toEqual(before);

  const keys = await voucherKeys(s, ':PLATFORM:CLAWBACK:');
  expect(keys).toHaveLength(1);
  const event = keys[0]!.split(':').pop()!;
  expect(event).toMatch(/^P\d+$/);
  await expectClawback(s, c, event, [425n, 85n, 42n, 448n], 'CLAWBACK|FULL');
  expect(await orderNow(s, c.order.order_id)).toMatchObject({
    platform_status: 'INVALID',
    rebate_status: 'CLAWED_BACK',
    reason: 'REFUND',
    booked_base_fen: 0n,
    booked_n_fen: 0n,
    commission_version: 2,
    est_commission_fen: 2000n,
  });
  await expectBalances(s, c, [0n, 0n, 0n]);
  expect(await subjectNet(s, 'UNION_RECEIVABLE:jd')).toBe(0n);
}, 120_000);
