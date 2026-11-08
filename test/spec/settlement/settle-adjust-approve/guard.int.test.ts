// B2-09zc rule tests (claude-independent, SPEC_REF b79958d): the checks in front of approval and
// rejection (contracts/openapi.yaml adminApproveSettleAdjustBatch / adminRejectSettleAdjustBatch,
// CT-24zv; 08 BR-FUND-09 ②「须由超管或被勾选补差权限的账号 step-up 批准」, ADD-05; D10-770 ①).
// Order of checks: fund.settle_adjust (10403 data.reason=admin_permission_denied) → totp step-up
// (10003 data.tier=totp) → body (20001) → unknown batch or a batch of another app (20001
// data.fields=[batch_id], no 404) → a confirmed batch (20902 data.resource=settle_adjust_batch).
// Idempotency-Key: same key and body → the first result; same key with another body → 20901.
// A refused call writes nothing (candidates, batches, vouchers, balances, audit).
// Example order (08 BR-FUND-09 例「正差，批准后」): credited at 1234 (617 / 123 / 494, reserve 0); a
// settlement of 1300 → candidates +33 / +7 / +26.
import { expect, it } from 'vitest';
import {
  APPROVE_ACTION,
  BATCH_RESOURCE,
  EXAMPLE,
  REJECT_ACTION,
  TIMEOUT,
  answer,
  approveHarness,
  approveSuite,
  expectApproved,
  newKey,
  result,
  userAdjKey,
  withAdmin,
} from './kit.ts';

const s = approveSuite();

