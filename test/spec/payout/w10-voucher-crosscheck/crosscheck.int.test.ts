// BR-WDR-15 / BR-TEXT-14; D10-703. Each top-level case exercises a missing behavior.
// Boundary cases pair accepted evidence with a conflicting control, keeping first-red meaningful.
import { expect, it } from 'vitest';
import {
  LINE_FAIL,
  LINE_UNKNOWN,
  answer,
  billLine,
  bills,
  candidate,
  newKey,
  query,
  refusal,
  refused,
  reviewing,
  payee,
  serial,
  snapshot,
  state,
  success,
  suite,
  withLoggedUnknownAdmin,
} from './crosscheck-harness.ts';

const s = suite(true);

it('[AC-B2-09x#1] 别单成功流水拒绝且仅留一条可查询审计；换凭证同幂等键无证据照常成功', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const c = await candidate(a, h);
    const other = await candidate(a, h);
    await bills(f, [billLine(other.w, c.body.channel_order_id)]);
    const key = newKey();
    await refusal(f, a, h, c, 'resolve_order_id_other_order', logs, key);
    const corrected = { ...c, body: { ...c.body, channel_order_id: serial() } };
    await success(f, a, h, corrected, { key });
    const after = await snapshot(f, a);
    // Successful replay does not append a second voucher, job or audit.
    await answer(await h.resolve(c.w.id, corrected.body, { key }), 0);
    expect(await snapshot(f, a)).toEqual(after);
  });
}, 120_000);

it('[AC-B2-09x#2] 成功查询流水与人填不同拒绝；纠正为查询流水成功且幂等拒绝不占键', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const c = await candidate(a, h);
    const correct = serial();
    await query(a, c, correct);
    const key = newKey();
    await refusal(f, a, h, c, 'resolve_order_id_mismatch', logs, key);
    await success(f, a, h, { ...c, body: { ...c.body, channel_order_id: correct } }, { key });
    expect((await state(a)).audits.filter((r) => r.target === c.w.id)).toHaveLength(2);
  });
}, 120_000);

it('[AC-B2-09x#3] 本单成功账单流水不符，即使成功查询与人填一致也拒绝', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const c = await candidate(a, h);
    await query(a, c, c.body.channel_order_id);
    await bills(f, [billLine(c.w, serial())]);
    await refusal(f, a, h, c, 'resolve_order_id_mismatch', logs);
    expect((await state(a)).withdrawals.find((w) => w.id === c.w.id)?.status).toBe('PAYING');
  });
}, 120_000);

it('[AC-B2-09x#4] 金额多一分、少一分均拒绝；等于实发而不等于申请金额可成功', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const exact = await candidate(a, h);
    const more = await candidate(a, h);
    const less = await candidate(a, h);
    const gross = await candidate(a, h);
    await query(a, exact, exact.body.channel_order_id, { paidAt: exact.body.paid_at });
    await bills(f, [
      billLine(exact.w, exact.body.channel_order_id, { amountFen: 12_347n }),
      billLine(more.w, more.body.channel_order_id, { amountFen: 12_348n }),
      billLine(less.w, less.body.channel_order_id, { amountFen: 12_346n }),
      billLine(gross.w, gross.body.channel_order_id, { amountFen: 12_560n }),
    ]);
    expect(exact.w.net_fen).toBe(12_347n);
    expect(exact.w.amount_fen).toBe(12_560n);
    await success(f, a, h, exact);
    expect(
      (await state(a)).audits.filter((r) => r.target === exact.w.id).map((r) => r.action),
    ).toEqual(['withdrawal_resolve']);
    await refusal(f, a, h, more, 'resolve_amount_mismatch', logs);
    await refusal(f, a, h, less, 'resolve_amount_mismatch', logs);
    await refusal(f, a, h, gross, 'resolve_amount_mismatch', logs);
  });
}, 120_000);

it('[AC-B2-09x#5] 同时别单占用账单流水与本单成功查询不符，先报 other_order', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const c = await candidate(a, h);
    const other = await candidate(a, h);
    await query(a, c, serial());
    await bills(f, [billLine(other.w, c.body.channel_order_id)]);
    await refusal(f, a, h, c, 'resolve_order_id_other_order', logs);
    expect(
      (await state(a)).audits.filter((r) => r.action === 'withdrawal_resolve_refused'),
    ).toHaveLength(1);
  });
}, 120_000);

