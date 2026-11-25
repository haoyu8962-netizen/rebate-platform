// B2-09f supplement launch rule tests (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// createAdminSettleSupplementBatches (POST /admin/v1/settle-bills/{bill_id}/supplement-batches);
// 08 BR-FUND-04 ⑧ ⑨ ⑫; D10-280 ③ (bill totals not written back); D10-440 (any DRAFT of the bill
// refuses the launch, data.reason=pending_draft; a CONFIRMED batch does not, SCHEDULED included);
// D10-437 (one launch is one new round). Order after the guard: body [platform] → bill_id (20001
// [bill_id], no 404) → the launch guard, 20001 with data.reason, nothing written: credit_disabled
// [platform], bill_not_ready [bill_id], pending_draft [bill_id]. outcome generated (batch_ids may be
// empty, no empty batch) or duplicate (the same nominal moment, the server clock, already claimed).
// Idempotency-Key required: same key and body → the first result; other body → 20901; still running
// → 40901; 2xxxx refusals are not stored (platform idempotency), so the key can be used again. Audit
// settle_supplement_create. No money moves. The launch reads the real orders, order_settlements and
// commission snapshot of the app and platform: production has no source port yet, the rule test
// seeds those tables and leaves how they are read to the implementation. Requests go through the
// real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  BILL,
  GENERATING,
  SUPPLEMENT_ACTION,
  ago,
  allBatches,
  allDiffs,
  answer,
  audits,
  auditText,
  batchNow,
  batchesOf,
  billOf,
  creditSwitch,
  everything,
  expected,
  fixture,
  holdBill,
  idempotencyRows,
  itemsOf,
  later,
  launched,
  newKey,
  oneAudit,
  pastConfigCache,
  refused,
  seedBatch,
  seedBill,
  seedObligation,
  seedOrder,
  setSwitch,
  suite,
  track,
  waiting,
  withCommandsAdmin,
  type BatchSeed,
  type Fixture,
} from './kit.ts';

const s = suite();
const TAOBAO = { platform: 'taobao' };
/** Before any real clock this suite runs at: the batches' created_at (column default) is later. */
const PAST_INSTANT = '2025-03-30T02:00:00.000Z';

async function creditOn(f: Fixture, ...platforms: readonly string[]): Promise<void> {
  for (const platform of platforms) await setSwitch(f, creditSwitch(platform), true);
}

it('[AC-B2-09f#27] 发起补充：本平台可纳入的 WAITING 子订单生成 kind=supplement 的 DRAFT 批次，data 恰好是 bill_id、platform、outcome=generated、batch_ids；批次未确认、明细待执行，b_settle 按结算佣金换算；账单合计不回写（D10-280 ③）；不入账；审计 settle_supplement_create 含账单、平台、outcome、batch_ids', async () => {
  const f = fixture(s);
  await creditOn(f, 'taobao');
  const bill = await seedBill(f, '2026-09');
  const first = await seedOrder(f);
  const second = await seedOrder(f, { settlePeriod: '2026-08' });
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const data = await launched(await h.supplement(bill.bill_id, TAOBAO));
    expect(data).toEqual({
      bill_id: bill.bill_id,
      platform: 'taobao',
      outcome: 'generated',
      batch_ids: [expect.any(String)],
    });
    const batches = await allBatches(f);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      batch_id: data.batch_ids[0],
      bill_id: bill.bill_id,
      platform: 'taobao',
      kind: 'supplement',
      status: 'DRAFT',
      settle_mode: 'IMMEDIATE',
      scheduled_at: null,
      confirmed_by: null,
      confirmed_at: null,
      order_count: 2,
      row_version: 0,
    });
    const items = await itemsOf(f, data.batch_ids);
    expect(items.map((item) => item.order_id).sort()).toEqual(
      [first.orderId, second.orderId].sort(),
    );
    for (const item of items) {
      expect(item).toMatchObject({
        item_type: 'order',
        settle_seq: 1,
        b_settle_fen: 850n,
        amount_fen: null,
        result: null,
      });
    }
    const after = await everything(f);
    for (const part of ['bills', 'orders', 'vouchers', 'balances'] as const) {
      expect(after[part]).toEqual(before[part]);
    }

    const record = await oneAudit(f, SUPPLEMENT_ACTION, h.biller.id);
    for (const value of [bill.bill_id, 'taobao', 'generated', data.batch_ids[0]!]) {
      expect(auditText(record)).toContain(value);
    }
  });
});

