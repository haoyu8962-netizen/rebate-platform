// B2-09gb rule tests, R13 beneficiary routing (claude-independent, SPEC_REF 29c27a1b):
// contracts/openapi.yaml restoreAdminReconDiff (R13 effects) and 08 BR-CALC-09 受益人状态规则 with
// BR-FUND-22 细则「处理时再核」(D10-986 ②, D10-994) — a frozen beneficiary or one under appeal gets no
// voucher of their own and a deferred difference obligation is opened (BR-FUND-04 ⑫: kind
// deferred, opened_by R13, origin ADMIN_ADJUST / RESTORE), so UNION_RECEIVABLE nets to booked_n_fen
// less the deferred amounts (BR-FUND-19 ⑤); the share of a banned or deleted beneficiary goes to the
// platform voucher, and so does that of one being deleted (users.status deleting); a beneficiary
// whose latest share event is forfeited is owed 0 (the platform gets it), one whose forfeiture an
// account appeal undid (latest event active again, D10-481) counts as active; a cooling-off
// deletion request does not count; a difference of 0 posts nothing; a negative one posts nothing,
// takes nothing back and is recorded in resolution.restore and the audit record, the platform's
// negative difference likewise (编排 D10-994, 08 BR-FUND-22 细则「平台的负差同样只告警不写」).
// restored_fen counts only what beneficiaries' available received. Base order: N 1000 at the
// credit (reserve 1500), clawed back in full, now settled 2000 → B 1700: self 850, direct 170,
// indirect 85, platform 895. Top-level it() only.
import { expect, it } from 'vitest';
import { setCooling, shareEvents } from '../admin-recon-restore/kit.ts';
import {
  RESTORE_ACTION,
  amountIn,
  audits,
  available,
  expectAdjusted,
  fixture,
  memberLines,
  memberOf,
  netOf,
  netsOf,
  obligationsOf,
  orderRow,
  orderVouchers,
  platformKey,
  platformLines,
  platformRestored,
  restoreKey,
  seedClawedBack,
  seedPlatformDiff,
  setRisk,
  suite,
  text,
  voucherLines,
  withRestoreAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-09gb#9] R13 受益人冻结 / 申诉中（BR-CALC-09）：其正向差额延后——不写其凭证、开延后差额义务（beneficiary_credits：deferred、opened_by R13、origin ADMIN_ADJUST / RESTORE、open、无凭证）；本人照写 850、平台 895；restored_fen 850（延后的不计）；UNION_RECEIVABLE 净额 1745 = booked_n_fen 2000 − 延后 170 − 85；订单 CREDITED、booked 1700 / 2000', async () => {
  const f = await fixture(s);
  const c = await seedClawedBack(f);
  const self = c.user('self');
  const direct = c.user('direct');
  const indirect = c.user('indirect');
  await setRisk(f, direct, 'frozen');
  await setRisk(f, indirect, 'appealing');
  const diff = await seedPlatformDiff(f, c);
  await withRestoreAdmin(f, async (h) => {
    const data = await platformRestored(await h.restore(diff.id));
    expect(data.restored_fen).toBe(850);
    expect(data.rebate_status_after).toBe('CREDITED');
    await expectAdjusted(f, diff, {
      adminId: h.operator.id,
      from: 'CLAWED_BACK',
      to: 'CREDITED',
      restoredFen: 850n,
    });
    expect(await voucherLines(f, restoreKey(c.orderKey, self, 'self', diff.id))).toEqual(
      memberLines(c.platform, self, 850n),
    );
    expect(await voucherLines(f, restoreKey(c.orderKey, direct, 'direct', diff.id))).toEqual([]);
    expect(await voucherLines(f, restoreKey(c.orderKey, indirect, 'indirect', diff.id))).toEqual(
      [],
    );
    expect(await voucherLines(f, platformKey(c.orderKey, diff.id))).toEqual(
      platformLines(c.platform, 895n),
    );
    expect(await available(f, direct)).toBe(0n);
    expect(await available(f, indirect)).toBe(0n);

    const obligations = await obligationsOf(f, c.orderId);
    expect(
      obligations.map((o) => ({
        user_id: o.user_id,
        role: o.role,
        kind: o.kind,
        opened_by: o.opened_by,
        origin_ledger_type: o.origin_ledger_type,
        origin_sub_type: o.origin_sub_type,
        status: o.status,
        voucher_id: o.voucher_id,
        closed_at: o.closed_at,
      })),
    ).toEqual(
      [
        { user_id: direct, role: 'direct' },
        { user_id: indirect, role: 'indirect' },
      ]
        .map((who) => ({
          ...who,
          kind: 'deferred',
          opened_by: 'R13',
          origin_ledger_type: 'ADMIN_ADJUST',
          origin_sub_type: 'RESTORE',
          status: 'open',
          voucher_id: null,
          closed_at: null,
        }))
        .sort((a, b) =>
          a.user_id === b.user_id ? (a.role < b.role ? -1 : 1) : a.user_id < b.user_id ? -1 : 1,
        ),
    );
    for (const o of obligations) expect(o.opened_ref.length, o.role).toBeGreaterThan(0);

    const nets = await netsOf(f, c.orderKey);
    expect(nets.union_receivable_net_fen).toBe(1745n);
    expect(nets.platform_net_fen).toBe(895n);
    const order = await orderRow(f, c.orderId);
    expect(order.rebate_status).toBe('CREDITED');
    expect(order.booked_base_fen).toBe(1700n);
    expect(order.booked_n_fen).toBe(2000n);
  });
});

