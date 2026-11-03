// B2-09k idempotency rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchApproveWithdrawals, adminRejectWithdrawal — `Idempotency-Key` required: same key and body →
// the first result, whatever X-Step-Up-Token carries; same key with another body → 20901; same key
// while still running → 40901; a new key for a withdrawal already rejected → 20902. A running request
// is held on the member's users row from outside. Requests go through the real admin entry
// (review-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  APPROVE_ACTION,
  BALANCE,
  REJECT_ACTION,
  answer,
  approvedItem,
  audits,
  balanceOf,
  conflict,
  everything,
  fixture,
  itemsOf,
  lockUsersRow,
  member,
  newKey,
  rejectBody,
  rejectedBy,
  returnVouchers,
  rowOf,
  seedReview,
  suite,
  track,
  waiting,
  withReviewAdmin,
} from './review-harness.ts';

const s = suite();

it('[AC-B2-09k#43] 驳回同键同体：重放原样返回第一次的应答（每次的 step-up 令牌不同也一样），只有一张凭证、一条审计，余额只退一次', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const key = newKey();
    const sent = await h.reject(w.id, rejectBody(), { key });
    await rejectedBy(f, sent, w, h.reviewer.id, 'PAYEE_INFO_INVALID');
    const after = await everything(f);

    for (let i = 0; i < 2; i += 1) {
      const again = await h.reject(w.id, rejectBody(), { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }

    expect(await everything(f)).toEqual(after);
    expect(await returnVouchers(f)).toEqual([`wd:${w.id}:RETURN`]);
    expect(await audits(f, REJECT_ACTION)).toHaveLength(1);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: BALANCE,
      frozen_fen: 0n,
    });
  });
});

it('[AC-B2-09k#44] 驳回同键异体（原因码或备注不同）→ 20901；驳回已驳回的单用新键 → 20902 withdrawal；都不新增任何东西', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const key = newKey();
    await rejectedBy(
      f,
      await h.reject(w.id, rejectBody(), { key }),
      w,
      h.reviewer.id,
      'PAYEE_INFO_INVALID',
    );
    const after = await everything(f);

    await answer(await h.reject(w.id, rejectBody({ reason_code: 'OTHER' }), { key }), 20901);
    await answer(await h.reject(w.id, rejectBody({ note: '换一个备注' }), { key }), 20901);
    await conflict(await h.reject(w.id, rejectBody()));

    expect(await everything(f)).toEqual(after);
  });
});

it('[AC-B2-09k#45] 驳回进行中：同一 key 的第一次还在执行时再发（同体或异体）→ 40901；放行后第一次照常完成，之后重放得到它的应答，一张凭证一条审计', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const key = newKey();
    const lock = await lockUsersRow(f.db, f.appId, who.userId);
    const first = track(h.reject(w.id, rejectBody(), { key }));
    try {
      expect(await waiting(f, 1, [first]), '第一次驳回应在 users 行锁上等待').toBe(true);
      await answer(await h.reject(w.id, rejectBody(), { key }), 40901);
      await answer(await h.reject(w.id, rejectBody({ note: '另一个备注' }), { key }), 40901);
      expect(await rowOf(f, w)).toEqual(w);
    } finally {
      await lock.release();
    }
    const sent = await first.promise;
    await rejectedBy(f, sent, w, h.reviewer.id, 'PAYEE_INFO_INVALID');
    expect((await h.reject(w.id, rejectBody(), { key })).body).toBe(sent.body);
    expect(await audits(f, REJECT_ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-09k#46] 驳回的 Idempotency-Key 必填：不带或格式不对 → 20001，什么都不写、不留幂等记录', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const before = await everything(f);
    for (const key of [null, 'short', 'bad key with spaces']) {
      await answer(await h.reject(w.id, rejectBody(), { key }), 20001);
    }
    expect(await everything(f)).toEqual(before);
    expect(before.idempotency).toEqual([]);
  });
});

it('[AC-B2-09k#47] 批量通过同键同体：重放原样返回第一次的逐单结果（不是全变 not_pending），审计不增加；同键异体 → 20901', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const first = await seedReview(f, h, who);
    const second = await seedReview(f, h, who);
    const key = newKey();
    const ids = [first.id, second.id];
    const sent = await h.approve(ids, { key });
    expect(await itemsOf(sent)).toEqual([approvedItem(first.id), approvedItem(second.id)]);
    const after = await everything(f);

    for (let i = 0; i < 2; i += 1) {
      const again = await h.approve(ids, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }
    await answer(await h.approve([first.id], { key }), 20901);

    expect(await everything(f)).toEqual(after);
    expect(await audits(f, APPROVE_ACTION)).toHaveLength(2);
  });
});

it('[AC-B2-09k#48] 批量通过进行中：同一 key 的第一次还在执行时再发（同体或异体）→ 40901；放行后第一次照常完成，之后重放得到它的应答', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const key = newKey();
    const lock = await lockUsersRow(f.db, f.appId, who.userId);
    const first = track(h.approve([w.id], { key }));
    try {
      expect(await waiting(f, 1, [first]), '第一次批量通过应在 users 行锁上等待').toBe(true);
      await answer(await h.approve([w.id], { key }), 40901);
      await answer(await h.approve([w.id, newKey()], { key }), 40901);
      expect(await rowOf(f, w)).toEqual(w);
    } finally {
      await lock.release();
    }
    const sent = await first.promise;
    expect(await itemsOf(sent)).toEqual([approvedItem(w.id)]);
    expect((await h.approve([w.id], { key })).body).toBe(sent.body);
    expect(await audits(f, APPROVE_ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-09k#49] 批量通过的 Idempotency-Key 必填：不带或格式不对 → 20001，什么都不写、不留幂等记录', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const before = await everything(f);
    for (const key of [null, 'short', 'bad key with spaces']) {
      await answer(await h.approve([w.id], { key }), 20001);
    }
    expect(await everything(f)).toEqual(before);
    expect(before.idempotency).toEqual([]);
  });
});