it('[AC-B2-09f#28] 一次发起是新的一轮：生成的批次 in_current_round 为 true、row_version 随详情返回，账单派生回到 issued；用详情里的版本确认后到 CONFIRMED、账单为 settling（经 POST confirm 走完 SB1 → SB2）', async () => {
  const f = fixture(s, PAST_INSTANT);
  await creditOn(f, 'taobao');
  const bill = await seedBill(f, '2025-02');
  const main = await seedBatch(f, bill, { status: 'DONE' });
  await seedOrder(f, { settlePeriod: '2025-02' });
  await withCommandsAdmin(f, async (h) => {
    const data = await launched(await h.supplement(bill.bill_id, TAOBAO));
    expect(data.batch_ids).toHaveLength(1);
    const id = data.batch_ids[0]!;
    const sent = await h.detail(bill.bill_id);
    const detail = await billOf(sent);
    expect(detail['status']).toBe('issued');
    const shownBatches = await batchesOf(sent);
    const current = shownBatches.filter((batch) => batch['in_current_round'] === true);
    expect(current.map((batch) => batch['batch_id'])).toEqual([id]);
    expect(current[0]!['row_version']).toBe(0);

    const stored = await allBatches(f);
    const launchedRow = stored.find((batch) => batch.batch_id === id)!;
    const confirmed = await billOf(
      await h.confirm(bill.bill_id, { expected_batches: expected([launchedRow]) }),
    );
    expect(confirmed['status']).toBe('settling');
    expect((await batchNow(f, launchedRow)).status).toBe('CONFIRMED');
    expect(await batchNow(f, main)).toEqual(main);
  });
});

it('[AC-B2-09f#29] 校验范围：只看所发起平台和本应用的子订单；hold、维权中的单不入批；金额不符的单不入批、不登记差错单（B2-18）；已入账子订单上开着的补记义务生成受益人明细（order_count 不计）；差错数与暂缓数不回写账单（D10-280 ③）', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await creditOn(f, 'taobao', 'jd');
  await creditOn(other, 'taobao');
  const bill = await seedBill(f, '2026-09');
  await seedBill(other, '2026-09');
  const candidate = await seedOrder(f);
  await seedOrder(f, { platform: 'jd' });
  await seedOrder(f, { hold: true });
  await seedOrder(f, { rightsPending: true });
  // B2-18 (D10-2521 ②): the union settled 0 against a snapshot base of 850 — not regenerated, an
  // engineering alert, not in the batch (the production launch has the regeneration port).
  await seedOrder(f, { commissionFen: 0n });
  const credited = await seedOrder(f, { rebateStatus: 'CREDITED' });
  const creditId = await seedObligation(f, credited);
  await seedOrder(other);
  await withCommandsAdmin(f, async (h) => {
    const { bills } = await everything(f);
    const data = await launched(await h.supplement(bill.bill_id, TAOBAO));
    expect(data.outcome).toBe('generated');
    const batches = await allBatches(f);
    expect(batches.map((batch) => batch.order_count)).toEqual([1]);
    const items = await itemsOf(f, data.batch_ids);
    expect(
      items
        .map((item) => ({ type: item.item_type, order: item.order_id }))
        .sort((a, b) => a.type.localeCompare(b.type)),
    ).toEqual([
      { type: 'beneficiary', order: credited.orderId },
      { type: 'order', order: candidate.orderId },
    ]);
    expect(items.find((item) => item.item_type === 'beneficiary')).toMatchObject({
      beneficiary_credit_id: creditId,
      role: 'self',
      b_settle_fen: null,
    });
    // B2-18: the amount mismatch no longer opens an R1 difference.
    expect(await allDiffs(f)).toHaveLength(0);
    expect(await allBatches(other)).toEqual([]);
    // Two deferred orders in this run: error_count and held_count stay.
    expect((await everything(f)).bills).toEqual(bills);
  });
});

