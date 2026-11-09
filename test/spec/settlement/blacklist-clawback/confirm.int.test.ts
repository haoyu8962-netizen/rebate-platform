// B2-04zzl confirmation rule tests, the effects (claude-independent, SPEC_REF d5713bf4):
// contracts/openapi.yaml blacklistClawbackAdminReconDiff, 08 BR-FUND-01 R8 (BLACKLIST_CONFIRMED),
// BR-FUND-08 — the order CREDITED → CLAWED_BACK with reason BLACKLIST, CLAWBACK vouchers sub_type FULL
// under event id `B{recon_diff_id}`, amounts by the server as R8 does for a whole-order clawback, only
// available debited (frozen never), a beneficiary in deletion processing → BAD_DEBT, a share forfeited
// at the credit writes nothing; the difference adjusted with resolution.clawback; the audit record;
// order.clawed_back published; no withdrawal frozen or released. Requests go through the real admin
// entry, orders through the real credit (kit.ts). Expected amounts are written by hand. Top-level it()
// only (规划/11 §4.3).
import { addFen } from '@couli/money';
import { expect, it } from 'vitest';
import {
  ACTION,
  CHANNEL,
  DETAIL_KEYS,
  SUFFIX,
  app,
  audits,
  badDebtLines,
  clawbackKey,
  confirmed,
  detailView,
  eventIdOf,
  everything,
  expectAdjusted,
  holdNow,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  seedBlacklistDiff,
  seedHold,
  sourceOf,
  suite,
  userClawbackLines,
  withAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-04zzl#12] 成功路径：CREDITED → CLAWED_BACK（R8，事件 BLACKLIST_CONFIRMED，原因码 BLACKLIST）；三位受益人各一张 CLAWBACK（425 / 85 / 42，uniq_key `…:CLAWBACK:B{id}`，sub_type FULL），平台差额 448 借 COMMISSION_REVENUE / 贷 UNION_RECEIVABLE；分录平衡，联盟应收冲平；booked 清零；应答为处理后的详情、clawed_back_fen 552（整数）、rebate_status_after CLAWED_BACK；差错单 adjusted，resolution 保留原键并加 clawback 与修剪后的 note', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited();
  const diff = await seedBlacklistDiff(a, o, { dimensions: [CHANNEL, SUFFIX] });
  await withAdmin(a, async (admin) => {
    const note = '  复核确认命中黑名单，按 R8 扣回\t\n';
    const sent = await admin.confirm(diff.id, { note });
    const data = await confirmed(sent);
    expect(data.clawed_back_fen).toBe(552);
    expect(data.rebate_status_after).toBe('CLAWED_BACK');

    const after = await expectAdjusted(a, diff, {
      adminId: admin.operator.id,
      clawedBackFen: 552,
      note: note.trim(),
    });
    expect(Object.keys(data.recon_diff).sort(), sent.body).toEqual(DETAIL_KEYS);
    expect(data.recon_diff, sent.body).toEqual(detailView(after));

    const event = eventIdOf(diff);
    const platform = platformClawbackKey(o, event);
    const users = [
      { key: clawbackKey(o, 'self', event), role: 'self' as const, fen: 425n },
      { key: clawbackKey(o, 'direct', event), role: 'direct' as const, fen: 85n },
      { key: clawbackKey(o, 'indirect', event), role: 'indirect' as const, fen: 42n },
    ];
    expect(await h.clawbackKeys(o)).toEqual([...users.map((u) => u.key), platform].sort());
    for (const user of users) {
      expect(await h.voucherLines(user.key), user.role).toEqual(
        userClawbackLines(o, user.role, user.fen),
      );
      expect(await h.voucherTypes(user.key), user.role).toEqual(['CLAWBACK|FULL']);
      expect(await h.voucher(user.key), user.role).toMatchObject({
        voucher_kind: 'CLAWBACK',
        order_key: o.orderKey,
        beneficiary_user_id: o.user(user.role),
        role: user.role,
      });
      expect(await h.balance(o.user(user.role)), user.role).toBe(0n);
    }
    expect(await h.voucherLines(platform)).toEqual(platformDecreaseLines(o, 448n));
    expect(await h.voucherTypes(platform)).toEqual(['CLAWBACK|FULL']);

    const lines = (await h.lines()).filter((line) => line.uniq_key.includes(`:CLAWBACK:${event}`));
    const keys = new Set(lines.map((line) => line.uniq_key));
    for (const key of keys) {
      const total = lines
        .filter((line) => line.uniq_key === key)
        .reduce((sum, line) => addFen(sum, line.amount_fen), 0n);
      expect(total, key).toBe(0n);
    }
    expect(await h.orderSubjectNet(o, receivable(o))).toBe(0n);
    expect(await h.orderSubjectNet(o, 'COMMISSION_REVENUE')).toBe(0n);

    expect(await h.rebateColumns(o)).toMatchObject({
      rebate_status: 'CLAWED_BACK',
      booked_base_fen: 0n,
      booked_n_fen: 0n,
      reason: 'BLACKLIST',
    });
    const history = await h.rebateHistoryAfterCredit(o);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      field: 'rebate',
      from_status: 'CREDITED',
      event: 'BLACKLIST_CONFIRMED',
      to_status: 'CLAWED_BACK',
    });
  });
});