it('[AC-B2-09gb#10] R13 受益人封禁 / 已注销（BR-CALC-09，新应得取重拆份额与已有净额 0 的较小者）：份额归平台——平台凭证 895 + 170 + 85 = 1150，两人都没有 RESTORE 凭证、余额不变、不开义务；restored_fen 850；UNION_RECEIVABLE 净额 2000。注销冷静期（deletion_requests cooling，users.status 仍 normal）不算失效：照常补 85', async () => {
  const f = await fixture(s);
  const gone = await memberOf(f, 'deleted');
  const c = await seedClawedBack(f, {
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000 },
      { role: 'indirect', ratioBp: 500, userId: gone },
    ],
  });
  const banned = c.user('direct');
  await setRisk(f, banned, 'banned');
  const cooling = await seedClawedBack(f);
  await setCooling(f, cooling.user('indirect'));
  await withRestoreAdmin(f, async (h) => {
    const diff = await seedPlatformDiff(f, c);
    const data = await platformRestored(await h.restore(diff.id));
    expect(data.restored_fen).toBe(850);
    expect(await voucherLines(f, restoreKey(c.orderKey, banned, 'direct', diff.id))).toEqual([]);
    expect(await voucherLines(f, restoreKey(c.orderKey, gone, 'indirect', diff.id))).toEqual([]);
    expect(await voucherLines(f, platformKey(c.orderKey, diff.id))).toEqual(
      platformLines(c.platform, 1150n),
    );
    expect(await available(f, banned)).toBe(0n);
    expect(await available(f, gone)).toBe(0n);
    expect(await obligationsOf(f, c.orderId)).toEqual([]);
    const nets = await netsOf(f, c.orderKey);
    expect(nets.union_receivable_net_fen).toBe(2000n);
    expect(nets.platform_net_fen).toBe(1150n);

    const coolingDiff = await seedPlatformDiff(f, cooling);
    expect((await platformRestored(await h.restore(coolingDiff.id))).restored_fen).toBe(1105);
    const member = cooling.user('indirect');
    expect(
      await voucherLines(f, restoreKey(cooling.orderKey, member, 'indirect', coolingDiff.id)),
    ).toEqual(memberLines(cooling.platform, member, 85n));
  });
});