it('[AC-B2-09x#6] 本单账单流水与金额同时不符，先报 order_id_mismatch', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const c = await candidate(a, h);
    await bills(f, [billLine(c.w, serial(), { amountFen: 12_348n })]);
    await refusal(f, a, h, c, 'resolve_order_id_mismatch', logs);
    expect((await state(a)).audits.filter((r) => r.action === 'withdrawal_resolve')).toEqual([]);
  });
}, 120_000);

it('[AC-B2-09x#7] 已用流水先于三种新冲突拒绝；未占用的同类证据仍报 other_order', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const taken = await candidate(a, h);
    const free = await candidate(a, h);
    const other = await candidate(a, h);
    const occupied = await reviewing(a, h, await payee(a, h), {
      channel_order_id: taken.body.channel_order_id,
    });
    await query(a, taken, serial());
    await bills(f, [
      billLine(occupied, taken.body.channel_order_id),
      billLine(taken.w, serial(), { amountFen: 12_348n }),
      billLine(other.w, free.body.channel_order_id),
    ]);
    const before = await snapshot(f, a);
    await refused(
      await h.resolve(taken.w.id, taken.body),
      'resolve_order_id_taken',
      'channel_order_id',
    );
    expect(await snapshot(f, a)).toEqual(before);
    await refusal(f, a, h, free, 'resolve_order_id_other_order', logs);
  });
}, 120_000);

it('[AC-B2-09x#8] 别单同号非成功账单与空out_biz_no成功账单均放行；真实别单成功才拒绝', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const fail = await candidate(a, h);
    const unknown = await candidate(a, h);
    const offline = await candidate(a, h);
    const conflict = await candidate(a, h);
    const owners = await Promise.all([candidate(a, h), candidate(a, h), candidate(a, h)]);
    await bills(f, [
      billLine(owners[0]!.w, fail.body.channel_order_id, { status: LINE_FAIL }),
      billLine(owners[1]!.w, unknown.body.channel_order_id, { status: LINE_UNKNOWN }),
      billLine(offline.w, offline.body.channel_order_id, { outBizNo: null }),
      billLine(owners[2]!.w, conflict.body.channel_order_id),
    ]);
    await success(f, a, h, fail);
    await success(f, a, h, unknown);
    await success(f, a, h, offline);
    await refusal(f, a, h, conflict, 'resolve_order_id_other_order', logs);
    expect(
      (await state(a)).audits.filter((r) => r.action === 'withdrawal_resolve_refused'),
    ).toHaveLength(1);
  });
}, 120_000);

it('[AC-B2-09x#9] 别app同号成功账单不串租户；本app同样证据必须拒绝', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const foreign = await s.setup();
  const foreignAdmin = s.admin(foreign);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const clean = await candidate(a, h);
    const bad = await candidate(a, h);
    const owner = await candidate(a, h);
    await withLoggedUnknownAdmin(foreignAdmin, [], async (fh) => {
      const foreignOwner = await candidate(foreignAdmin, fh);
      await bills(foreign, [billLine(foreignOwner.w, clean.body.channel_order_id)]);
    });
    await bills(f, [billLine(owner.w, bad.body.channel_order_id)]);
    const foreignBefore = await snapshot(foreign, foreignAdmin);
    await success(f, a, h, clean);
    await refusal(f, a, h, bad, 'resolve_order_id_other_order', logs);
    expect(await snapshot(foreign, foreignAdmin)).toEqual(foreignBefore);
  });
}, 120_000);

it('[AC-B2-09x#10] 仅取最新成功查询：早期异号无影响，较新的unknown不遮住成功证据', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const clean = await candidate(a, h);
    const bad = await candidate(a, h);
    const early = new Date(a.clock.now().getTime() - 120_000);
    const later = new Date(a.clock.now().getTime() - 60_000);
    await query(a, clean, serial(), { at: early });
    await query(a, clean, clean.body.channel_order_id, { at: later });
    await query(a, clean, serial(), { result: 'unknown' });
    await query(a, bad, bad.body.channel_order_id, { at: early });
    await query(a, bad, serial(), { at: later });
    await query(a, bad, bad.body.channel_order_id, { result: 'unknown' });
    await success(f, a, h, clean);
    await refusal(f, a, h, bad, 'resolve_order_id_mismatch', logs);
    expect(
      (await state(a)).audits.filter((r) => r.action === 'withdrawal_resolve_refused'),
    ).toHaveLength(1);
  });
}, 120_000);