it(
  '[AC-B2-09zc#1] 只有 fund.view（无 fund.settle_adjust）：批准、拒绝都 10403 data.reason=admin_permission_denied，什么都不写',
  async () => {
    const h = await approveHarness(s);
    await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    h.clock.advanceMs(60_000);
    await withAdmin(s, h, async (a) => {
      const before = await h.footprint();
      await answer(await a.approve(batchId, { caller: a.viewer }), 10403, {
        reason: 'admin_permission_denied',
      });
      await answer(await a.reject(batchId, { reason: '核对不符' }, { caller: a.viewer }), 10403, {
        reason: 'admin_permission_denied',
      });
      // Permission comes first: without a step-up and with a bad body it is still 10403.
      await answer(
        await a.approve(batchId, { caller: a.viewer, stepUp: null, body: { amount_fen: 1 } }),
        10403,
        { reason: 'admin_permission_denied' },
      );
      await answer(await a.reject(batchId, {}, { caller: a.viewer, stepUp: null }), 10403, {
        reason: 'admin_permission_denied',
      });
      expect(await h.footprint()).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#1] 缺 step-up 或 sms 档：批准、拒绝都 10003 data.tier=totp（先于请求体校验），什么都不写',
  async () => {
    const h = await approveHarness(s);
    await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    await withAdmin(s, h, async (a) => {
      const before = await h.footprint();
      const sms = () => a.stepUp(a.adjuster, 'sms');
      await answer(await a.approve(batchId, { stepUp: null }), 10003, { tier: 'totp' });
      await answer(await a.approve(batchId, { stepUp: await sms() }), 10003, { tier: 'totp' });
      await answer(await a.reject(batchId, { reason: '核对不符' }, { stepUp: null }), 10003, {
        tier: 'totp',
      });
      await answer(
        await a.reject(batchId, { reason: '核对不符' }, { stepUp: await sms() }),
        10003,
        {
          tier: 'totp',
        },
      );
      await answer(await a.approve(batchId, { stepUp: null, body: { amount_fen: 1 } }), 10003, {
        tier: 'totp',
      });
      await answer(await a.reject(batchId, {}, { stepUp: null }), 10003, { tier: 'totp' });
      expect(await h.footprint()).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#1] 请求体校验 → 20001：批准只收空对象；拒绝的 reason 必填、1–200 字、不收别的字段；什么都不写',
  async () => {
    const h = await approveHarness(s);
    await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    await withAdmin(s, h, async (a) => {
      const before = await h.footprint();
      await answer(await a.approve(batchId, { body: { amount_fen: 33 } }), 20001);
      await answer(await a.reject(batchId, {}), 20001);
      await answer(await a.reject(batchId, { reason: '' }), 20001);
      await answer(await a.reject(batchId, { reason: '因'.repeat(201) }), 20001);
      await answer(await a.reject(batchId, { reason: 7 }), 20001);
      await answer(await a.reject(batchId, { reason: '核对不符', amount_fen: 1 }), 20001);
      expect(await h.footprint()).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#1] 不存在的 batch_id、别的 app 的批次 → 20001 data.fields=[batch_id]（不是 404）；两边都不写',
  async () => {
    const h = await approveHarness(s);
    await h.raised(EXAMPLE, 1300n);
    const own = await h.generate();
    const other = await approveHarness(s);
    await other.raised(EXAMPLE, 1300n);
    const foreign = await other.generate();
    await withAdmin(s, h, async (a) => {
      const before = await h.footprint();
      const otherBefore = await other.footprint();
      const unknown = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4fb999';
      for (const batchId of [unknown, foreign]) {
        await answer(await a.approve(batchId), 20001, { fields: ['batch_id'] });
        await answer(await a.reject(batchId, { reason: '核对不符' }), 20001, {
          fields: ['batch_id'],
        });
      }
      // A path value that is not an Id is a validation error of the path parameter.
      await answer(await a.approve('not-a-batch'), 20001);
      expect(await h.footprint()).toEqual(before);
      expect(await other.footprint()).toEqual(otherBefore);
      expect((await h.batch(own)).confirmed_at).toBeNull();
      // The same caller's own batch is served (the refusals above are not a missing route).
      await answer(await a.reject(own, { reason: '核对不符' }), 0);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#1] 已确认的批次（批准过或拒绝过）：再批准、再拒绝都 20902 data.resource=settle_adjust_batch，不再写凭证或审计',
  async () => {
    const h = await approveHarness(s);
    const approved = await h.raised(EXAMPLE, 1300n);
    const approvedBatch = await h.generate();
    const rejected = await h.raised(EXAMPLE, 1300n);
    // The second run only takes the order that has no pending candidate yet.
    const rejectedBatch = await h.generate();
    expect(rejectedBatch).not.toBe(approvedBatch);
    expect((await h.rowsOf(rejected.o)).map((r) => r.batch_id)).toEqual([
      rejectedBatch,
      rejectedBatch,
      rejectedBatch,
    ]);
    await withAdmin(s, h, async (a) => {
      await expectApproved(await a.approve(approvedBatch), approvedBatch, [
        result(approved.o, 'approved', 40),
      ]);
      await answer(await a.reject(rejectedBatch, { reason: '核对不符' }), 0, {
        batch_id: rejectedBatch,
        rejected_count: 3,
      });
      const before = await h.footprint();
      const conflict = { resource: BATCH_RESOURCE };
      await answer(await a.approve(approvedBatch), 20902, conflict);
      await answer(await a.reject(approvedBatch, { reason: '再拒绝' }), 20902, conflict);
      await answer(await a.approve(rejectedBatch), 20902, conflict);
      await answer(await a.reject(rejectedBatch, { reason: '再拒绝' }), 20902, conflict);
      expect(await h.footprint()).toEqual(before);
      expect(await h.audits(APPROVE_ACTION)).toHaveLength(1);
      expect(await h.audits(REJECT_ACTION)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#1] 批准幂等：同键同体重放答第一次结果，凭证只写一次、审计只一条',
  async () => {
    const h = await approveHarness(s);
    const { o, seq } = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    await withAdmin(s, h, async (a) => {
      const key = newKey();
      const first = await expectApproved(await a.approve(batchId, { key }), batchId, [
        result(o, 'approved', 40),
      ]);
      const after = await h.footprint();
      const replay = await expectApproved(await a.approve(batchId, { key }), batchId, [
        result(o, 'approved', 40),
      ]);
      expect(replay).toEqual(first);
      expect(await h.footprint()).toEqual(after);
      expect(await h.audits(APPROVE_ACTION)).toHaveLength(1);
      const keys = (await h.vouchers()).map((v) => v.uniq_key);
      expect(keys.filter((k) => k === userAdjKey(o, 'self', seq))).toHaveLength(1);
      expect(await h.balance(o.user('self'))).toBe(650n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#1] 拒绝幂等：同键同体重放答第一次结果、审计只一条；同键换体（另一个 reason）→ 20901，不改已拒绝的行',
  async () => {
    const h = await approveHarness(s);
    const { o } = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    await withAdmin(s, h, async (a) => {
      const key = newKey();
      const first = await answer(await a.reject(batchId, { reason: '核对不符' }, { key }), 0, {
        batch_id: batchId,
        rejected_count: 3,
      });
      const after = await h.footprint();
      const replay = await answer(await a.reject(batchId, { reason: '核对不符' }, { key }), 0);
      expect(replay.data).toEqual(first.data);
      await answer(await a.reject(batchId, { reason: '另一个原因' }, { key }), 20901);
      expect(await h.footprint()).toEqual(after);
      expect(await h.audits(REJECT_ACTION)).toHaveLength(1);
      expect((await h.rowsOf(o)).map((r) => r.reason)).toEqual([
        '核对不符',
        '核对不符',
        '核对不符',
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09zc#1] 超管（无单独权限点）同样可以批准',
  async () => {
    const h = await approveHarness(s);
    const { o } = await h.raised(EXAMPLE, 1300n);
    const batchId = await h.generate();
    await withAdmin(s, h, async (a) => {
      const root = await a.caller([], { superAdmin: true });
      await expectApproved(await a.approve(batchId, { caller: root }), batchId, [
        result(o, 'approved', 40),
      ]);
      expect((await h.batch(batchId)).confirmed_by).toBe(root.id);
      expect((await h.audits(APPROVE_ACTION)).map((r) => r.admin_id)).toEqual([root.id]);
    });
  },
  TIMEOUT,
);
