// B2-09l audit rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch — an audit record for either outcome, action payout_batch_execute, with the
// `outcome`, the `batch_id` or `reason` (and `channel` for a watermark reason), the counts and ids of
// `paying` and `left`; no personal data (BR-WDR-11: 全程写审计日志). Where the writer puts them inside
// before / after is not pinned. Requests go through the real admin entry (batch-harness.ts). Top-level
// it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ACCOUNT,
  ACTION,
  PLENTY,
  approved,
  auditFacts,
  audits,
  expectExecuted,
  expectNoSecrets,
  expectRejected,
  fixture,
  payee,
  pending,
  secretsOf,
  seedRiskState,
  seedW,
  setSwitch,
  suite,
  withBatchAdmin,
} from './batch-harness.ts';

const s = suite();

it('[AC-B2-09l#48] executed：恰一条 payout_batch_execute，操作人是调用者、时间是注入时钟；含 outcome、batch_id、paying 与 left 的 id 和数量（2 与 3）；不含收款账号、姓名、手机号', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const first = await approved(f, h, who);
    const second = await approved(f, h, who);
    const frozenMember = await payee(f, h);
    await seedRiskState(f, frozenMember, 'frozen');
    const blocked = await approved(f, h, frozenMember);
    const notApproved = await pending(f, h, who);
    const unknown = randomUUID();
    await seedW(f, { fen: PLENTY });

    const batchId = await expectExecuted(
      await h.execute([first.id, second.id, blocked.id, notApproved.id, unknown]),
      {
        paying: [first.id, second.id],
        left: [
          [blocked.id, 'member_blocked'],
          [notApproved.id, 'not_approved'],
          [unknown, 'not_approved'],
        ],
      },
    );

    const records = await audits(f, ACTION);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.admin_id).toBe(h.executor.id);
    expect(record.at).toEqual(f.clock.now());
    const facts = auditFacts(record);
    expect(facts.fields.get('outcome')).toBe('executed');
    expect(facts.fields.get('batch_id')).toBe(batchId);
    for (const id of [first.id, second.id, blocked.id, notApproved.id, unknown]) {
      expect(facts.text).toContain(id);
    }
    expect(facts.numbers.has(2), `paying 的数量 ${facts.text}`).toBe(true);
    expect(facts.numbers.has(3), `left 的数量 ${facts.text}`).toBe(true);
    expect(facts.text).toContain('member_blocked');
    for (const row of [first, second, notApproved]) {
      expectNoSecrets(facts.text, secretsOf(row, ACCOUNT.alipay, who));
    }
    expectNoSecrets(facts.text, secretsOf(blocked, ACCOUNT.alipay, frozenMember));
  });
});

it('[AC-B2-09l#49] rejected（①）也要有审计：恰一条，操作人是调用者，含 outcome 与 reason，没有水位原因时不必有 channel；不含个人信息', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    await setSwitch(f, 'payout.enabled', false);

    await expectRejected(await h.execute([w.id]), 'payout_disabled');

    const records = await audits(f, ACTION);
    expect(records).toHaveLength(1);
    expect(records[0]!.admin_id).toBe(h.executor.id);
    const facts = auditFacts(records[0]!);
    expect(facts.fields.get('outcome')).toBe('rejected');
    expect(facts.fields.get('reason')).toBe('payout_disabled');
    expectNoSecrets(facts.text, secretsOf(w, ACCOUNT.alipay, who));
  });
});

it('[AC-B2-09l#50] rejected（水位）也要有审计：恰一条，含 outcome、reason 与 channel；不含个人信息', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);

    await expectRejected(await h.execute([w.id]), 'watermark_stale', 'alipay');

    const records = await audits(f, ACTION);
    expect(records).toHaveLength(1);
    expect(records[0]!.admin_id).toBe(h.executor.id);
    const facts = auditFacts(records[0]!);
    expect(facts.fields.get('outcome')).toBe('rejected');
    expect(facts.fields.get('reason')).toBe('watermark_stale');
    expect(facts.fields.get('channel')).toBe('alipay');
    expectNoSecrets(facts.text, secretsOf(w, ACCOUNT.alipay, who));
  });
});

it('[AC-B2-09l#51] 被拒的请求（10403、10003、重复 id、不合格请求体）不写 payout_batch_execute 审计', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    const sent = [
      await h.execute([w.id], { caller: h.viewer }),
      await h.execute([w.id], { stepUp: null }),
      await h.execute([w.id, w.id]),
      await h.executeBody({ withdrawal_ids: [] }),
    ];

    expect(sent.map((item) => item.statusCode)).toEqual([403, 403, 400, 400]);
    expect(await audits(f, ACTION)).toEqual([]);
  });
});
