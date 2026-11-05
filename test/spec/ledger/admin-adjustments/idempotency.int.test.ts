// B2-12c idempotency (claude-independent): adminCreateAdjustment `Idempotency-Key` is required: same
// key and body → the first result; same key with another body → 20901; same key while still running
// → 40901. The step-up token is a header and not part of the body hash, so a replay after a 10003
// keeps its key; a used token is spent (BR-ID-34 / permission guard: one successful request), so
// every new request needs a new sms-tier token. A replay writes nothing: one form, one voucher, one
// audit record, one message.
import { expect, it } from 'vitest';
import {
  CREATE_ACTION,
  answer,
  audits,
  expectAdjusted,
  fixture,
  holdMember,
  inboxOf,
  member,
  newForm,
  newKey,
  seedReconDiff,
  stepUpRequired,
  suite,
  trace,
  track,
  waiting,
  withAdjustAdmin,
  type Ref,
} from './kit.ts';

const s = suite();

it('[AC-B2-12c#23] 同一 Idempotency-Key 同一请求体重放（带新的短信档令牌）：原样返回第一次的应答，只有一张单、一张凭证、一条审计、一条站内信；用已用过的令牌重放 → 10003 sms；同 key 换请求体 → 20901', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const body = newForm({
      userId,
      direction: 'decrease',
      amount: 500n,
      reason: 'RECON_FIX',
      refs: [diff],
      note: '多记的结算冲减',
      contra: 'COMMISSION_REVENUE',
    });
    const key = newKey();
    const token = await h.stepUp(h.maker);
    const sent = await h.create(body, { key, stepUp: token });
    await expectAdjusted(f, sent, {
      caller: h.maker,
      userId,
      direction: 'decrease',
      amount: 500n,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
      refs: [diff],
      note: '多记的结算冲减',
      before: { available: 3000n, frozen: 0n },
    });
    const after = await trace(f);
    const recorded = await audits(f);

    await stepUpRequired(await h.create(body, { key, stepUp: token }));
    for (let i = 0; i < 2; i += 1) {
      const again = await h.create(body, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }
    await answer(await h.create({ ...body, amount_fen: 600 }, { key }), 20901);

    expect(await trace(f)).toEqual(after);
    expect(await audits(f)).toEqual(recorded);
    expect(after.forms).toHaveLength(1);
    expect(await audits(f, CREATE_ACTION)).toHaveLength(1);
    expect(await inboxOf(f, userId)).toHaveLength(1);
  });
});

it('[AC-B2-12c#24] Idempotency-Key 必填（不带 → 20001，不留痕）；10003 之后同一 key 带令牌照常生效；同一 key 的第一次还在执行时再发（同体或换体）→ 40901，放行后第一次照常完成，之后重放得到它的应答', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };
    const body = (amount: bigint) =>
      newForm({
        userId,
        direction: 'increase',
        amount,
        reason: 'RECON_FIX',
        refs: [diff],
        note: '漏记的结算补回',
        contra: 'UNION_RECEIVABLE',
        platform: 'pdd',
      });
    const expectation = (amount: bigint, available: bigint) => ({
      caller: h.maker,
      userId,
      direction: 'increase' as const,
      amount,
      reason: 'RECON_FIX',
      contra: 'UNION_RECEIVABLE',
      platform: 'pdd',
      refs: [diff],
      note: '漏记的结算补回',
      before: { available, frozen: 0n },
    });
    const before = await trace(f);
    await answer(await h.create(body(100n), { key: null }), 20001);
    expect(await trace(f)).toEqual(before);

    const key = newKey();
    await stepUpRequired(await h.create(body(100n), { key, stepUp: null }));
    await expectAdjusted(f, await h.create(body(100n), { key }), expectation(100n, 3000n));

    const running = newKey();
    const lock = await holdMember(f, userId);
    const first = track(h.create(body(200n), { key: running }));
    try {
      expect(await waiting(f, 1, [first]), '第一次请求应在会员行锁上等待').toBe(true);
      await answer(await h.create(body(200n), { key: running }), 40901);
      await answer(await h.create(body(300n), { key: running }), 40901);
    } finally {
      await lock.release();
    }
    const sent = await first.promise;
    await expectAdjusted(f, sent, expectation(200n, 3100n));
    const replay = await h.create(body(200n), { key: running });
    expect(replay.body).toBe(sent.body);
    expect(await audits(f, CREATE_ACTION)).toHaveLength(2);
  });
});