it('[AC-B2-09gb#11] R13 入账时被剥夺的份额（最新份额事件为 forfeited，BR-CALC-09「新应得恒为 0」）：即使会员现在正常也不补，归平台——平台 895 + 170 = 1065；本人 850、间推 85，restored_fen 935；直推没有 RESTORE 凭证、余额 0', async () => {
  const f = await fixture(s);
  const c = await seedClawedBack(f, {
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, forfeited: true },
      { role: 'indirect', ratioBp: 500 },
    ],
  });
  const direct = c.user('direct');
  const diff = await seedPlatformDiff(f, c);
  await withRestoreAdmin(f, async (h) => {
    const data = await platformRestored(await h.restore(diff.id));
    expect(data.restored_fen).toBe(935);
    expect(await voucherLines(f, restoreKey(c.orderKey, direct, 'direct', diff.id))).toEqual([]);
    expect(await voucherLines(f, platformKey(c.orderKey, diff.id))).toEqual(
      platformLines(c.platform, 1065n),
    );
    expect(await available(f, direct)).toBe(0n);
    const nets = await netsOf(f, c.orderKey);
    expect(nets.union_receivable_net_fen).toBe(2000n);
    expect(nets.platform_net_fen).toBe(1065n);
  });
});

it('[AC-B2-09gb#12] 处理时再核（D10-986 ②、D10-994）：受益人差额为 0 不写分录；小于 0（本人净额 850 = 应得 850 → 0；直推净额 200 > 应得 170 → −30）不写分录、不扣用户的钱，并写进 resolution.restore 与本次审计（受益人、角色、负差额）；间推 85、平台 895 照写；restored_fen 85', async () => {
  const f = await fixture(s);
  const c = await seedClawedBack(f, {
    residual: [
      { role: 'self', fen: 850n },
      { role: 'direct', fen: 200n },
    ],
  });
  const self = c.user('self');
  const direct = c.user('direct');
  const indirect = c.user('indirect');
  const diff = await seedPlatformDiff(f, c);
  await withRestoreAdmin(f, async (h) => {
    const data = await platformRestored(await h.restore(diff.id));
    expect(data.restored_fen).toBe(85);
    const { restore } = await expectAdjusted(f, diff, {
      adminId: h.operator.id,
      from: 'CLAWED_BACK',
      to: 'CREDITED',
      restoredFen: 85n,
    });
    expect(await voucherLines(f, restoreKey(c.orderKey, self, 'self', diff.id))).toEqual([]);
    expect(await voucherLines(f, restoreKey(c.orderKey, direct, 'direct', diff.id))).toEqual([]);
    expect(await voucherLines(f, restoreKey(c.orderKey, indirect, 'indirect', diff.id))).toEqual(
      memberLines(c.platform, indirect, 85n),
    );
    expect(await voucherLines(f, platformKey(c.orderKey, diff.id))).toEqual(
      platformLines(c.platform, 895n),
    );
    expect(await available(f, self)).toBe(850n);
    expect(await available(f, direct)).toBe(200n);

    const recorded = text(restore);
    expect(recorded).toContain(direct);
    expect(recorded).toContain('"direct"');
    expect(amountIn(recorded, -30n), recorded).toBe(true);
    const records = await audits(f, RESTORE_ACTION);
    expect(records).toHaveLength(1);
    const audited = text(records[0]!.after);
    expect(audited).toContain(direct);
    expect(amountIn(audited, -30n), audited).toBe(true);
  });
});

