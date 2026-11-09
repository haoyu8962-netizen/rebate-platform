// B1-10m: the writes reach the real ports, end to end through the admin entry: a claim approval and
// an assignment attribute the order through settlement's R3 / R3b (never a placeholder's 50001), with
// commission's snapshot port, the source backfill, risk's and identity's target readers and the
// event bus; hold / unhold change the hold through settlement's rebate command (R11).
// Expected values by hand from contracts/openapi.yaml, 08 BR-FUND-01 R3 / R3b / R4 / R11, BR-ATTR-20,
// BR-ATTR-31. The order's slot scene reaches the backfill and the snapshot from union_pids whatever
// the slot's status (BR-ATTR-02), and only identity's deletion stage knows a cooling target
// (BR-CALC-19, BR-ATTR-15, BR-ATTR-31 细则).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import {
  ADMIN_NAME,
  ANSWER,
  GRANTS,
  NOTE,
  REASON,
  RECEIVED_AT,
  accepted,
  attributedOrder,
  itemPath,
  orderNow,
  orderPath,
  refused,
  seedClaim,
  seedClick,
  seedCoolingDeletion,
  seedOrder,
  seedPid,
  seedRiskState,
  setup,
  snapshotOf,
  type Order,
  type Scenario,
} from './kit.ts';

const h = useHarness();

const LIFECYCLE = [
  ['PAID 未收货', 'ESTIMATED', null, {}],
  [
    '已收货（R3 后同事务走 R4）',
    'WAITING',
    '2026-10',
    { platform_status: 'RECEIVED', received_at: RECEIVED_AT },
  ],
] as const;

it.each(LIFECYCLE)(
  '[AC-B1-10m#12] 找回通过经真实 settlement：%s → 订单归申请人、locked、返利状态 %s，子项与申请结案，写历史、快照待处理、来源回填与 claim.resolved',
  async (_label, status, period, patch) => {
    const s = await setup(h, { grants: GRANTS.approve });
    const order = await seedOrder(s, patch);
    const { claim, item } = await seedClaim(s, order);
    const response = await s.post(itemPath(claim.id, item.id, 'approve'), {
      expected_row_version: item.row_version,
      reason: REASON,
    });
    const detail = await accepted(response, ANSWER.approve);
    expect(detail).toMatchObject({
      claim_id: claim.id,
      status: 'approved',
      reason: REASON,
      items: [{ item_id: item.id, decision: 'approved', decided_by: s.admin.id }],
    });
    const now = await orderNow(s, order.order_id);
    expect(now).toMatchObject({
      user_id: s.userId,
      user_basis: 'claim',
      locked: true,
      rebate_status: status,
      settle_period: period,
      platform_status: order.platform_status,
    });
    // BR-ATTR-15: the source backfill ran (no link record here: none, not left empty).
    expect(now.source_match).toBe('none');
    const after = await s.state();
    expect(after.history).toEqual([
      expect.objectContaining({
        order_id: order.order_id,
        field: 'rebate',
        from_status: 'UNATTRIBUTED',
        to_status: status,
        source: 'claim',
      }),
    ]);
    // commission's real port was called: no published rule version here leaves a pending record.
    expect(after.pending).toEqual([
      expect.objectContaining({
        order_id: order.order_id,
        reason: 'RULE_VERSION_PLATFORM_MISSING',
      }),
    ]);
    expect(await s.events()).toContain('claim.resolved');
  },
  120_000,
);

it('[AC-B1-10m#13] 找回驳回：子项按客服原因驳回、申请结案，订单不动', async () => {
  const s = await setup(h, { grants: GRANTS.reject });
  const order = await seedOrder(s);
  const { claim, item } = await seedClaim(s, order);
  const response = await s.post(itemPath(claim.id, item.id, 'reject'), {
    expected_row_version: item.row_version,
    reason: REASON,
    reject_reason: 'NOT_TRACKED',
  });
  expect(await accepted(response, ANSWER.reject)).toMatchObject({
    status: 'rejected',
    items: [{ item_id: item.id, decision: 'rejected', reject_reason: 'NOT_TRACKED' }],
  });
  expect(await orderNow(s, order.order_id)).toEqual(order);
  expect(await s.events()).toContain('claim.resolved');
}, 120_000);

async function assign(s: Scenario, orderId: string, userId: string, locked = false) {
  return s.post(
    orderPath(orderId, 'reassign'),
    { user_id: userId, expected_user_id: null, expected_locked: locked, reason: REASON },
    { stepUp: await s.stepUp(s.admin) },
  );
}

