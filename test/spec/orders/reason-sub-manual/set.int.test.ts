// B1-09v: adminSetOrderReasonSub — POST /admin/v1/orders/{order_id}/reason-sub on the real admin
// entry (contract CT-24zw; 08 BR-TEXT-05 子原因 写入来源 ② 后台人工; D10-818, D10-819 ③).
//   - permission point order.claim, no step-up; lacking it is 10403 admin_permission_denied;
//   - reason_sub must belong to the order's current reason (PUNISH: the 12; REFUND: IN_SALE /
//     AFTER_SETTLE; RIGHTS: AFTER_SALE) or be `none`; anything else, and any value while the reason
//     is not PUNISH / REFUND / RIGHTS (null included), is 20001 [reason_sub];
//   - an unknown order or one of another app is 20001 [order_id]; a stale expected_row_version is
//     20902 resource=order;
//   - success: orders.reason_sub = the value (`none` → NULL), reason_sub_manual = true; amounts,
//     reason, statuses and hold unchanged, no status history, no event; one audit record
//     order_reason_sub_set with the old and new reason_sub (`none` as null) and the reason, no
//     personal information; the answer is the order detail as it is now;
//   - afterwards nothing automatic overwrites it (a later punish import without reason_sub through
//     the real job).
// A refusal changes nothing. Real admin entry, permissions, PostgreSQL; the worker's real assembly
// for the later import, with the synthetic templates. Top-level it() only (规划/11 §4.3).
import { afterEach, expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import type { RightsImportJob } from '../rights-mounts/templates.ts';
import {
  CLAIM,
  DENIED,
  NONE,
  PUNISH_SUBS,
  REFUND_SUBS,
  RIGHTS_SUBS,
  SET_AUDIT,
  auditsOf,
  detailAnswer,
  expectManual,
  fieldsError,
  frozen,
  importPunish,
  jsonOf,
  orderNow,
  reasonedOrder,
  refused,
  seedOrder,
  setReasonSub,
  setup,
  shareImportStore,
  untouched,
  worker,
  type Order,
  type OrderPatch,
  type Scenario,
} from './kit.ts';

vi.mock('../../../../apps/api/src/modules/orders/jobs/rights-import.ts', async (importOriginal) =>
  (await import('../rights-mounts/templates.ts')).withTemplates(
    await importOriginal<RightsImportJob>(),
  ),
);

const h = useHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

/** Sets `value` on `order` with the order's current row_version; the detail it answers. */
async function setOn(s: Scenario, order: Order, value: string) {
  const now = await orderNow(s, order.order_id);
  return detailAnswer(
    await setReasonSub(s, order.order_id, {
      reason_sub: value,
      expected_row_version: now.row_version,
    }),
  );
}

/** Asserts the answer, the row and the one new audit record of a successful 改子原因. */
async function expectSet(
  s: Scenario,
  before: Order,
  value: string,
  detail: Record<string, unknown>,
  auditsBefore: number,
): Promise<void> {
  const stored = value === NONE ? null : value;
  const after = await orderNow(s, before.order_id);
  expect({ reason_sub: after.reason_sub, reason_sub_manual: after.reason_sub_manual }).toEqual({
    reason_sub: stored,
    reason_sub_manual: true,
  });
  expect(untouched(after)).toEqual(untouched(before));
  expect(detail).toMatchObject({
    order_id: before.order_id,
    reason: before.reason,
    reason_sub: stored,
    rebate_status: before.rebate_status,
    platform_status: before.platform_status,
    row_version: after.row_version,
  });

  const audits = await auditsOf(s, SET_AUDIT);
  expect(audits).toHaveLength(auditsBefore + 1);
  const audit = audits[audits.length - 1];
  expect(audit).toMatchObject({ admin_id: s.admin.id });
  expect(String(audit?.target)).toContain(before.order_id);
  const old = jsonOf(audit?.before);
  const now = jsonOf(audit?.after);
  expect(old).toMatchObject({ reason_sub: before.reason_sub });
  expect(now).toMatchObject({ reason_sub: stored });
  expect(now?.['reason'] ?? old?.['reason']).toBe(before.reason);
  const text = JSON.stringify([audit?.before ?? null, audit?.after ?? null]);
  for (const secret of [before.sub_order_id, before.parent_order_id]) {
    expect(text).not.toContain(String(secret));
  }
}

it('[AC-B1-09v#7] 违规单（PUNISH，自动映射写的 PUNISH_ORDER）改为 FAKE_TRADE：200，答当前订单详情；orders.reason_sub=FAKE_TRADE、reason_sub_manual=true，金额 / 原因 / 状态 / 暂停都不变，不写状态历史、不发事件；审计 order_reason_sub_set 带前后值与原因', async () => {
  const s = await setup(h, { grants: CLAIM });
  const order = await reasonedOrder(s, 'PUNISH', { reason_sub: 'PUNISH_ORDER' });
  const state = await s.state();

  const detail = await setOn(s, order, 'FAKE_TRADE');

  await expectSet(s, order, 'FAKE_TRADE', detail, 0);
  const now = await s.state();
  expect(now.history).toEqual(state.history);
  expect(now.events).toEqual(state.events);
  expect(now.pending).toEqual(state.pending);
}, 120_000);

const ALLOWED: readonly (readonly [string, string, OrderPatch])[] = [
  ...PUNISH_SUBS.map((value) => ['PUNISH', value, { rebate_status: 'VOID' }] as const),
  ['PUNISH', NONE, { rebate_status: 'VOID', reason_sub: 'PUNISH_ORDER' }],
  ['PUNISH', 'FAKE_TRADE', { rebate_status: 'CLAWED_BACK', platform_status: 'SETTLED' }],
  ...REFUND_SUBS.map((value) => ['REFUND', value, { rebate_status: 'VOID' }] as const),
  ['REFUND', NONE, { rebate_status: 'VOID', reason_sub: 'IN_SALE' }],
  ...RIGHTS_SUBS.map((value) => ['RIGHTS', value, { rebate_status: 'VOID' }] as const),
  ['RIGHTS', NONE, { rebate_status: 'CLAWED_BACK', reason_sub: 'AFTER_SALE' }],
];

it.each(ALLOWED)(
  '[AC-B1-09v#7] 原因 %s 的订单改子原因为 %s（该原因允许的子原因或 none）：成功，none 写 NULL，reason_sub_manual=true，其余列不变，审计一条',
  async (reason, value, patch) => {
    const s = await setup(h, { grants: CLAIM });
    const order = await reasonedOrder(s, reason, patch);

    const detail = await setOn(s, order, value);

    await expectSet(s, order, value, detail, 0);
  },
  120_000,
);

const REFUSED: readonly (readonly [string | null, string])[] = [
  ['PUNISH', 'IN_SALE'],
  ['PUNISH', 'AFTER_SETTLE'],
  ['PUNISH', 'AFTER_SALE'],
  ['REFUND', 'FAKE_TRADE'],
  ['REFUND', 'PUNISH_ORDER'],
  ['REFUND', 'AFTER_SALE'],
  ['RIGHTS', 'IN_SALE'],
  ['RIGHTS', 'AFTER_SETTLE'],
  ['RIGHTS', 'FAKE_TRADE'],
  [null, 'FAKE_TRADE'],
  [null, 'IN_SALE'],
  [null, NONE],
  ['OTHER', NONE],
  ['OTHER', 'FAKE_TRADE'],
  ['BLACKLIST', NONE],
  ['COMMISSION_ZERO', 'PUNISH_ORDER'],
  ['PRESALE_UNPAID', NONE],
  ['PART_REFUND', 'IN_SALE'],
  ['PUNISH', 'fake_trade'],
  ['PUNISH', 'NOT_A_SUB_REASON'],
  ['PUNISH', 'NONE'],
  ['PUNISH', ''],
];

it.each(REFUSED)(
  '[AC-B1-09v#7] 原因 %s 的订单改子原因为 %s（不属当前原因、原因不是 PUNISH / REFUND / RIGHTS、或不是取值）：20001 data.fields=[reason_sub]，订单、历史、审计都不变',
  async (reason, value) => {
    const s = await setup(h, { grants: CLAIM });
    const order = await reasonedOrder(s, reason);
    const before = await frozen(s);

    await refused(
      await setReasonSub(s, order.order_id, {
        reason_sub: value,
        expected_row_version: order.row_version,
      }),
      20001,
      fieldsError('reason_sub'),
    );

    expect(await frozen(s)).toEqual(before);
  },
  120_000,
);

it('[AC-B1-09v#7] 没有 order.claim（只有 order.view）：10403 admin_permission_denied；不带令牌：10001；都不改', async () => {
  const s = await setup(h, { grants: CLAIM });
  const order = await reasonedOrder(s, 'PUNISH', { reason_sub: 'PUNISH_ORDER' });
  const viewer = await s.caller(['order.view']);
  const body = { reason_sub: 'FAKE_TRADE', expected_row_version: order.row_version };
  const before = await frozen(s);

  await refused(await setReasonSub(s, order.order_id, body, { caller: viewer }), 10403, DENIED);
  await refused(await setReasonSub(s, order.order_id, body, { caller: null }), 10001);

  expect(await frozen(s)).toEqual(before);
  await expectManual(s, order.order_id, 'PUNISH_ORDER', false);
}, 120_000);

it('[AC-B1-09v#7] 别的 App 的订单与不存在的订单：20001 data.fields=[order_id]（不是 404），哪边都不改', async () => {
  const s = await setup(h, { grants: CLAIM });
  const otherApp = `rs_${s.appId.slice(3)}`.slice(0, 32);
  const foreign = await seedOrder(s, {
    app_id: otherApp,
    rebate_status: 'VOID',
    reason: 'PUNISH',
    reason_sub: 'PUNISH_ORDER',
  });
  const before = await frozen(s);

  await refused(
    await setReasonSub(s, foreign.order_id, {
      reason_sub: 'FAKE_TRADE',
      expected_row_version: foreign.row_version,
    }),
    20001,
    fieldsError('order_id'),
  );
  await refused(
    await setReasonSub(s, '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6aff', {
      reason_sub: 'FAKE_TRADE',
      expected_row_version: 0,
    }),
    20001,
    fieldsError('order_id'),
  );

  expect(await frozen(s)).toEqual(before);
  const stored = await s.h.db
    .selectFrom('orders')
    .select(['reason_sub', 'reason_sub_manual', 'row_version'])
    .where('app_id', '=', otherApp)
    .where('order_id', '=', foreign.order_id)
    .executeTakeFirstOrThrow();
  expect(stored).toEqual({
    reason_sub: 'PUNISH_ORDER',
    reason_sub_manual: false,
    row_version: foreign.row_version,
  });
}, 120_000);

it('[AC-B1-09v#7] expected_row_version 不是当前 row_version：20902 data.resource=order，不改', async () => {
  const s = await setup(h, { grants: CLAIM });
  const order = await reasonedOrder(s, 'PUNISH', { reason_sub: 'PUNISH_ORDER' });
  const before = await frozen(s);

  await refused(
    await setReasonSub(s, order.order_id, {
      reason_sub: 'FAKE_TRADE',
      expected_row_version: order.row_version + 1,
    }),
    20902,
    { resource: 'order' },
  );

  expect(await frozen(s)).toEqual(before);
}, 120_000);

it('[AC-B1-09v#7] 连改两次（FAKE_TRADE，再按新 row_version 改为 none）：两条审计，第二条前值 FAKE_TRADE、后值 null；最终 reason_sub NULL、reason_sub_manual=true', async () => {
  const s = await setup(h, { grants: CLAIM });
  const order = await reasonedOrder(s, 'PUNISH', { reason_sub: 'PUNISH_ORDER' });

  await expectSet(s, order, 'FAKE_TRADE', await setOn(s, order, 'FAKE_TRADE'), 0);
  const middle = await orderNow(s, order.order_id);
  await expectSet(s, middle, NONE, await setOn(s, middle, NONE), 1);

  await expectManual(s, order.order_id, null, true);
}, 120_000);

it('[AC-B1-09v#7] 改子原因之后，同一订单再经真实导入任务来一张不带 reason_sub 的违规单：orders.reason_sub 仍是人工值、reason_sub_manual 仍 true', async () => {
  shareImportStore();
  const s = await setup(h, { grants: CLAIM });
  const w = await worker(h);
  const order = await reasonedOrder(s, 'PUNISH', { reason_sub: 'PUNISH_ORDER' });

  await setOn(s, order, 'MARKET_DISRUPT');
  await expectManual(s, order.order_id, 'MARKET_DISRUPT', true);

  await importPunish(s, w, order.platform, [order.sub_order_id], undefined, ['PN-LATER']);

  await expectManual(s, order.order_id, 'MARKET_DISRUPT', true);
  expect(await orderNow(s, order.order_id)).toMatchObject({ reason: 'PUNISH' });
}, 120_000);
