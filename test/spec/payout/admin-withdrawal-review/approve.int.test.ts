// B2-09k batch approve rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchApproveWithdrawals, 08 BR-WDR-10, BR-WDR-05 (a) (b) — each id in its own transaction, in
// the order given; W2 with reviewer_id the caller and reviewed_at the injected Clock; no voucher, the
// money stays frozen; approving does not pay (no batch, no transfer job); results per id in request
// order: approved, or skipped with not_found / not_pending / negative_balance / blocked; a risk freeze
// or an effective hold does not stop the review. Requests go through the real admin entry
// (review-harness.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ACCOUNT,
  AFTER_FREEZE,
  AMOUNT,
  APPROVE_ACTION,
  MESSAGE_QUEUE,
  adjust,
  approvedItem,
  auditText,
  audits,
  balanceOf,
  changes,
  everything,
  expectNoSecrets,
  fixture,
  frozenMismatches,
  itemsOf,
  jobQueues,
  member,
  otherApp,
  rowOf,
  secretsOf,
  seedApproved,
  seedHold,
  seedReview,
  seedRiskState,
  skippedItem,
  suite,
  withReviewAdmin,
} from './review-harness.ts';

const s = suite();

it('[AC-B2-09k#3] W2：PENDING_REVIEW → APPROVED，reviewer_id 是调用者、reviewed_at 是注入时钟、row_version + 1，其余列不变；不写凭证，frozen 12,345 与 available 87,658 不动；没有批次、没有转账尝试，只排通知的一条事件任务（通过不打款）', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const before = await everything(f);

    expect(await itemsOf(await h.approve([w.id]))).toEqual([approvedItem(w.id)]);

    expect(await rowOf(f, w)).toEqual({
      ...w,
      status: 'APPROVED',
      reviewer_id: h.reviewer.id,
      reviewed_at: f.clock.now(),
      row_version: w.row_version + 1,
      updated_at: f.clock.now(),
    });
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: AMOUNT,
    });
    const after = await everything(f);
    expect(after.vouchers).toEqual(before.vouchers);
    expect(after.entries).toEqual(before.entries);
    expect(after.balances).toEqual(before.balances);
    expect(after.batches).toEqual([]);
    expect(after.attempts).toEqual([]);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: w.id, user_id: who.userId, status: 'APPROVED' },
    ]);
    expect(await jobQueues(f)).toEqual([MESSAGE_QUEUE]);
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09k#4] W2 守卫：available 为负（-1,001）→ skipped negative_balance，单与余额都不动、无审计；available 恰好为 0 不算负，可以通过', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const negative = await member(f, h, AMOUNT);
    const blockedByBalance = await seedReview(f, h, negative);
    await adjust(f, negative, -1_001n);
    const zero = await member(f, h, AMOUNT);
    const atZero = await seedReview(f, h, zero);
    const before = await everything(f);

    expect(await itemsOf(await h.approve([blockedByBalance.id, atZero.id]))).toEqual([
      skippedItem(blockedByBalance.id, 'negative_balance'),
      approvedItem(atZero.id),
    ]);

    expect(await rowOf(f, blockedByBalance)).toEqual(blockedByBalance);
    expect(await rowOf(f, atZero)).toMatchObject({
      status: 'APPROVED',
      reviewer_id: h.reviewer.id,
    });
    expect(await balanceOf(f.db, f.ledger, f.appId, negative.userId)).toEqual({
      available_fen: -1_001n,
      frozen_fen: AMOUNT,
    });
    expect(await balanceOf(f.db, f.ledger, f.appId, zero.userId)).toEqual({
      available_fen: 0n,
      frozen_fen: AMOUNT,
    });
    const after = await everything(f);
    expect(after.vouchers).toEqual(before.vouchers);
    expect((await audits(f, APPROVE_ACTION)).map((record) => record.target)).toEqual([atZero.id]);
  });
});

it('[AC-B2-09k#5] W2 守卫：blocked_reason 非空（余额不为负）→ skipped blocked，什么都不写（BR-WDR-10：余额为负或 blocked_reason 非空时不得审核通过）', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who, { blocked_reason: 'NEGATIVE_BALANCE' });
    const before = await everything(f);

    const items = await itemsOf(await h.approve([w.id]));

    expect(items).toEqual([skippedItem(w.id, 'blocked')]);
    const after = await everything(f);
    expect({ ...after, idempotency: [] }).toEqual({ ...before, idempotency: [] });
  });
});