it('[AC-B2-09f#30] 无可纳入数据不是错误：outcome=generated、batch_ids 为空，不生成空批次，审计照写；同一服务端时刻用新 key 再发起 → outcome=duplicate、batch_ids 为空（settle_jobs 唯一键），也写审计；时钟走过后再发起又是 generated', async () => {
  const f = fixture(s);
  await creditOn(f, 'taobao');
  const bill = await seedBill(f, '2026-09');
  await withCommandsAdmin(f, async (h) => {
    const base = { bill_id: bill.bill_id, platform: 'taobao', batch_ids: [] };
    expect(await launched(await h.supplement(bill.bill_id, TAOBAO))).toEqual({
      ...base,
      outcome: 'generated',
    });
    expect(await allBatches(f)).toEqual([]);
    expect(await launched(await h.supplement(bill.bill_id, TAOBAO))).toEqual({
      ...base,
      outcome: 'duplicate',
    });
    expect(await allBatches(f)).toEqual([]);
    const records = await audits(f, SUPPLEMENT_ACTION);
    expect(records.map((record) => auditText(record).includes('duplicate'))).toEqual([false, true]);

    f.clock.set(new Date(f.clock.now().getTime() + 1_000));
    expect(await launched(await h.supplement(bill.bill_id, TAOBAO))).toEqual({
      ...base,
      outcome: 'generated',
    });
  });
});

it('[AC-B2-09f#31] 账单下还有 DRAFT 就拒绝发起（D10-440）：同平台、别的平台、别的轮次（撤销定时回来的）的 DRAFT → 20001 data.fields=[bill_id] data.reason=pending_draft，什么都不写、不写审计；驳回或确认后可发起，不在最近一轮的 DRAFT 同样能驳回（D10-444）', async () => {
  const f = fixture(s);
  await creditOn(f, 'taobao', 'jd');
  await seedOrder(f);
  const sameBill = await seedBill(f, '2026-09');
  const same = await seedBatch(f, sameBill, { row_version: 1 });
  const otherBill = await seedBill(f, '2026-08');
  await seedBatch(f, otherBill, { platform: 'jd' });
  const oldRoundBill = await seedBill(f, '2026-07');
  const oldDraft = await seedBatch(f, oldRoundBill, { platform: 'jd' });
  await seedBatch(f, oldRoundBill, { kind: 'supplement', status: 'DONE', created_at: ago(f, 60) });
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    for (const billId of [sameBill.bill_id, otherBill.bill_id, oldRoundBill.bill_id]) {
      await refused(await h.supplement(billId, TAOBAO), ['bill_id'], 'pending_draft');
    }
    expect(await everything(f)).toEqual(before);

    await answer(
      await h.reject(same.batch_id, { expected_row_version: 1, reason: '先驳回再发起' }),
      0,
    );
    expect((await launched(await h.supplement(sameBill.bill_id, TAOBAO))).outcome).toBe(
      'generated',
    );

    const rows = await batchesOf(
      await h.reject(oldDraft.batch_id, { expected_row_version: 0, reason: '驳回旧一轮' }),
    );
    expect(rows.find((row) => row['batch_id'] === oldDraft.batch_id)).toMatchObject({
      status: 'CANCELLED',
      in_current_round: false,
    });
    // A later nominal moment: settle_jobs' key has no bill, the same instant would be a replay.
    f.clock.set(later(f, 1));
    expect((await launched(await h.supplement(oldRoundBill.bill_id, TAOBAO))).outcome).toBe(
      'generated',
    );
  });
});

it('[AC-B2-09f#32] 这些不拦发起：CONFIRMED（立即与定时，D10-440）、EXECUTING、PARTIAL、DONE、CANCELLED 的批次；别的账单的 DRAFT；别的应用同一账单月的 DRAFT', async () => {
  const f = fixture(s);
  const other = fixture(s);
  await creditOn(f, 'taobao');
  const bill = await seedBill(f, '2026-09');
  const statuses: BatchSeed[] = [
    { status: 'CONFIRMED', settle_mode: 'IMMEDIATE' },
    { status: 'CONFIRMED', settle_mode: 'SCHEDULED' },
    { status: 'EXECUTING' },
    { status: 'PARTIAL' },
    { status: 'DONE' },
    { status: 'CANCELLED' },
  ];
  for (const seed of statuses) await seedBatch(f, bill, seed);
  await seedBatch(f, await seedBill(f, '2026-08'));
  await seedBatch(other, await seedBill(other, '2026-09'));
  await withCommandsAdmin(f, async (h) => {
    expect((await launched(await h.supplement(bill.bill_id, TAOBAO))).outcome).toBe('generated');
  });
});

