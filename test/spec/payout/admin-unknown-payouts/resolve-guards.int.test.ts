import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  DAY,
  answer,
  bill,
  fixture,
  lowAndHigh,
  member,
  otherApp,
  paidBody,
  payee,
  refused,
  reviewing,
  rowOf,
  seedQueries,
  seedQueryWithId,
  setSwitch,
  state,
  suite,
  unknownWithdrawal,
  withUnknownAdmin,
} from './unknown-harness.ts';

const s = suite();

it('[AC-B2-09s#7] 最近query按at再按id倒序：fail且无成功账单拒绝；unknown或无查询允许，先fail后unknown允许，先unknown后fail拒绝', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const results of [
      [],
      ['unknown'],
      ['fail'],
      ['fail', 'unknown'],
      ['unknown', 'fail'],
    ] as const) {
      const w = await unknownWithdrawal(f, h, await payee(f, h));
      const { low, high } = lowAndHigh();
      for (const [index, result] of results.entries()) {
        await seedQueryWithId(f, w, index === 0 ? low : high, result, f.clock.now());
      }
      const before = await state(f);
      if (results.at(-1) === 'fail') {
        await refused(await h.resolve(w.id, paidBody(f, w)), 'resolve_query_failed');
        expect(await state(f)).toEqual(before);
      } else {
        await answer(await h.resolve(w.id, paidBody(f, w)), 0);
        expect((await rowOf(f, w)).status).toBe('PAID_API');
      }
    }
    // A later timestamp wins even with a smaller UUID.
    const w = await unknownWithdrawal(f, h, await payee(f, h));
    const { low, high } = lowAndHigh();
    await seedQueryWithId(f, w, high, 'fail', new Date(f.clock.now().getTime() - 1));
    await seedQueryWithId(f, w, low, 'unknown', f.clock.now());
    await answer(await h.resolve(w.id, paidBody(f, w)), 0);
  });
});

it('[AC-B2-09s#8] query失败保护可由后续unknown或本单成功账单解除；别的单或app的成功行不能解除；2xxxx不留幂等记录，同键修复后能成功', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    await setSwitch(f, 'payout.query_status_map', { SUCCESS: 'success' });
    for (const lift of ['query', 'bill']) {
      const w = await unknownWithdrawal(f, h, await payee(f, h));
      await seedQueries(f, w, [['fail', 1]]);
      const key = randomUUID();
      const body = paidBody(f, w);
      await bill(f, w, 'SUCCESS', '2026-11-02', `OTHER${w.out_biz_no.slice(5)}`);
      await bill(otherApp(f), { ...w, app_id: otherApp(f).appId }, 'SUCCESS');
      const before = await state(f);
      await refused(await h.resolve(w.id, body, { key }), 'resolve_query_failed');
      expect(await state(f)).toEqual(before);
      let paid: unknown = body;
      if (lift === 'query') await seedQueries(f, w, [['unknown', 0]]);
      else {
        await bill(f, w, 'SUCCESS');
        const own = await f.db
          .withSchema('app')
          .selectFrom('recon_channel')
          .select('channel_order_id')
          .where('app_id', '=', w.app_id)
          .where('out_biz_no', '=', w.out_biz_no)
          .where('channel_status', '=', 'SUCCESS')
          .executeTakeFirstOrThrow();
        paid = { ...body, channel_order_id: own.channel_order_id };
      }
      await answer(await h.resolve(w.id, paid, { key }), 0);
      expect((await rowOf(f, w)).status).toBe('PAID_API');
    }
  });
});

it('[AC-B2-09s#9] paid_at边界：等于T与Clock+5分钟允许；早于T或超过未来5分钟1毫秒拒绝且无写入', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const offset of [-DAY, -DAY - 1, 300_000, 300_001]) {
      const w = await unknownWithdrawal(f, h, await payee(f, h));
      const paid_at = new Date(f.clock.now().getTime() + offset).toISOString();
      const before = await state(f);
      const response = await h.resolve(w.id, paidBody(f, w, { paid_at }));
      if (offset === -DAY || offset === 300_000) {
        await answer(response, 0);
        expect((await rowOf(f, w)).paid_at).toEqual(new Date(paid_at));
      } else {
        await refused(response, 'resolve_paid_at_invalid', 'paid_at');
        expect(await state(f)).toEqual(before);
      }
    }
  });
});

it('[AC-B2-09s#10] 别的单在任何状态占用流水号都拒绝，不写钱或人工字段；缺少已核实名整个事务回滚', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const status of [
      'PENDING_REVIEW',
      'APPROVED',
      'PAYING',
      'PAID_API',
      'PAID_MANUAL',
      'REJECTED',
      'FAILED',
    ]) {
      const taken = randomUUID();
      await reviewing(f, h, await payee(f, h), { status, channel_order_id: taken });
      const w = await unknownWithdrawal(f, h, await payee(f, h));
      const before = await state(f);
      await refused(
        await h.resolve(w.id, paidBody(f, w, { channel_order_id: taken })),
        'resolve_order_id_taken',
        'channel_order_id',
      );
      expect(await state(f)).toEqual(before);
    }
    const missing = await unknownWithdrawal(f, h, await member(f, h));
    const before = await state(f);
    await refused(
      await h.resolve(missing.id, paidBody(f, missing)),
      'resolve_identity_missing',
      'withdrawal_id',
    );
    expect(await state(f)).toEqual(before);
  });
});

it('[AC-B2-09s#11] 处置只接受PAYING且needs_manual：其他状态含普通PAYING全是20902；未知id、跨app与非UUID为20001，不泄露存在性', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    for (const status of [
      'PENDING_REVIEW',
      'APPROVED',
      'PAID_API',
      'PAID_MANUAL',
      'REJECTED',
      'FAILED',
      'PAYING',
    ]) {
      const w = await reviewing(f, h, await payee(f, h), { status });
      const before = await state(f);
      await answer(await h.resolve(w.id, paidBody(f, w)), 20902, { resource: 'withdrawal' });
      expect(await state(f)).toEqual(before);
    }
    const g = otherApp(f);
    const foreign = await unknownWithdrawal(g, h, await payee(g, h));
    for (const id of [randomUUID(), foreign.id, 'not-a-uuid']) {
      const before = await state(f);
      await answer(await h.resolve(id, paidBody(f, foreign)), 20001, { fields: ['withdrawal_id'] });
      expect(await state(f)).toEqual(before);
    }
    expect((await rowOf(g, foreign)).status).toBe('PAYING');
  });
});