it('[AC-B2-09gb#25] R13 被剥夺判定取最新份额事件（D10-481：从 initial_status 起按 event_seq 取最新，最新为 forfeited 才算被剥夺）：入账时直推被封禁（active → forfeited，85 进平台 FORFEIT），之后账户申诉撤销、申诉恢复追加 active 并补 85，订单再被全额扣回、联盟恢复佣金 2000 → 直推按 active 计：RESTORE +170（余额 0 → 170）、本人 850、间推 85、平台 895，restored_fen 1105，不开义务；UNION_RECEIVABLE 净额 2000', async () => {
  const f = await fixture(s);
  const c = await seedClawedBack(f, {
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, forfeited: true },
      { role: 'indirect', ratioBp: 500 },
    ],
    appealRestored: ['direct'],
  });
  const self = c.user('self');
  const direct = c.user('direct');
  const indirect = c.user('indirect');
  // The fixture: direct's events are active → forfeited → active, its net 0 after the clawback.
  const events = (await shareEvents(f, c.orderId)).filter(
    (e) => e.user_id === direct && e.role === 'direct',
  );
  expect(events.map((e) => e.status)).toEqual(['active', 'forfeited', 'active']);
  const before = await netsOf(f, c.orderKey);
  expect(netOf(before, direct, 'direct')).toBe(0n);
  expect(before.platform_net_fen).toBe(0n);
  expect(before.union_receivable_net_fen).toBe(0n);
  expect(await available(f, direct)).toBe(0n);

  const diff = await seedPlatformDiff(f, c);
  await withRestoreAdmin(f, async (h) => {
    const data = await platformRestored(await h.restore(diff.id));
    expect(data.restored_fen).toBe(1105);
    expect(data.rebate_status_after).toBe('CREDITED');
    await expectAdjusted(f, diff, {
      adminId: h.operator.id,
      from: 'CLAWED_BACK',
      to: 'CREDITED',
      restoredFen: 1105n,
    });
    expect(await voucherLines(f, restoreKey(c.orderKey, direct, 'direct', diff.id))).toEqual(
      memberLines(c.platform, direct, 170n),
    );
    expect(await voucherLines(f, restoreKey(c.orderKey, self, 'self', diff.id))).toEqual(
      memberLines(c.platform, self, 850n),
    );
    expect(await voucherLines(f, restoreKey(c.orderKey, indirect, 'indirect', diff.id))).toEqual(
      memberLines(c.platform, indirect, 85n),
    );
    expect(await voucherLines(f, platformKey(c.orderKey, diff.id))).toEqual(
      platformLines(c.platform, 895n),
    );
    expect(await available(f, direct)).toBe(170n);
    expect(await obligationsOf(f, c.orderId)).toEqual([]);
    const nets = await netsOf(f, c.orderKey);
    expect(netOf(nets, direct, 'direct')).toBe(170n);
    expect(nets.platform_net_fen).toBe(895n);
    expect(nets.union_receivable_net_fen).toBe(2000n);
  });
});

it('[AC-B2-09gb#26] R13 受益人注销中（users.status = deleting，BR-CALC-09，与已注销同）：其份额并入平台凭证——平台 895 + 85 = 980，该成员没有 RESTORE 凭证、余额 0、不开义务；本人 850、直推 170，restored_fen 1020；UNION_RECEIVABLE 净额 2000', async () => {
  const f = await fixture(s);
  const leaving = await memberOf(f, 'deleting');
  const c = await seedClawedBack(f, {
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000 },
      { role: 'indirect', ratioBp: 500, userId: leaving },
    ],
  });
  const self = c.user('self');
  const direct = c.user('direct');
  const diff = await seedPlatformDiff(f, c);
  await withRestoreAdmin(f, async (h) => {
    const data = await platformRestored(await h.restore(diff.id));
    expect(data.restored_fen).toBe(1020);
    await expectAdjusted(f, diff, {
      adminId: h.operator.id,
      from: 'CLAWED_BACK',
      to: 'CREDITED',
      restoredFen: 1020n,
    });
    expect(await voucherLines(f, restoreKey(c.orderKey, leaving, 'indirect', diff.id))).toEqual([]);
    expect(await voucherLines(f, restoreKey(c.orderKey, self, 'self', diff.id))).toEqual(
      memberLines(c.platform, self, 850n),
    );
    expect(await voucherLines(f, restoreKey(c.orderKey, direct, 'direct', diff.id))).toEqual(
      memberLines(c.platform, direct, 170n),
    );
    expect(await voucherLines(f, platformKey(c.orderKey, diff.id))).toEqual(
      platformLines(c.platform, 980n),
    );
    expect(await available(f, leaving)).toBe(0n);
    expect(await obligationsOf(f, c.orderId)).toEqual([]);
    const nets = await netsOf(f, c.orderKey);
    expect(netOf(nets, leaving, 'indirect')).toBe(0n);
    expect(nets.platform_net_fen).toBe(980n);
    expect(nets.union_receivable_net_fen).toBe(2000n);
    const order = await orderRow(f, c.orderId);
    expect(order.rebate_status).toBe('CREDITED');
  });
});