it('[AC-B2-04zzl#13] 请求体 {}：可以处理，resolution 不加 note；金额由服务端现算：expected_fen 被改大（999999）实扣仍 552，差错单三个金额按登记不变', async () => {
  const a = await app(s);
  const o = await a.h.credited();
  const diff = await seedBlacklistDiff(a, o, {
    patch: { expected_fen: 999_999n, diff_fen: 999_999n },
  });
  await withAdmin(a, async (admin) => {
    const data = await confirmed(await admin.confirm(diff.id));
    expect(data.clawed_back_fen).toBe(552);
    const after = await expectAdjusted(a, diff, {
      adminId: admin.operator.id,
      clawedBackFen: 552,
    });
    expect(after.expected_fen).toBe(999_999n);
    expect(after.actual_fen).toBe(0n);
    expect(after.diff_fen).toBe(999_999n);
    expect(after.resolution as Record<string, unknown>).not.toHaveProperty('note');
    expect(data.recon_diff['expected_fen']).toBe(999_999);
  });
});

it('[AC-B2-04zzl#14] 扣回只从 available：受益人已把 400 冻结提现时 available 变负（25 − 425 = −400），frozen 不动；不新增提现冻结，也不解除差错单上已有的提现冻结记录', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited();
  const self = o.user('self');
  await h.freeze(self, 400n);
  expect(await h.balance(self)).toBe(25n);
  const diff = await seedBlacklistDiff(a, o);
  const hold = await seedHold(a.f, { user_id: self, source_ref: sourceOf(diff.id) });
  await withAdmin(a, async (admin) => {
    expect((await confirmed(await admin.confirm(diff.id))).clawed_back_fen).toBe(552);
    expect(await h.balance(self)).toBe(-400n);
    expect(await h.frozenOf(self)).toBe(400n);
    expect(await holdNow(a.f, hold)).toEqual(hold);
    expect((await everything(a)).holds).toEqual([hold]);
  });
});

it('[AC-B2-04zzl#15] 受益人已进入注销 processing：其份额不写账户，改借 BAD_DEBT / 贷 UNION_RECEIVABLE，同一 uniq_key；clawed_back_fen 计入这笔（552），其余额不动；事件的 beneficiaries 不列它', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited();
  const direct = o.user('direct');
  await h.markDeleting(direct);
  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    expect((await confirmed(await admin.confirm(diff.id))).clawed_back_fen).toBe(552);
    const key = clawbackKey(o, 'direct', eventIdOf(diff));
    expect(await h.voucherLines(key)).toEqual(badDebtLines(o, 85n));
    expect(await h.voucherTypes(key)).toEqual(['CLAWBACK|FULL']);
    expect(await h.balance(direct)).toBe(85n);
    const [event] = (await h.published()).filter((e) => e.name === 'order.clawed_back');
    expect(event).toBeDefined();
    const payload = (
      event!.payload as unknown as { data: { beneficiaries: { user_id: string }[] } }
    ).data;
    expect(payload.beneficiaries.map((b) => b.user_id)).not.toContain(direct);
  });
});

