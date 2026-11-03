// B2-09k order-of-checks rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchApproveWithdrawals and adminRejectWithdrawal, D10-591. Pinned with bodies the route schema
// accepts: withdraw.review (10403 data.reason=admin_permission_denied; a super admin holds every point)
// → step-up totp (10003 data.tier=totp) → the checks after the guard (20001 data.fields). A body the
// route schema refuses is only asserted for a caller with the permission point and a token. Every
// refusal writes nothing. Requests go through the real admin entry (review-harness.ts). Top-level
// it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  REVIEW,
  answer,
  approvedItem,
  chars,
  conflict,
  denied,
  everything,
  fieldsError,
  fixture,
  itemsOf,
  member,
  newKey,
  rejectBody,
  rejectedBy,
  rowOf,
  seedReview,
  stepUpRequired,
  suite,
  withReviewAdmin,
} from './review-harness.ts';

const s = suite();

it('[AC-B2-09k#11] 批量通过的权限：只持 fund.view、没有权限点、只有别的权限点 → 10403，带不带令牌都一样，也先于重复 id 的检查；不带登录令牌 → 10001；什么都不写', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const before = await everything(f);
    const outsiders = [h.viewer, await h.caller([]), await h.caller(['fund.recon'])];
    for (const caller of outsiders) {
      await denied(await h.approve([w.id], { caller }));
      await denied(await h.approve([w.id], { caller, stepUp: null }));
      await denied(await h.approve([w.id, w.id], { caller }));
      await denied(await h.approve([w.id, w.id], { caller, stepUp: null }));
    }
    await answer(await h.approve([w.id], { caller: null }), 10001);
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09k#12] 批量通过的二次验证（动态码档）：不带令牌、令牌是别的账号的、令牌是短信档的 → 10003 data.tier=totp，先于重复 id 的检查；什么都不写；令牌不进请求体哈希，拿到令牌后用同一 Idempotency-Key 重放即成功', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const before = await everything(f);
    const key = newKey();
    const colleague = await h.caller([REVIEW]);
    await stepUpRequired(await h.approve([w.id], { key, stepUp: null }));
    await stepUpRequired(await h.approve([w.id], { key, stepUp: await h.stepUp(colleague) }));
    await stepUpRequired(
      await h.approve([w.id], { key, stepUp: await h.stepUp(h.reviewer, 'sms') }),
    );
    await stepUpRequired(await h.approve([w.id, w.id], { stepUp: null }));
    expect(await everything(f)).toEqual(before);

    expect(await itemsOf(await h.approve([w.id], { key }))).toEqual([approvedItem(w.id)]);
  });
});

it('[AC-B2-09k#13] 重复 id（有权限且带令牌）→ 20001 data.fields=[withdrawal_ids]，一单都不通过、什么都不写', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const first = await seedReview(f, h, who);
    const second = await seedReview(f, h, who);
    const before = await everything(f);
    await fieldsError(await h.approve([first.id, second.id, first.id]), ['withdrawal_ids']);
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09k#14] 批量通过的请求体 schema（有权限且带令牌）：缺字段、空数组、超过 200 个、不是数组、元素不是字符串或超长、多带键 → 20001 data.fields 恰为该字段；什么都不写', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const before = await everything(f);
    const cases: readonly (readonly [unknown, string])[] = [
      [{}, 'withdrawal_ids'],
      [{ withdrawal_ids: [] }, 'withdrawal_ids'],
      [{ withdrawal_ids: Array.from({ length: 201 }, () => randomUUID()) }, 'withdrawal_ids'],
      [{ withdrawal_ids: randomUUID() }, 'withdrawal_ids'],
      [{ withdrawal_ids: [1] }, 'withdrawal_ids.0'],
      [{ withdrawal_ids: ['x'.repeat(65)] }, 'withdrawal_ids.0'],
      [{ withdrawal_ids: [randomUUID()], reviewer_id: randomUUID() }, 'reviewer_id'],
    ];
    for (const [body, field] of cases) {
      await fieldsError(await h.approveBody(body), [field]);
    }
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09k#15] 一个动态码档令牌覆盖整批：同一令牌一次通过 3 单；令牌成功后被消费，再用 → 10003', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const rows = [
      await seedReview(f, h, who),
      await seedReview(f, h, who),
      await seedReview(f, h, who),
    ];
    const stepUp = await h.stepUp(h.reviewer);

    const ids = rows.map((row) => row.id);

    const items = await itemsOf(await h.approve(ids, { stepUp }));

    expect(items).toEqual(rows.map((row) => approvedItem(row.id)));
    const next = await seedReview(f, h, who);
    await stepUpRequired(await h.approve([next.id], { stepUp }));
    expect(await rowOf(f, next)).toEqual(next);
  });
});