it('[AC-B2-09gb#27] 处理时再核（D10-994，08 BR-FUND-22 细则「平台的负差同样只告警不写」）：扣回后平台净额仍为 1000（合成），R13 平台应得 895 → 差额 −105：不写 {order_key}:PLATFORM:RESTORE:{id}、平台净额仍 1000，resolution.restore 与本次审计记下 −105；受益人正差照写 850 / 170 / 85，restored_fen 1105，恢复照常完成：CREDITED、booked 1700 / 2000', async () => {
  const f = await fixture(s);
  const c = await seedClawedBack(f, { platformResidual: 1000n });
  const self = c.user('self');
  const direct = c.user('direct');
  const indirect = c.user('indirect');
  const before = await netsOf(f, c.orderKey);
  expect(before.platform_net_fen, 'fixture').toBe(1000n);
  expect(before.union_receivable_net_fen, 'fixture').toBe(1000n);
  const diff = await seedPlatformDiff(f, c);
  await withRestoreAdmin(f, async (h) => {
    const data = await platformRestored(await h.restore(diff.id));
    expect(data.restored_fen).toBe(1105);
    expect(data.rebate_status_after).toBe('CREDITED');
    const { restore } = await expectAdjusted(f, diff, {
      adminId: h.operator.id,
      from: 'CLAWED_BACK',
      to: 'CREDITED',
      restoredFen: 1105n,
    });
    expect(await voucherLines(f, platformKey(c.orderKey, diff.id))).toEqual([]);
    const selfKey = restoreKey(c.orderKey, self, 'self', diff.id);
    const directKey = restoreKey(c.orderKey, direct, 'direct', diff.id);
    const indirectKey = restoreKey(c.orderKey, indirect, 'indirect', diff.id);
    expect(
      (await orderVouchers(f, c.orderKey))
        .map((v) => v.uniq_key)
        .filter((key) => key.includes(':RESTORE:'))
        .sort(),
    ).toEqual([selfKey, directKey, indirectKey].sort());
    expect(await voucherLines(f, selfKey)).toEqual(memberLines(c.platform, self, 850n));
    expect(await voucherLines(f, directKey)).toEqual(memberLines(c.platform, direct, 170n));
    expect(await voucherLines(f, indirectKey)).toEqual(memberLines(c.platform, indirect, 85n));

    const nets = await netsOf(f, c.orderKey);
    expect(nets.platform_net_fen).toBe(1000n);
    expect(nets.union_receivable_net_fen).toBe(2105n);
    const order = await orderRow(f, c.orderId);
    expect(order.rebate_status).toBe('CREDITED');
    expect(order.booked_base_fen).toBe(1700n);
    expect(order.booked_n_fen).toBe(2000n);

    const recorded = text(restore);
    expect(amountIn(recorded, -105n), recorded).toBe(true);
    const records = await audits(f, RESTORE_ACTION);
    expect(records).toHaveLength(1);
    const audited = text(records[0]!.after);
    expect(amountIn(audited, -105n), audited).toBe(true);
  });
});