it('[AC-B2-09f#33] 发起守卫：credit.enabled.<platform> 未配置或为 off → 20001 data.fields=[platform] data.reason=credit_disabled；账单生成中、账单日任务在该账单上没有这个平台的结果 → 20001 data.fields=[bill_id] data.reason=bill_not_ready；两者都先于 pending_draft（账单上有 DRAFT 也先报它们）；什么都不写、不写审计；开关打开后放行', async () => {
  const f = fixture(s);
  await creditOn(f, 'taobao');
  await seedBill(f, '2026-09', { platform_order_counts: { taobao: 3 } });
  await seedBill(f, '2026-08', GENERATING);
  const drafted = await seedBill(f, '2026-07', { platform_order_counts: { taobao: 3 } });
  await seedBatch(f, drafted);
  await seedBatch(f, await seedBill(f, '2026-06', GENERATING));
  await seedOrder(f, { platform: 'jd' });
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    const jd = { platform: 'jd' };
    await refused(await h.supplement('2026-09', jd), ['platform'], 'credit_disabled');
    await refused(await h.supplement('2026-07', jd), ['platform'], 'credit_disabled');
    await setSwitch(f, creditSwitch('jd'), false);
    pastConfigCache(f);
    await refused(await h.supplement('2026-09', jd), ['platform'], 'credit_disabled');
    await refused(await h.supplement('2026-07', jd), ['platform'], 'credit_disabled');
    await refused(await h.supplement('2026-08', TAOBAO), ['bill_id'], 'bill_not_ready');
    await refused(await h.supplement('2026-06', TAOBAO), ['bill_id'], 'bill_not_ready');
    await setSwitch(f, creditSwitch('jd'), true);
    pastConfigCache(f);
    await refused(await h.supplement('2026-09', jd), ['bill_id'], 'bill_not_ready');
    await refused(await h.supplement('2026-07', jd), ['bill_id'], 'bill_not_ready');
    await refused(await h.supplement('2026-07', TAOBAO), ['bill_id'], 'pending_draft');
    expect(await everything(f)).toEqual(before);

    expect((await launched(await h.supplement('2026-09', TAOBAO))).outcome).toBe('generated');
  });
});