it.each(LIFECYCLE)(
  '[AC-B1-10m#14] 指定归属经真实 settlement：%s → 订单归目标用户、locked、返利状态 %s，写指派记录、历史、快照待处理、来源回填与 order.reassigned',
  async (_label, status, period, patch) => {
    const s = await setup(h, { grants: GRANTS.reassign });
    const order = await seedOrder(s, patch);
    const detail = await accepted(await assign(s, order.order_id, s.userId), ANSWER.reassign);
    expect(detail).toMatchObject({
      order_id: order.order_id,
      user: { user_id: s.userId },
      user_basis: 'admin',
      flags: { locked: true },
    });
    const now = await orderNow(s, order.order_id);
    expect(now).toMatchObject({
      user_id: s.userId,
      user_basis: 'admin',
      locked: true,
      rebate_status: status,
      settle_period: period,
    });
    expect(now.source_match).toBe('none');
    const after = await s.state();
    expect(after.assignments).toEqual([
      expect.objectContaining({
        order_id: order.order_id,
        to_user_id: s.userId,
        source: 'admin',
        admin_id: s.admin.id,
        reason: REASON,
      }),
    ]);
    expect(after.history).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: 'UNATTRIBUTED',
        to_status: status,
        source: 'admin',
      }),
    ]);
    expect(after.pending).toEqual([
      expect.objectContaining({ reason: 'RULE_VERSION_PLATFORM_MISSING' }),
    ]);
    expect(await s.events()).toContain('order.reassigned');
  },
  120_000,
);

it('[AC-B1-10m#15] 指定归属 VOID 单走真实 R3b：返利状态不变、locked，不生成快照', async () => {
  const s = await setup(h, { grants: GRANTS.reassign });
  const order = await seedOrder(s, {
    platform_status: 'INVALID',
    rebate_status: 'VOID',
    reason: 'REFUND',
  });
  await accepted(await assign(s, order.order_id, s.userId), ANSWER.reassign);
  expect(await orderNow(s, order.order_id)).toMatchObject({
    user_id: s.userId,
    user_basis: 'admin',
    locked: true,
    rebate_status: 'VOID',
  });
  expect((await s.state()).pending).toEqual([]);
}, 120_000);

it.each([
  [
    '封禁（risk 的真实状态读取）',
    async (s: Scenario) => {
      await seedRiskState(s, s.userId, 'banned');
      return s.userId;
    },
    'target_banned',
  ],
  [
    '已注销（identity 的真实注销阶段读取）',
    (s: Scenario) => seedUser(s.h.db, s.appId, { status: 'deleted' }),
    'target_deleted',
  ],
  [
    '在注销冷静期（deletion_requests.status=cooling、users.status=normal，identity 的真实注销阶段读取）',
    async (s: Scenario) => {
      const userId = await seedUser(s.h.db, s.appId);
      await seedCoolingDeletion(s, userId);
      return userId;
    },
    'target_deleting',
  ],
] as const)(
  '[AC-B1-10m#16] 指定归属的目标用户%s → 20001 [user_id] 与 data.reason，订单不动，审计记被拒',
  async (_label, target, reason) => {
    const s = await setup(h, { grants: GRANTS.reassign });
    const order = await seedOrder(s);
    const userId = await target(s);
    await refused(await assign(s, order.order_id, userId), 20001, {
      fields: ['user_id'],
      reason,
    });
    expect(await orderNow(s, order.order_id)).toEqual(order);
    const after = await s.state();
    expect(after.assignments).toEqual([]);
    expect(after.audits).toEqual([
      expect.objectContaining({ action: 'order_assign', target: `orders:${order.order_id}` }),
    ]);
  },
  120_000,
);

it('[AC-B1-10m#17] 指定归属的目标用户冻结 → 照常指派（BR-ATTR-31 细则）', async () => {
  const s = await setup(h, { grants: GRANTS.reassign });
  const order = await seedOrder(s);
  await seedRiskState(s, s.userId, 'frozen');
  await accepted(await assign(s, order.order_id, s.userId), ANSWER.reassign);
  expect(await orderNow(s, order.order_id)).toMatchObject({ user_id: s.userId, locked: true });
}, 120_000);