it('[AC-B2-09k#6] 风控冻结或封禁的会员可以审核通过（BR-WDR-05 (b)：W2 不受影响），冻结状态不被改动', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const frozen = await member(f, h);
    const banned = await member(f, h);
    await seedRiskState(f, frozen, 'frozen');
    await seedRiskState(f, banned, 'banned');
    const first = await seedReview(f, h, frozen);
    const second = await seedReview(f, h, banned);

    expect(await itemsOf(await h.approve([first.id, second.id]))).toEqual([
      approvedItem(first.id),
      approvedItem(second.id),
    ]);

    expect(await rowOf(f, first)).toMatchObject({ status: 'APPROVED', reviewer_id: h.reviewer.id });
    expect(await rowOf(f, second)).toMatchObject({
      status: 'APPROVED',
      reviewer_id: h.reviewer.id,
    });
    const states = await f.db
      .selectFrom('user_risk_state')
      .select(['user_id', 'state'])
      .where('app_id', '=', f.appId)
      .orderBy('state')
      .execute();
    expect(states).toEqual([
      { user_id: banned.userId, state: 'banned' },
      { user_id: frozen.userId, state: 'frozen' },
    ]);
  });
});

it('[AC-B2-09k#7] 有生效 withdraw_holds 的会员可以审核通过（BR-WDR-10），冻结记录不动', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const hold = await seedHold(f, who, { reason: 'manual' });
    const w = await seedReview(f, h, who);

    expect(await itemsOf(await h.approve([w.id]))).toEqual([approvedItem(w.id)]);

    expect(await rowOf(f, w)).toMatchObject({ status: 'APPROVED', reviewer_id: h.reviewer.id });
    expect((await everything(f)).holds).toEqual([hold]);
  });
});

it('[AC-B2-09k#8] 逐单互不影响：一批混着可通过、已通过、未知 id、别的 app 的 id、余额为负、已驳回，结果按请求顺序逐条对，可通过的（含同一会员的两单）都通过；跳过的单一个字不变', async () => {
  const f = fixture(s);
  const other = otherApp(f);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const first = await seedReview(f, h, who);
    const sameMember = await seedReview(f, h, who);
    const done = await seedApproved(f, h, who);
    const rejected = await seedReview(f, h, who, { status: 'REJECTED' });
    const negative = await member(f, h, AMOUNT);
    const poor = await seedReview(f, h, negative);
    await adjust(f, negative, -7n);
    const outsider = await seedReview(f, h, await member(other, h));
    const unknown = randomUUID();
    const othersBefore = await everything(f, other.appId);

    const items = await itemsOf(
      await h.approve([
        unknown,
        first.id,
        done.id,
        outsider.id,
        poor.id,
        rejected.id,
        sameMember.id,
      ]),
    );

    expect(items).toEqual([
      skippedItem(unknown, 'not_found'),
      approvedItem(first.id),
      skippedItem(done.id, 'not_pending'),
      skippedItem(outsider.id, 'not_found'),
      skippedItem(poor.id, 'negative_balance'),
      skippedItem(rejected.id, 'not_pending'),
      approvedItem(sameMember.id),
    ]);
    expect(await rowOf(f, first)).toMatchObject({ status: 'APPROVED', reviewer_id: h.reviewer.id });
    expect(await rowOf(f, sameMember)).toMatchObject({
      status: 'APPROVED',
      reviewer_id: h.reviewer.id,
    });
    expect(await rowOf(f, done)).toEqual(done);
    expect(await rowOf(f, rejected)).toEqual(rejected);
    expect(await rowOf(f, poor)).toEqual(poor);
    expect(await everything(f, other.appId)).toEqual(othersBefore);
    expect((await audits(f, APPROVE_ACTION)).map((record) => record.target).sort()).toEqual(
      [first.id, sameMember.id].sort(),
    );
  });
});

it('[AC-B2-09k#9] 审计：withdrawal_approve 逐单一条，操作人是调用者、时间是注入时钟、带 withdrawal_id 与前后状态，不含收款账号、姓名、手机号；跳过的单没有审计', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const first = await seedReview(f, h, who);
    const second = await seedReview(f, h, who);
    const done = await seedApproved(f, h, who);

    await itemsOf(await h.approve([first.id, done.id, second.id]));

    const records = await audits(f, APPROVE_ACTION);
    expect(records.map((record) => record.admin_id)).toEqual([h.reviewer.id, h.reviewer.id]);
    expect(records.map((record) => record.at)).toEqual([f.clock.now(), f.clock.now()]);
    const texts = records.map(auditText);
    for (const [index, row] of [first, second].entries()) {
      expect(texts[index]).toContain(row.id);
      expect(texts[index]).toContain('PENDING_REVIEW');
      expect(texts[index]).toContain('APPROVED');
      expectNoSecrets(texts[index] ?? '', secretsOf(row, ACCOUNT.alipay, who));
    }
    expect(texts.join('\n')).not.toContain(done.id);
  });
});

it('[AC-B2-09k#10] 边界：恰好 200 个 id 通过 schema，逐个有结果；不是 uuid 的 id（schema 只限长度）按未知 id 回 not_found，不是 5xx', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const rest = Array.from({ length: 198 }, () => randomUUID());
    const ids = [w.id, 'not-a-uuid', ...rest];

    const items = await itemsOf(await h.approve(ids));

    expect(items).toEqual([
      approvedItem(w.id),
      skippedItem('not-a-uuid', 'not_found'),
      ...rest.map((id) => skippedItem(id, 'not_found')),
    ]);
  });
});