it('[AC-B2-09k#16] 超管没有权限点行也能批量通过与驳回，reviewer_id 是超管；超管同样要动态码档（无令牌 10003）', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const root = await h.caller([], { superAdmin: true });
    const who = await member(f, h);
    const toApprove = await seedReview(f, h, who);
    const toReject = await seedReview(f, h, who);
    await stepUpRequired(await h.approve([toApprove.id], { caller: root, stepUp: null }));
    await stepUpRequired(await h.reject(toReject.id, rejectBody(), { caller: root, stepUp: null }));
    expect(await rowOf(f, toApprove)).toEqual(toApprove);
    expect(await rowOf(f, toReject)).toEqual(toReject);

    expect(await itemsOf(await h.approve([toApprove.id], { caller: root }))).toEqual([
      approvedItem(toApprove.id),
    ]);
    expect(await rowOf(f, toApprove)).toMatchObject({ reviewer_id: root.id });
    await rejectedBy(
      f,
      await h.reject(toReject.id, rejectBody(), { caller: root }),
      toReject,
      root.id,
      'PAYEE_INFO_INVALID',
    );
    expect(await rowOf(f, toReject)).toMatchObject({ reviewer_id: root.id, status: 'REJECTED' });
  });
});

it('[AC-B2-09k#17] 驳回的校验顺序：10403 先于 10003 先于空白 note 先于未知 id 先于状态（有转账尝试的判断在状态之后）；什么都不写', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const pending = await seedReview(f, h, who);
    const final = await seedReview(f, h, who, { status: 'REJECTED' });
    const unknown = randomUUID();
    const before = await everything(f);
    const passable = [
      [pending.id, rejectBody()],
      [pending.id, rejectBody({ note: '   ' })],
      [pending.id, { reason_code: 'USER_REQUEST' }],
      [unknown, rejectBody()],
      [final.id, rejectBody()],
    ] as const;

    const outsiders = [h.viewer, await h.caller([]), await h.caller(['fund.recon'])];
    for (const caller of outsiders) {
      for (const [id, body] of passable) {
        await denied(await h.reject(id, body, { caller }));
        await denied(await h.reject(id, body, { caller, stepUp: null }));
      }
    }
    const colleague = await h.caller([REVIEW]);
    for (const [id, body] of passable) {
      await stepUpRequired(await h.reject(id, body, { stepUp: null }));
      await stepUpRequired(await h.reject(id, body, { stepUp: await h.stepUp(colleague) }));
      await stepUpRequired(await h.reject(id, body, { stepUp: await h.stepUp(h.reviewer, 'sms') }));
    }
    await answer(await h.reject(pending.id, rejectBody(), { caller: null }), 10001);

    await fieldsError(await h.reject(unknown, rejectBody({ note: '   ' })), ['note']);
    await fieldsError(await h.reject(final.id, rejectBody({ note: '   ' })), ['note']);
    await fieldsError(await h.reject(unknown, { reason_code: 'USER_REQUEST' }), ['note']);
    await fieldsError(await h.reject(unknown, rejectBody()), ['withdrawal_id']);
    await fieldsError(await h.reject('not-a-uuid', rejectBody()), ['withdrawal_id']);
    await conflict(await h.reject(final.id, rejectBody()));
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-09k#18] 驳回的请求体 schema（有权限且带令牌）：缺 reason_code、NEGATIVE_BALANCE（系统专用）、未知原因码、空串 note、超过 500 字的 note、note 不是字符串、多带键、超长的路径 id → 20001 data.fields 恰为该字段；什么都不写', async () => {
  const f = fixture(s);
  await withReviewAdmin(f, async (h) => {
    const who = await member(f, h);
    const w = await seedReview(f, h, who);
    const before = await everything(f);
    const cases: readonly (readonly [unknown, string])[] = [
      [{ note: '合成备注' }, 'reason_code'],
      [rejectBody({ reason_code: 'NEGATIVE_BALANCE' }), 'reason_code'],
      [rejectBody({ reason_code: 'INFO_MISMATCH' }), 'reason_code'],
      [rejectBody({ note: '' }), 'note'],
      [rejectBody({ note: chars(501) }), 'note'],
      [rejectBody({ note: 1 }), 'note'],
      [rejectBody({ reviewer_id: randomUUID() }), 'reviewer_id'],
    ];
    for (const [body, field] of cases) {
      await fieldsError(await h.reject(w.id, body), [field]);
    }
    await fieldsError(await h.reject('x'.repeat(65), rejectBody()), ['withdrawal_id']);
    expect(await everything(f)).toEqual(before);
  });
});
