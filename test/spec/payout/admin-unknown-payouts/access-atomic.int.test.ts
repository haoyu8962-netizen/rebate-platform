import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  answer,
  fixture,
  paidBody,
  payee,
  queuedQueries,
  state,
  suite,
  unknownWithdrawal,
  voucherOf,
  withUnknownAdmin,
} from './unknown-harness.ts';

const s = suite();

it('[AC-B2-09s#17] 合法体按权限10403→totp 10003→20001检查；withdraw.review、fund.view、payout.manual_entry不可操作或读列表；super与payout.execute可操作', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    const body = paidBody(f, w);
    for (const permission of ['withdraw.review', 'fund.view', 'payout.manual_entry']) {
      const caller = await h.caller([permission]);
      const before = await state(f);
      await answer(await h.resolve(randomUUID(), body, { caller, stepUp: null }), 10403, {
        reason: 'admin_permission_denied',
      });
      await answer(await h.query(randomUUID(), { caller, stepUp: null }), 10403, {
        reason: 'admin_permission_denied',
      });
      await answer(await h.list('', { caller }), 10403, { reason: 'admin_permission_denied' });
      expect(await state(f)).toEqual(before);
    }
    for (const stepUp of [null, await h.stepUp(h.executor, 'sms')]) {
      await answer(await h.resolve(randomUUID(), body, { stepUp }), 10003, { tier: 'totp' });
      await answer(await h.query(randomUUID(), { stepUp }), 10003, { tier: 'totp' });
    }
    await answer(await h.resolve(randomUUID(), body), 20001, { fields: ['withdrawal_id'] });
    await answer(await h.query(randomUUID()), 20001, { fields: ['withdrawal_id'] });
    const before = await state(f);
    await answer(await h.list(), 0);
    expect(await state(f)).toEqual(before);
    const superAdmin = await h.caller([], { superAdmin: true });
    await answer(await h.query(w.id, { caller: superAdmin }), 0);
    await answer(await h.resolve(w.id, body, { caller: superAdmin }), 0);
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
  });
});

it('[AC-B2-09s#18] 不合法schema先于权限和step-up：额外字段、非法resolution、超长凭证、空白/NUL流水号均20001，查询不允许字段；空白凭证和paid缺字段准确列出', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    const caller = await h.caller(['fund.view']);
    const body = paidBody(f, w);
    const before = await state(f);
    for (const patch of [
      { extra: true },
      { resolution: 'other' },
      { proof_text: 'x'.repeat(4001) },
      { channel_order_id: 'contains space' },
      { channel_order_id: '\u0000' },
      { channel_order_id: 'a\nb' },
    ]) {
      await answer(await h.resolve(w.id, { ...body, ...patch }, { caller, stepUp: null }), 20001);
    }
    await answer(await h.query(w.id, { caller, stepUp: null }, { extra: true }), 20001);
    await answer(await h.resolve(w.id, { ...body, proof_text: ' \t\n ' }), 20001, {
      fields: ['proof_text'],
    });
    await answer(
      await h.resolve(w.id, { resolution: 'paid', proof_text: body.proof_text }),
      20001,
      { fields: ['channel_order_id', 'paid_at'] },
    );
    await answer(
      await h.resolve(w.id, {
        resolution: 'paid',
        proof_text: body.proof_text,
        paid_at: body.paid_at,
      }),
      20001,
      { fields: ['channel_order_id'] },
    );
    await answer(
      await h.resolve(w.id, {
        resolution: 'paid',
        proof_text: body.proof_text,
        channel_order_id: body.channel_order_id,
      }),
      20001,
      { fields: ['paid_at'] },
    );
    expect(await state(f)).toEqual(before);
  });
});

it('[AC-B2-09s#19] 两个写操作都必须幂等键；10003后同键带totp可执行，成功后同键异体20901，同键同体原样返回且不多任何写入', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    const body = paidBody(f, w);
    const before = await state(f);
    for (const key of [null, 'short', 'spaces are invalid']) {
      await answer(await h.resolve(w.id, body, { key }), 20001);
      await answer(await h.query(w.id, { key }), 20001);
    }
    expect(await state(f)).toEqual(before);
    const queryKey = randomUUID();
    await answer(await h.query(w.id, { key: queryKey, stepUp: null }), 10003, { tier: 'totp' });
    await answer(await h.query(w.id, { key: queryKey }), 0);
    expect(await queuedQueries(f)).toHaveLength(1);
    const key = randomUUID();
    await answer(await h.resolve(w.id, body, { key, stepUp: null }), 10003, { tier: 'totp' });
    const sent = await h.resolve(w.id, body, { key });
    await answer(sent, 0);
    const after = await state(f);
    expect((await h.resolve(w.id, body, { key })).body).toBe(sent.body);
    expect(await state(f)).toEqual(after);
    for (const patch of [
      { proof_text: 'changed' },
      { channel_order_id: randomUUID() },
      { resolution: 'failed' },
    ]) {
      await answer(await h.resolve(w.id, { ...body, ...patch }, { key }), 20901);
      expect(await state(f)).toEqual(after);
    }
    await answer(await h.resolve(w.id, body), 20902, { resource: 'withdrawal' });
    expect(await state(f)).toEqual(after);
  });
});

it('[AC-B2-09s#20] 处置在审计、过账、税台账任一点失败都完全回滚，幂等记录不留，同键重试成功且只有一张凭证', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const point of ['audit', 'voucher', 'tax_ytd'] as const) {
      const w = await unknownWithdrawal(f, h, await payee(f, h));
      const before = await state(f);
      const body = paidBody(f, w);
      const key = randomUUID();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.resolve(w.id, body, { key });
      expect(h.fault.tripped, `必须实际走到${point}`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await state(f)).toEqual(before);
      await answer(await h.resolve(w.id, body, { key }), 0);
      expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
    }
  });
});

it('[AC-B2-09s#21] 查询写审计失败必须回滚入队和幂等；同键重试恰入队一次', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    const before = await state(f);
    const key = randomUUID();
    h.fault.point = 'audit';
    const sent = await h.query(w.id, { key });
    expect(h.fault.tripped).toBe(1);
    await answer(sent, 50001);
    expect(await state(f)).toEqual(before);
    await answer(await h.query(w.id, { key }), 0);
    expect(await queuedQueries(f)).toHaveLength(1);
  });
});