it('[AC-B1-10m#18] hold 经真实 rebate 命令：hold 与原因写入、row_version + 1、返利状态不变；响应带最新暂停记录', async () => {
  const s = await setup(h, { grants: [...GRANTS.hold, 'order.view'] });
  const order = await attributedOrder(s);
  const response = await s.post(orderPath(order.order_id, 'hold'), {
    reason_code: 'CS',
    note: NOTE,
    expected_row_version: order.row_version,
  });
  expect(await accepted(response, ANSWER.hold)).toMatchObject({
    order_id: order.order_id,
    hold_reason: 'CS',
    flags: { hold: true },
    last_hold_by: s.admin.id,
    last_hold_by_name: ADMIN_NAME,
    last_hold_note: NOTE,
  });
  expect(await orderNow(s, order.order_id)).toMatchObject({
    hold: true,
    hold_reason: 'CS',
    rebate_status: 'ESTIMATED',
    row_version: order.row_version + 1,
  });
}, 120_000);

it('[AC-B1-10m#19] unhold 经真实 rebate 命令：解除暂停、清原因、row_version + 1、返利状态不变', async () => {
  const s = await setup(h, { grants: GRANTS.unhold });
  const order = await attributedOrder(s, { hold: true, hold_reason: 'CS' });
  const response = await s.post(orderPath(order.order_id, 'unhold'), {
    reason_code: 'CS',
    note: NOTE,
    expected_row_version: order.row_version,
  });
  expect(await accepted(response, ANSWER.unhold)).toMatchObject({
    order_id: order.order_id,
    hold_reason: null,
    flags: { hold: false },
  });
  expect(await orderNow(s, order.order_id)).toMatchObject({
    hold: false,
    hold_reason: null,
    rebate_status: 'ESTIMATED',
    row_version: order.row_version + 1,
  });
}, 120_000);

it.each([
  ['order.claim 且无 risk.*', ['order.hold', 'order.claim'], 'CS'],
  ['risk.* 且无 order.claim', ['order.hold', 'risk.appeal'], 'RISK'],
] as const)(
  '[AC-B1-10m#20] hold 不带 reason_code：%s，原因经 admin 的真实权限读取推出',
  async (_label, grants, derived) => {
    const s = await setup(h, { grants });
    const order = await attributedOrder(s);
    const response = await s.post(orderPath(order.order_id, 'hold'), {
      note: NOTE,
      expected_row_version: order.row_version,
    });
    await accepted(response, ANSWER.hold);
    expect(await orderNow(s, order.order_id)).toMatchObject({ hold: true, hold_reason: derived });
  },
  120_000,
);

it('[AC-B1-10m#21] hold 的起始状态不符（UNATTRIBUTED）→ 20902 order，订单不动', async () => {
  const s = await setup(h, { grants: GRANTS.hold });
  const order = await seedOrder(s);
  await refused(
    await s.post(orderPath(order.order_id, 'hold'), {
      reason_code: 'CS',
      note: NOTE,
      expected_row_version: order.row_version,
    }),
    20902,
    { resource: 'order' },
  );
  expect(await orderNow(s, order.order_id)).toEqual(order);
}, 120_000);

/** The order's attribution through the real entry: a claim approval or an assignment. */
async function attribute(s: Scenario, action: 'approve' | 'reassign', order: Order) {
  if (action === 'reassign') {
    return accepted(await assign(s, order.order_id, s.userId), ANSWER.reassign);
  }
  const { claim, item } = await seedClaim(s, order);
  const response = await s.post(itemPath(claim.id, item.id, 'approve'), {
    expected_row_version: item.row_version,
    reason: REASON,
  });
  return accepted(response, ANSWER.approve);
}

it.each(['approve', 'reassign'] as const)(
  '[AC-B1-10m#27] %s 淘礼金推广位的订单：真实快照 rebate_mode=none、用户份额 0、红包面额与平台预估利润记空，写 TLJ_FACE_VALUE_UNMATCHED 待处理（BR-CALC-19，不按普通返利算）',
  async (action) => {
    const s = await setup(h, { grants: GRANTS[action] });
    await seedVersion(s.h.db, s.appId, version());
    const pid = await seedPid(s, 'taobao', 'taolijin');
    const order = await seedOrder(s, { platform: 'taobao', pid });
    await attribute(s, action, order);
    expect(await orderNow(s, order.order_id)).toMatchObject({
      user_id: s.userId,
      locked: true,
      rebate_status: 'ESTIMATED',
    });
    expect((await s.state()).pending).toEqual([
      expect.objectContaining({ order_id: order.order_id, reason: 'TLJ_FACE_VALUE_UNMATCHED' }),
    ]);
    const { splits, totals } = await snapshotOf(s, order.order_id);
    expect(splits).toEqual([expect.objectContaining({ rebate_mode: 'none', raw_n_fen: 1200n })]);
    expect(totals).toEqual([
      expect.objectContaining({
        n_total_fen: 1200n,
        user_share_total_fen: 0n,
        tlj_redpacket_fen: null,
        platform_est_profit_fen: null,
      }),
    ]);
  },
  120_000,
);

