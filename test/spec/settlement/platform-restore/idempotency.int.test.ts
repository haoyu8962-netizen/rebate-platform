// B2-09gb rule tests, idempotency, concurrency and the order lock (claude-independent, SPEC_REF
// 29c27a1b): contracts/openapi.yaml restoreAdminReconDiff (`Idempotency-Key` required: same key and
// body → the first result; another body → 20901; a new key for a difference already adjusted →
// 20902 recon_diff; "the same holds for both types") and settlement AGENTS.md 硬规则 3 / 4 (the order
// key's advisory lock first; idempotency on PostgreSQL constraints) — a replay never posts twice, two
// restores of one difference at once succeed exactly once, a restore waits for the order key's lock.
// Requests go through the real admin entry (kit.ts). Top-level it() only.
import { expect, it } from 'vitest';
import {
  RESTORE,
  RESTORE_ACTION,
  answer,
  audits,
  available,
  diffConflict,
  diffNow,
  fixture,
  holdOrderKey,
  newKey,
  orderRow,
  platformKey,
  platformRestored,
  restoreKey,
  restoreVouchers,
  seedBareOrder,
  seedClawedBack,
  seedPlatformDiff,
  suite,
  track,
  waiting,
  withRestoreAdmin,
  world,
} from './kit.ts';

const s = suite();

it('[AC-B2-09gb#20] 幂等（R13 与 R12）：同一 Idempotency-Key 同一请求体重放 → 原样返回第一次的应答（同一 restored_fen 与 rebate_status_after），不再记账、不再写审计、不再改订单；同 key 换请求体 → 20901；新 key → 20902 recon_diff；别的账号用同一 key 是它自己的作用域 → 20902 recon_diff', async () => {
  const f = await fixture(s);
  const clawed = await seedClawedBack(f);
  const clawedDiff = await seedPlatformDiff(f, clawed);
  const voided = await seedBareOrder(f);
  const voidDiff = await seedPlatformDiff(f, voided);
  await withRestoreAdmin(f, async (h) => {
    const colleague = await h.caller([RESTORE]);
    for (const [diff, fen, status] of [
      [clawedDiff, 1105, 'CREDITED'],
      [voidDiff, 0, 'ESTIMATED'],
    ] as const) {
      const key = newKey();
      const body = { note: '核对后恢复' };
      const sent = await h.restore(diff.id, body, { key });
      const data = await platformRestored(sent);
      expect(data.restored_fen, status).toBe(fen);
      expect(data.rebate_status_after, status).toBe(status);
      const after = await world(f);

      for (let i = 0; i < 2; i += 1) {
        const again = await h.restore(diff.id, body, { key });
        expect(again.statusCode, status).toBe(sent.statusCode);
        expect(again.body, status).toBe(sent.body);
      }
      await answer(await h.restore(diff.id, { note: '换一个说明' }, { key }), 20901);
      await diffConflict(await h.restore(diff.id, body));
      await diffConflict(await h.restore(diff.id, body, { key, caller: colleague }));
      expect(await world(f), status).toEqual(after);
    }
    expect((await restoreVouchers(f)).map((v) => v.uniq_key).sort()).toEqual(
      [
        restoreKey(clawed.orderKey, clawed.user('self'), 'self', clawedDiff.id),
        restoreKey(clawed.orderKey, clawed.user('direct'), 'direct', clawedDiff.id),
        restoreKey(clawed.orderKey, clawed.user('indirect'), 'indirect', clawedDiff.id),
        platformKey(clawed.orderKey, clawedDiff.id),
      ].sort(),
    );
    expect(await audits(f, RESTORE_ACTION)).toHaveLength(2);
    expect(await available(f, clawed.user('self'))).toBe(850n);
  });
});

it('[AC-B2-09gb#21] 并发：同一张平台恢复差错单两个处理同时到（不同 key）→ 恰一个成功、另一个 20902 recon_diff；RESTORE 凭证各一张、审计一条、余额只多一次、订单只迁移一次（CREDITED，booked 1700 / 2000）', async () => {
  const f = await fixture(s);
  const c = await seedClawedBack(f);
  const diff = await seedPlatformDiff(f, c);
  await withRestoreAdmin(f, async (h) => {
    const results = await Promise.all([h.restore(diff.id), h.restore(diff.id)]);
    expect(results.map((sent) => sent.statusCode).sort((a, b) => a - b)).toEqual([200, 409]);
    for (const sent of results) {
      if (sent.statusCode === 200) expect((await platformRestored(sent)).restored_fen).toBe(1105);
      else await diffConflict(sent);
    }
    expect(await restoreVouchers(f)).toHaveLength(4);
    expect(await audits(f, RESTORE_ACTION)).toHaveLength(1);
    expect(await available(f, c.user('self'))).toBe(850n);
    expect(await available(f, c.user('direct'))).toBe(170n);
    const order = await orderRow(f, c.orderId);
    expect(order.rebate_status).toBe('CREDITED');
    expect(order.booked_base_fen).toBe(1700n);
    expect(order.booked_n_fen).toBe(2000n);
  });
});

it('[AC-B2-09gb#22] 锁序：订单键 advisory 锁被别的事务持有时处理等待，期间订单、差错单、账务都不变；放行后完成（R13 补 1105）', async () => {
  const f = await fixture(s);
  const c = await seedClawedBack(f);
  const diff = await seedPlatformDiff(f, c);
  await withRestoreAdmin(f, async (h) => {
    const orderBefore = await orderRow(f, c.orderId);
    const lock = await holdOrderKey(f, c.orderKey);
    const pending = track(h.restore(diff.id));
    try {
      expect(await waiting(f, 1, [pending]), '处理应在订单键锁上等待').toBe(true);
      expect(await diffNow(f, diff.id)).toEqual(diff);
      expect(await orderRow(f, c.orderId)).toEqual(orderBefore);
      expect(await restoreVouchers(f)).toEqual([]);
    } finally {
      await lock.release();
    }
    expect((await platformRestored(await pending.promise)).restored_fen).toBe(1105);
  });
});
