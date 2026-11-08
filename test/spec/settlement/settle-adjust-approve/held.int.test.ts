// B2-09zc rule tests, attempt 3 (claude-independent, SPEC_REF b79958d; spec-test review r1 gaps 1–3).
// 1. A beneficiary held at credit (frozen: no voucher, one open first_credit obligation, net 0) who is
//    banned / deleting / deleted when the candidate is approved: 08 BR-CALC-09 (封禁、已注销 → 正向差额归平台；
//    封禁或已注销的受益人新应得取重拆份额与其已有净额中较小的一个), BR-FUND-09 (两路中受益人有未完成的待补记义务而本次把
//    其剩余未履约金额归了平台（封禁、已注销）……的，同一事务关闭该义务), BR-FUND-04 ⑫; 08 §13.7: the share is given
//    to the platform once, here, and the obligation is closed forfeited in the same transaction (a later
//    补记项 must not forfeit it again), with one forfeited beneficiary event (as the negative route does,
//    settle-diff-sync [AC-B2-04zi#20] / [AC-B2-04zi#21]).
// 2. Approval recomputes with the order's snapshot reserve_bp (BR-CALC-02 「快照按 paid_at 选定规则版本时同时取定该
//    订单平台的 reserve_bp，此后入账与调整重算都用快照中的 reserve_bp」; BR-FUND-09 「先把 settle_commission_fen 按
//    BR-CALC-02 用快照 reserve_bp 换算成结算基数 B_settle」), never the platform's current rule.
// 3. A beneficiary held at credit and still frozen at approval: D10-770 ② (冻结受益人……批准时其正差转为待补记义务)
//    with an obligation already open — the order keeps exactly that one open obligation (BR-FUND-04 ⑫ 补记项
//    pays 重拆份额 − 用户净额 when it runs; a second open row would hit beneficiary_credits_open_key).
// Amounts by hand (BR-CALC-02 / BR-CALC-04): self 5000 bp, direct 1000 bp.
import { expect, it } from 'vitest';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
import {
  EXAMPLE,
  TIMEOUT,
  approveHarness,
  approveSuite,
  expectApproved,
  ordered,
  platformIncrease,
  result,
  userIncrease,
  withAdmin,
  type OrderSpec,
} from './kit.ts';

const s = approveSuite();

/** Reserve 0; direct frozen when credited: self 617, direct held (first_credit 123), platform 494. */
const DIRECT_HELD: OrderSpec = {
  settleFen: 1234n,
  reserveBp: 0,
  people: [
    { role: 'self', ratioBp: 5000 },
    { role: 'direct', ratioBp: 1000, state: 'frozen' },
  ],
};

/** Reserve 0; self frozen when credited: self held (first_credit 617), direct 123, platform 494. */
const SELF_HELD: OrderSpec = {
  settleFen: 1234n,
  reserveBp: 0,
  people: [
    { role: 'self', ratioBp: 5000, state: 'frozen' },
    { role: 'direct', ratioBp: 1000 },
  ],
};

const GONE = [
  { label: '封禁', state: 'banned', reason: 'banned' },
  { label: '注销处理中', state: 'deleting', reason: 'deleted' },
  { label: '已注销', state: 'deleted', reason: 'deleted' },
] as const;