it('[AC-B2-09f#34] 请求体与账单 id：缺 platform、不在枚举 → 20001 [platform]；未知字段 → 该字段；不是 YYYY-MM、本应用没有该账单 → 20001 [bill_id]（不回 404、不带 reason，开关为 off 时也先报账单）；不带或格式不对的 Idempotency-Key → 20001；什么都不写', async () => {
  const f = fixture(s);
  const bill = await seedBill(f, '2026-09');
  await withCommandsAdmin(f, async (h) => {
    const before = await everything(f);
    await refused(await h.supplement(bill.bill_id, {}), ['platform']);
    await refused(await h.supplement(bill.bill_id, { platform: 'nosuch' }), ['platform']);
    await refused(await h.supplement(bill.bill_id, { ...TAOBAO, note: '备注' }), ['note']);
    await refused(await h.supplement('2020-01', TAOBAO), ['bill_id']);
    await refused(await h.supplement('2026-13', TAOBAO), ['bill_id']);
    await answer(await h.supplement(bill.bill_id, TAOBAO, { key: null }), 20001);
    await answer(await h.supplement(bill.bill_id, TAOBAO, { key: 'short' }), 20001);
    await answer(await h.supplement(bill.bill_id, TAOBAO, { key: 'bad key with spaces' }), 20001);
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09f#35] 同一 Idempotency-Key 同一请求体重放：原样返回第一次的应答（同一 batch_ids），不再发起、不再写审计；同 key 换请求体 → 20901；新 key 因已有 DRAFT 被拒；别的账号用同一 key 是它自己的作用域（同样被拒，不返回第一次的应答）', async () => {
  const f = fixture(s);
  await creditOn(f, 'taobao', 'jd');
  const bill = await seedBill(f, '2026-09');
  await seedOrder(f);
  await withCommandsAdmin(f, async (h) => {
    const key = newKey();
    const sent = await h.supplement(bill.bill_id, TAOBAO, { key });
    const data = await launched(sent);
    expect(data.batch_ids).toHaveLength(1);
    const after = await everything(f);

    for (let i = 0; i < 2; i += 1) {
      const again = await h.supplement(bill.bill_id, TAOBAO, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }
    await answer(await h.supplement(bill.bill_id, { platform: 'jd' }, { key }), 20901);
    await refused(await h.supplement(bill.bill_id, TAOBAO), ['bill_id'], 'pending_draft');
    const colleague = await h.caller([BILL]);
    await refused(
      await h.supplement(bill.bill_id, TAOBAO, { key, caller: colleague }),
      ['bill_id'],
      'pending_draft',
    );
    expect(await everything(f)).toEqual(after);
  });
});

it('[AC-B2-09f#36] 被拒不占 key：pending_draft 被拒后驳回现有 DRAFT，用同一 Idempotency-Key 重发即成功；第一次还在执行时再发（同体或换体）→ 40901，放行后第一次照常完成，之后重放得到它的应答', async () => {
  const f = fixture(s);
  await creditOn(f, 'taobao');
  const refusedBill = await seedBill(f, '2026-09');
  const draft = await seedBatch(f, refusedBill);
  const running = await seedBill(f, '2026-08');
  await withCommandsAdmin(f, async (h) => {
    const key = newKey();
    const launch = () => h.supplement(refusedBill.bill_id, TAOBAO, { key });
    await refused(await launch(), ['bill_id'], 'pending_draft');
    await answer(await h.reject(draft.batch_id, { expected_row_version: 0, reason: '先驳回' }), 0);
    expect((await launched(await launch())).outcome).toBe('generated');

    // A later nominal moment: settle_jobs' key has no bill, the same instant would be a replay.
    f.clock.set(later(f, 1));
    const heldKey = newKey();
    const held = await holdBill(f, running.bill_id);
    const first = track(h.supplement(running.bill_id, TAOBAO, { key: heldKey }));
    try {
      expect(await waiting(f, 1, [first]), '第一次发起应在账单行锁上等待').toBe(true);
      const again = (body: unknown) => h.supplement(running.bill_id, body, { key: heldKey });
      await answer(await again(TAOBAO), 40901);
      await answer(await again({ platform: 'jd' }), 40901);
    } finally {
      await held.release();
    }
    const sent = await first.promise;
    expect((await launched(sent)).outcome).toBe('generated');
    const replay = await h.supplement(running.bill_id, TAOBAO, { key: heldKey });
    expect(replay.body).toBe(sent.body);
    const rows = (await idempotencyRows(f)).filter((row) => row.key === heldKey);
    expect(rows.map((row) => row.status)).toEqual(['completed']);
  });
});

it('[AC-B2-09f#37] 两个平台同时发起同一账单：pending_draft 在账单行锁内判定，恰好一个生成批次，另一个 20001 data.reason=pending_draft，不会各生成一轮', async () => {
  const f = fixture(s);
  await creditOn(f, 'taobao', 'jd');
  const bill = await seedBill(f, '2026-09');
  await seedOrder(f);
  await seedOrder(f, { platform: 'jd' });
  await withCommandsAdmin(f, async (h) => {
    const held = await holdBill(f, bill.bill_id);
    const taobao = track(h.supplement(bill.bill_id, TAOBAO));
    const jd = track(h.supplement(bill.bill_id, { platform: 'jd' }));
    try {
      expect(await waiting(f, 2, [taobao, jd]), '两次发起都应在账单行锁上等待').toBe(true);
    } finally {
      await held.release();
    }
    const replies = await Promise.all([taobao.promise, jd.promise]);
    expect(replies.map((sent) => sent.json().code).sort((a, b) => a - b)).toEqual([0, 20001]);
    await refused(
      replies.find((sent) => sent.json().code === 20001)!,
      ['bill_id'],
      'pending_draft',
    );
    expect(await allBatches(f)).toHaveLength(1);
    expect(await audits(f, SUPPLEMENT_ACTION)).toHaveLength(1);
  });
});