it.each(['approve', 'reassign'] as const)(
  '[AC-B1-10m#28] %s 普通推广位的同样订单：快照 rebate_mode 为空、按规则分用户份额（1200 × 50%%），没有淘礼金待处理',
  async (action) => {
    const s = await setup(h, { grants: GRANTS[action] });
    await seedVersion(s.h.db, s.appId, version());
    const pid = await seedPid(s, 'taobao', 'self_buy');
    const order = await seedOrder(s, { platform: 'taobao', pid });
    await attribute(s, action, order);
    expect((await s.state()).pending).toEqual([]);
    const { splits, totals } = await snapshotOf(s, order.order_id);
    expect(splits).toEqual([expect.objectContaining({ rebate_mode: null, raw_n_fen: 1200n })]);
    expect(totals).toEqual([
      expect.objectContaining({
        n_total_fen: 1200n,
        user_share_total_fen: 600n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 600n,
      }),
    ]);
  },
  120_000,
);

it.each(['approve', 'reassign'] as const)(
  '[AC-B1-10m#29] %s：link_logs 有同用户同商品同推广位场景的点击 → 来源回填命中 product，link_id 与 source_scene 取自点击，不是 none（BR-ATTR-15）',
  async (action) => {
    const s = await setup(h, { grants: GRANTS[action] });
    const pid = await seedPid(s, 'jd', 'self_buy');
    const order = await seedOrder(s, { pid });
    const linkId = await seedClick(s, order, s.userId, 'self_buy');
    await attribute(s, action, order);
    expect(await orderNow(s, order.order_id)).toMatchObject({
      user_id: s.userId,
      source_match: 'product',
      link_id: linkId,
      source_scene: 'search',
    });
  },
  120_000,
);

it.each([
  ['expected_locked=true 打未锁单', (s: Scenario) => seedOrder(s), true],
  [
    '已归属他人的单',
    async (s: Scenario) => attributedOrder(s, { user_id: await seedUser(s.h.db, s.appId) }),
    false,
  ],
] as const)(
  '[AC-B1-10m#30] 指定归属复查不过（%s）→ 20902 order_attribution，订单不变，不写指派记录与审计',
  async (_label, seed, locked) => {
    const s = await setup(h, { grants: GRANTS.reassign });
    const order = await seed(s);
    await refused(await assign(s, order.order_id, s.userId, locked), 20902, {
      resource: 'order_attribution',
    });
    expect(await orderNow(s, order.order_id)).toEqual(order);
    const after = await s.state();
    expect(after.assignments).toEqual([]);
    expect(after.audits).toEqual([]);
  },
  120_000,
);

it.each(['approve', 'reassign'] as const)(
  '[AC-B1-10m#31] %s 退役（status=retired）淘礼金推广位的订单：推广位场景读取不按 active 过滤（pending / active / retired 三态都算），真实快照 rebate_mode=none、用户份额 0，写 TLJ_FACE_VALUE_UNMATCHED 待处理（BR-ATTR-02、BR-CALC-19）',
  async (action) => {
    const s = await setup(h, { grants: GRANTS[action] });
    await seedVersion(s.h.db, s.appId, version());
    const pid = await seedPid(s, 'taobao', 'taolijin');
    await s.h.db
      .updateTable('union_pids')
      .set({ status: 'retired' })
      .where('app_id', '=', s.appId)
      .where('pid', '=', pid)
      .returning('status')
      .executeTakeFirstOrThrow();
    const order = await seedOrder(s, { platform: 'taobao', pid });
    await attribute(s, action, order);
    expect(await orderNow(s, order.order_id)).toMatchObject({
      user_id: s.userId,
      locked: true,
      rebate_status: 'ESTIMATED',
    });
    expect((await s.state()).pending).toEqual([
      expect.objectContaining({ order_id: order.order_id, reason: 'TLJ_FACE_VALUE_UNMATCHED' }),
    ]);
    const { splits, totals } = await snapshotOf(s, order.order_id);
    expect(splits).toEqual([expect.objectContaining({ rebate_mode: 'none', raw_n_fen: 1200n })]);
    expect(totals).toEqual([
      expect.objectContaining({
        n_total_fen: 1200n,
        user_share_total_fen: 0n,
        tlj_redpacket_fen: null,
        platform_est_profit_fen: null,
      }),
    ]);
  },
  120_000,
);