it.each(GONE)(
  '[AC-B2-09zc#3] 直推入账时冻结（first_credit 待补 123、净额 0），结算 1300 生成候选后直推$label，批准：直推新份额 130 归平台（平台 *:PLATFORM:INCREASE +156 = 26 + 130），不写直推凭证、余额 0；本人 +33，credited_fen 33，应收 1300；该义务同一事务 forfeited（closed_at = 时钟），追加一条 forfeited 受益人事件（reason $reason）',
  async ({ state, reason }) => {
    const h = await approveHarness(s);
    const { o, seq } = await h.raised(DIRECT_HELD, 1300n);
    // Credit left the direct share held: no voucher, one open first_credit obligation.
    expect(await h.netOf(o, 'direct')).toBe(0n);
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.balance(o.user('self'))).toBe(617n);
    expect(await h.receivableOf(o)).toBe(1111n);
    const before = await h.orderObligations(o);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      user_id: o.user('direct'),
      role: 'direct',
      kind: 'first_credit',
      status: 'open',
    });
    const batchId = await h.generate();
    expect(ordered(await h.rowsOf(o)).find((r) => r.role === 'self')?.diff_fen).toBe(33n);
    h.clock.advanceMs(60_000);
    if (state === 'banned') {
      await h.risk(o.user('direct'), 'banned');
    } else {
      await h.setRisk(h.db, o.user('direct'), 'normal');
      if (state === 'deleting') await h.markDeleting(o.user('direct'));
      else await h.markDeleted(o.user('direct'));
    }
    const forfeitedEvents = async () =>
      (await h.beneficiaryEvents(o)).filter((e) => e.status === 'forfeited');
    expect(await forfeitedEvents()).toEqual([]);
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 33)]);
      // Platform: own 520 plus direct's 130 given to it = 650; its net was 494, so +156.
      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'self', 33n, seq),
        ...platformIncrease(o, 156n, seq),
      ]);
      const directLines = (await h.adjLinesOf(o)).filter((l) => l.owner_id === o.user('direct'));
      expect(directLines).toEqual([]);
      expect(await h.balance(o.user('direct'))).toBe(0n);
      expect(await h.netOf(o, 'direct')).toBe(0n);
      expect(await h.balance(o.user('self'))).toBe(650n);
      expect(await h.receivableOf(o)).toBe(1300n);
      expect(await h.read(o)).toMatchObject({ booked_base_fen: 1300n, booked_n_fen: 1300n });
      const after = await h.orderObligations(o);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        beneficiary_credit_id: before[0]!.beneficiary_credit_id,
        user_id: o.user('direct'),
        role: 'direct',
        status: 'forfeited',
        closed_at: h.clock.now(),
      });
      expect(await forfeitedEvents()).toMatchObject([
        {
          user_id: o.user('direct'),
          role: 'direct',
          status: 'forfeited',
          reason,
          created_at: h.clock.now(),
        },
      ]);
      expect((await h.rowsOf(o)).every((r) => r.status === 'approved')).toBe(true);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#2] 批准按订单快照 reserve 2000 重算，不读平台当前规则：入账 N 1000 → B 800（本人 400、直推 80、平台 320 + 200 = 520）；入账后该平台发布 reserve 3000 的新规则并已生效；结算 1250 批准 → B_settle = floor(1250 × 8000 / 10000) = 1000：本人 +100、直推 +20、平台 650 − 520 = +130，credited_fen 120，booked 1000 / 1250（不得出现按 3000 算的 +37 / +7 / +206、booked 875）',
  async () => {
    const h = await approveHarness(s);
    const spec: OrderSpec = { ...EXAMPLE, settleFen: 1000n, reserveBp: 2000 };
    const { o, seq } = await h.raised(spec, 1250n);
    expect(await h.balance(o.user('self'))).toBe(400n);
    expect(await h.balance(o.user('direct'))).toBe(80n);
    expect(await h.read(o)).toMatchObject({ booked_base_fen: 800n, booked_n_fen: 1000n });
    const batchId = await h.generate();
    expect(ordered(await h.rowsOf(o)).map((r) => [r.role, r.diff_fen])).toEqual([
      ['self', 100n],
      ['direct', 20n],
      [null, 130n],
    ]);
    const snapshotReserve = () =>
      h.db
        .selectFrom('commission_splits')
        .select('reserve_bp')
        .where('app_id', '=', h.appId)
        .where('order_id', '=', o.orderId)
        .executeTakeFirstOrThrow();
    expect(await snapshotReserve()).toEqual({ reserve_bp: 2000 });

    // A later published version (append-only), effective before the approval.
    h.clock.advanceMs(60_000);
    const later = version({
      effective_from: h.clock.now(),
      reserves: [
        { platform: 'taobao', reserve_bp: 3000 },
        { platform: 'jd', reserve_bp: 3000 },
        { platform: 'pdd', reserve_bp: 3000 },
      ],
    });
    await seedVersion(h.db, h.appId, later);
    h.clock.advanceMs(60_000);
    expect(h.clock.now().getTime()).toBeGreaterThan(later.effective_from.getTime());

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 120)]);
      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'self', 100n, seq),
        ...userIncrease(o, 'direct', 20n, seq),
        ...platformIncrease(o, 130n, seq),
      ]);
      expect(await h.balance(o.user('self'))).toBe(500n);
      expect(await h.balance(o.user('direct'))).toBe(100n);
      expect(await h.receivableOf(o)).toBe(1250n);
      expect(await h.read(o)).toMatchObject({ booked_base_fen: 1000n, booked_n_fen: 1250n });
      expect(await snapshotReserve()).toEqual({ reserve_bp: 2000 });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#3] 本人入账时冻结（first_credit 待补 617、净额 0），批准时仍冻结：该单 approved，直推 +7、平台 +26，credited_fen 7；本人不补给、不写他的凭证、余额 0；本人名下恰好仍只有原来那一条 open 义务（不另开 deferred），应收 650，booked 1300 / 1300',
  async () => {
    const h = await approveHarness(s);
    const { o, seq } = await h.raised(SELF_HELD, 1300n);
    expect(await h.netOf(o, 'self')).toBe(0n);
    expect(await h.balance(o.user('direct'))).toBe(123n);
    expect(await h.receivableOf(o)).toBe(617n);
    const before = await h.orderObligations(o);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      user_id: o.user('self'),
      role: 'self',
      kind: 'first_credit',
      status: 'open',
    });
    const batchId = await h.generate();
    expect(ordered(await h.rowsOf(o)).find((r) => r.role === 'direct')?.diff_fen).toBe(7n);
    h.clock.advanceMs(60_000);

    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(batchId), batchId, [result(o, 'approved', 7)]);
      await h.expectAdjust(o, seq, [
        ...userIncrease(o, 'direct', 7n, seq),
        ...platformIncrease(o, 26n, seq),
      ]);
      const selfLines = (await h.adjLinesOf(o)).filter((l) => l.owner_id === o.user('self'));
      expect(selfLines).toEqual([]);
      expect(await h.balance(o.user('self'))).toBe(0n);
      expect(await h.netOf(o, 'self')).toBe(0n);
      expect(await h.balance(o.user('direct'))).toBe(130n);
      // UNION_RECEIVABLE = 1300 − self's still-held 650.
      expect(await h.receivableOf(o)).toBe(650n);
      expect(await h.read(o)).toMatchObject({ booked_base_fen: 1300n, booked_n_fen: 1300n });
      const after = await h.orderObligations(o);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        beneficiary_credit_id: before[0]!.beneficiary_credit_id,
        user_id: o.user('self'),
        role: 'self',
        kind: 'first_credit',
        status: 'open',
      });
      expect((await h.rowsOf(o)).every((r) => r.status === 'approved')).toBe(true);
    });
  },
  TIMEOUT,
);