it('[AC-B2-09x#11] 成功查询时间相同时按id倒序，不能取较小id或任意成功查询', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    for (const accepts of [true, false]) {
      const c = await candidate(a, h);
      const first = serial();
      const second = serial();
      const x = await query(a, c, first);
      const y = await query(a, c, second);
      const high = x.id > y.id ? first : second;
      const low = x.id > y.id ? second : first;
      const chosen = { ...c, body: { ...c.body, channel_order_id: accepts ? high : low } };
      if (accepts) await success(f, a, h, chosen);
      else await refusal(f, a, h, chosen, 'resolve_order_id_mismatch', logs);
      expect(x.at).toEqual(y.at);
    }
  });
}, 120_000);

it('[AC-B2-09x#12] fail/unknown查询与非成功本单账单不作冲突证据；成功查询异号仍拒绝', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const clean = await candidate(a, h);
    const unknownBill = await candidate(a, h);
    const bad = await candidate(a, h);
    // A newer unknown lifts the existing resolve_query_failed guard; neither response is success.
    await query(a, clean, serial(), { result: 'fail', at: new Date(a.clock.now().getTime() - 1) });
    await query(a, clean, serial(), { result: 'unknown' });
    await query(a, bad, serial());
    await bills(f, [
      billLine(clean.w, serial(), { status: LINE_FAIL, amountFen: 12_348n }),
      billLine(unknownBill.w, serial(), { status: LINE_UNKNOWN, amountFen: 12_346n }),
    ]);
    await success(f, a, h, clean);
    await success(f, a, h, unknownBill);
    await refusal(f, a, h, bad, 'resolve_order_id_mismatch', logs);
    expect(
      (await state(a)).audits.filter((r) => r.action === 'withdrawal_resolve_refused'),
    ).toHaveLength(1);
  });
}, 120_000);

it('[AC-B2-09x#15] 没有查询账单照常成功；正确账单不能掩盖本单成功查询异号', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const noEvidence = await candidate(a, h);
    await success(f, a, h, noEvidence);
    expect(
      (await state(a)).audits.filter((r) => r.target === noEvidence.w.id).map((r) => r.action),
    ).toEqual(['withdrawal_resolve']);
    const bad = await candidate(a, h);
    await query(a, bad, serial());
    await bills(f, [billLine(bad.w, bad.body.channel_order_id)]);
    await refusal(f, a, h, bad, 'resolve_order_id_mismatch', logs);
  });
}, 120_000);

it('[AC-B2-09x#16] 既有查询失败和paid_at范围检查先于凭证冲突，条件修正后才检查凭证', async () => {
  const f = await s.setup();
  const a = s.admin(f);
  const logs: string[] = [];
  await withLoggedUnknownAdmin(a, logs, async (h) => {
    const c = await candidate(a, h);
    const other = await candidate(a, h);
    await query(a, c, serial(), { result: 'fail' });
    await bills(f, [billLine(other.w, c.body.channel_order_id)]);
    const before = await snapshot(f, a);
    const invalidTime = {
      ...c.body,
      paid_at: new Date(a.clock.now().getTime() + 300_001).toISOString(),
    };
    await refused(await h.resolve(c.w.id, invalidTime), 'resolve_query_failed');
    expect(await snapshot(f, a)).toEqual(before);
    await query(a, c, serial(), { result: 'unknown', at: new Date(a.clock.now().getTime() + 1) });
    const lifted = await snapshot(f, a);
    await refused(await h.resolve(c.w.id, invalidTime), 'resolve_paid_at_invalid', 'paid_at');
    expect(await snapshot(f, a)).toEqual(lifted);
    await refusal(f, a, h, c, 'resolve_order_id_other_order', logs);
  });
}, 120_000);
