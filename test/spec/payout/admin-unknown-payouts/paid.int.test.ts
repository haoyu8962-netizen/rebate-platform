// BR-WDR-09/15; tax and notification expectations are explicit requirements of B2-09s §9.
import { expect, it } from 'vitest';
import {
  ACCOUNT,
  AFTER_FREEZE,
  DAY,
  answer,
  attemptsOf,
  auditFacts,
  audits,
  balanceOf,
  changes,
  deliverMessage,
  entries,
  expectNoSecrets,
  fixture,
  fixtureAt,
  frozenMismatches,
  landThroughChannel,
  messageJobs,
  paidBody,
  payee,
  platformLine,
  reviewing,
  rowOf,
  secretsOf,
  seedTaxRow,
  state,
  suite,
  taxOf,
  textOf,
  unknownWithdrawal,
  userLine,
  voucherOf,
  withUnknownAdmin,
} from './unknown-harness.ts';

const s = suite();

it('[AC-B2-09s#4] 真实T+24h进入人工处置后判成功：支付宝、银行卡均PAID_API；请求时间和流水号、人工凭证与处置人落库，六条分录逐条对并与W5相同，available不动，frozen归零', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const method of ['alipay', 'bank_card'] as const) {
      const who = await payee(f, h);
      const w = await unknownWithdrawal(f, h, who, { seed: { method } });
      const body = paidBody(f, w);
      const response = await answer(await h.resolve(w.id, body), 0);
      expect(response.data).toMatchObject({
        withdrawal_id: w.id,
        status: 'PAID_API',
        manual_resolution: 'paid',
        channel_order_id: body.channel_order_id,
      });
      expect(Date.parse((response.data as { paid_at: string }).paid_at)).toBe(
        Date.parse(body.paid_at),
      );
      expect(await rowOf(f, w)).toMatchObject({
        status: 'PAID_API',
        paid_at: new Date(body.paid_at),
        channel_order_id: body.channel_order_id,
        manual_resolution: 'paid',
        resolver_ids: [h.executor.id],
        proof_file: body.proof_text,
        manual_entry_by: null,
        manual_confirm_by: null,
        out_biz_no: w.out_biz_no,
      });
      const key = `wd:${w.id}:PAID`;
      expect(await voucherOf(f.db, f.appId, key)).toEqual([
        { uniq_key: key, biz_type: 'withdrawal', biz_id: w.id, operator: `admin:${h.executor.id}` },
      ]);
      const actual = await entries(f.db, f.appId, key);
      expect(actual).toEqual([
        userLine(88n, 'TAX_WITHHOLD'),
        platformLine('TAX_PAYABLE', -88n, 'TAX_WITHHOLD'),
        userLine(125n, 'WITHDRAW_FEE'),
        platformLine('FEE_INCOME', -125n, 'WITHDRAW_FEE'),
        userLine(12_347n, 'WITHDRAW_PAID'),
        platformLine(method === 'alipay' ? 'CASH_ALIPAY' : 'CASH_BANK', -12_347n, 'WITHDRAW_PAID'),
      ]);
      const viaW5 = await reviewing(f, h, await payee(f, h), {
        status: 'PAYING',
        method,
        execute_seq: 1,
      });
      await landThroughChannel(f, viaW5);
      expect(actual).toEqual(await entries(f.db, f.appId, `wd:${viaW5.id}:PAID`));
      expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
        available_fen: AFTER_FREEZE,
        frozen_fen: 0n,
      });
      expect(await taxOf(f, who)).toEqual([
        {
          year: 2026,
          income_type: 'SERVICE_FEE',
          identity_hmac: who.hmac,
          cum_income_fen: 12_560n,
          cum_withheld_fen: 88n,
        },
      ]);
      expect((await attemptsOf(f, w)).filter((a) => a.kind === 'transfer')).toHaveLength(1);
    }
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09s#5] 跨年税台账按created_at的+08年：午夜前1毫秒属2026，午夜属2027；累加amount和tax，不能按paid_at或UTC年', async () => {
  const f = fixtureAt(s, '2027-01-02T02:00:00.000Z');
  await withUnknownAdmin(f, async (h) => {
    for (const [created, year] of [
      ['2026-12-31T15:59:59.999Z', 2026],
      ['2026-12-31T16:00:00.000Z', 2027],
    ] as const) {
      const who = await payee(f, h);
      await seedTaxRow(f, who, year, 50_003n, 1_009n);
      const w = await unknownWithdrawal(f, h, who, {
        age: DAY,
        seed: { created_at: new Date(created), updated_at: new Date(created) },
      });
      await answer(await h.resolve(w.id, paidBody(f, w)), 0);
      expect(await taxOf(f, who)).toEqual([
        {
          year,
          income_type: 'SERVICE_FEE',
          identity_hmac: who.hmac,
          cum_income_fen: 62_563n,
          cum_withheld_fen: 1_097n,
        },
      ]);
    }
  });
});

it('[AC-B2-09s#6] 恰一个PAID_API事件与WD_SUCCESS通知，凭证不外泄；恰一个withdrawal_resolve审计，按target_id可查，权限payout.execute', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await unknownWithdrawal(f, h, who);
    const body = paidBody(f, w);
    await answer(await h.resolve(w.id, body), 0);
    const event = { withdrawal_id: w.id, user_id: who.userId, status: 'PAID_API' };
    expect(await changes(f.db, f.appId)).toEqual([event]);
    expect(await messageJobs(f)).toEqual([event]);
    await deliverMessage(f, event);
    const inbox = await f.db
      .selectFrom('inbox_messages')
      .selectAll()
      .where('app_id', '=', f.appId)
      .execute();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      user_id: who.userId,
      code: 'WD_SUCCESS',
      title: '提现到账',
      body: '提现已到账：¥123.47 已转入支付宝',
    });
    const records = await audits(f, 'withdrawal_resolve');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ admin_id: h.executor.id, at: f.clock.now() });
    const facts = auditFacts(records[0]!);
    expect(facts.fields.get('resolution')).toBe('paid');
    expect(facts.fields.has('proof_text')).toBe(false);
    for (const value of [w.id, 'PAYING', 'PAID_API', 'paid', body.channel_order_id])
      expect(facts.text).toContain(value);
    expect(Date.parse(String(facts.fields.get('paid_at')))).toBe(Date.parse(body.paid_at));
    expectNoSecrets(facts.text, secretsOf(w, ACCOUNT.alipay, who));
    const reader = await h.caller(['audit.view_all']);
    const listed = await answer(await h.audit(w.id, { caller: reader }), 0);
    expect(listed.data).toMatchObject({
      items: [
        expect.objectContaining({ action: 'withdrawal_resolve', permission: 'payout.execute' }),
      ],
      total: 1,
    });
    const current = await state(f);
    expect(textOf([inbox, current.events, current.jobs, records, listed.data])).not.toContain(
      body.proof_text,
    );
  });
});
