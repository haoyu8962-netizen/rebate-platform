// B2-09k isolation rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchApproveWithdrawals (`not_found`: unknown id or another app's) and adminRejectWithdrawal
// (unknown or of another app → 20001 data.fields=[withdrawal_id], no 404): only the caller's app is
// touched, and an id of another app answers exactly as an unknown id, so nothing about it leaks.
// Requests go through the real admin entry (review-harness.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  answer,
  everything,
  fieldsError,
  fixture,
  itemsOf,
  member,
  otherApp,
  rejectBody,
  seedApproved,
  seedReview,
  skippedItem,
  suite,
  withReviewAdmin,
} from './review-harness.ts';

const s = suite();

/** The body of an answer without its trace id. */
function withoutTrace(body: string): unknown {
  return { ...(JSON.parse(body) as Record<string, unknown>), trace_id: null };
}

it('[AC-B2-09k#53] 别的 app 的单批量通过：回 not_found，与未知 id 同形；那边的单、余额、凭证、审计一个字不变，本 app 也没有审计', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await withReviewAdmin(f, async (h) => {
    const outsider = await seedReview(other, h, await member(other, h));
    const othersBefore = await everything(f, other.appId);
    const ownBefore = await everything(f);
    const unknown = randomUUID();

    const items = await itemsOf(await h.approve([outsider.id, unknown]));

    expect(items).toEqual([
      skippedItem(outsider.id, 'not_found'),
      skippedItem(unknown, 'not_found'),
    ]);
    expect(await everything(f, other.appId)).toEqual(othersBefore);
    const own = await everything(f);
    expect({ ...own, idempotency: [] }).toEqual({ ...ownBefore, idempotency: [] });
  });
});

it('[AC-B2-09k#54] 别的 app 的单驳回：20001 data.fields=[withdrawal_id]，与未知 id 的应答除 trace_id 外完全相同（不是 404，也不泄露它的状态）；已通过的、待审核的都一样；那边什么都不变', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await withReviewAdmin(f, async (h) => {
    const who = await member(other, h);
    const pending = await seedReview(other, h, who);
    const approved = await seedApproved(other, h, who);
    const othersBefore = await everything(f, other.appId);

    const unknown = await h.reject(randomUUID(), rejectBody());
    await fieldsError(unknown, ['withdrawal_id']);
    for (const row of [pending, approved]) {
      const sent = await h.reject(row.id, rejectBody());
      await answer(sent, 20001, { fields: ['withdrawal_id'] });
      expect(withoutTrace(sent.body)).toEqual(withoutTrace(unknown.body));
    }

    expect(await everything(f, other.appId)).toEqual(othersBefore);
  });
});