it('[AC-B2-04zzl#16] 入账时已没收的份额（封禁）不写分录，只随平台净额冲回：indirect 被封禁 → 无其 CLAWBACK，clawed_back_fen 510，平台差额 490；全部受益人都被没收 → clawed_back_fen 0，只有平台凭证 1000，差错单仍 adjusted', async () => {
  const a = await app(s);
  const { h } = a;
  const partial = await h.credited({
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000 },
      { role: 'indirect', ratioBp: 500, state: 'banned' },
    ],
  });
  const none = await h.credited({
    people: [
      { role: 'self', ratioBp: 5000, state: 'banned' },
      { role: 'direct', ratioBp: 1000, state: 'banned' },
    ],
  });
  const partialDiff = await seedBlacklistDiff(a, partial);
  const noneDiff = await seedBlacklistDiff(a, none);
  await withAdmin(a, async (admin) => {
    expect((await confirmed(await admin.confirm(partialDiff.id))).clawed_back_fen).toBe(510);
    const partialEvent = eventIdOf(partialDiff);
    expect(await h.clawbackKeys(partial)).toEqual(
      [
        clawbackKey(partial, 'self', partialEvent),
        clawbackKey(partial, 'direct', partialEvent),
        platformClawbackKey(partial, partialEvent),
      ].sort(),
    );
    expect(await h.voucherLines(platformClawbackKey(partial, partialEvent))).toEqual(
      platformDecreaseLines(partial, 490n),
    );

    expect((await confirmed(await admin.confirm(noneDiff.id))).clawed_back_fen).toBe(0);
    const noneEvent = eventIdOf(noneDiff);
    expect(await h.clawbackKeys(none)).toEqual([platformClawbackKey(none, noneEvent)]);
    expect(await h.voucherLines(platformClawbackKey(none, noneEvent))).toEqual(
      platformDecreaseLines(none, 1000n),
    );
    await expectAdjusted(a, noneDiff, { adminId: admin.operator.id, clawedBackFen: 0 });
    expect((await h.read(none)).rebate_status).toBe('CLAWED_BACK');
  });
});

it('[AC-B2-04zzl#17] R8 的连带处理与整单扣回一致：该子订单未批准的正差候选作废（voided_by_clawback）', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited();
  await h.candidate(o, { role: 'self' });
  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    await confirmed(await admin.confirm(diff.id));
    expect((await h.candidates(o)).map((row) => row.status)).toEqual(['voided_by_clawback']);
  });
});

it('[AC-B2-04zzl#18] 审计：一条 recon_diff_blacklist_clawback，操作人是调用者，带 order_key、clawed_back_fen 552、订单状态前后（CREDITED → CLAWED_BACK）、差错单状态前后（open → adjusted），不含受益人个人标识', async () => {
  const a = await app(s);
  const o = await a.h.credited();
  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    await confirmed(await admin.confirm(diff.id));
    const records = await audits(a.f, ACTION);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.admin_id).toBe(admin.operator.id);
    const before = JSON.stringify(record.before);
    const after = JSON.stringify(record.after);
    expect(before).toContain('"CREDITED"');
    expect(before).toContain('"open"');
    expect(after).toContain('"CLAWED_BACK"');
    expect(after).toContain('"adjusted"');
    expect(`${before}${after}`).toContain(o.orderKey);
    expect(after).toMatch(/"clawed_back_fen":"?552"?[,}]/);
    for (const person of o.people) {
      expect(`${before}${after}`, person.role).not.toContain(person.userId);
    }
  });
});

it('[AC-B2-04zzl#19] 扣回后 order.clawed_back 同事务发出（apply 现有行为）：rights_event_id `B{id}`、transition R8、reason BLACKLIST，beneficiaries 为扣回余额的受益人及整数分字符串；只发一次', async () => {
  const a = await app(s);
  const { h } = a;
  const o = await h.credited();
  const diff = await seedBlacklistDiff(a, o);
  await withAdmin(a, async (admin) => {
    await confirmed(await admin.confirm(diff.id));
    const events = (await h.published()).filter((e) => e.name === 'order.clawed_back');
    expect(events).toHaveLength(1);
    const payload = (
      events[0]!.payload as unknown as {
        data: { beneficiaries: { user_id: string; role: string; clawback_fen: string }[] };
      }
    ).data;
    expect(payload).toMatchObject({
      order_id: o.orderId,
      order_key: o.orderKey,
      rights_event_id: eventIdOf(diff),
      transition: 'R8',
      reason: 'BLACKLIST',
    });
    expect([...payload.beneficiaries].sort((x, y) => (x.role < y.role ? -1 : 1))).toEqual([
      { user_id: o.user('direct'), role: 'direct', clawback_fen: '85' },
      { user_id: o.user('indirect'), role: 'indirect', clawback_fen: '42' },
      { user_id: o.user('self'), role: 'self', clawback_fen: '425' },
    ]);
  });
});
