// B2-09m audit rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid — one record per paid item, action withdrawal_manual_paid, by the caller, with the
// `withdrawal_id`, the status before and after, `channel_order_id`, `paid_at` and `paid_fen`; no personal
// data; a skipped item and a refused request write none. Where the writer puts them inside before / after
// is not pinned. Requests go through the real admin entry (manual-paid-harness.ts). Top-level it() only
// (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ACCOUNT,
  ACTION,
  NET,
  approved,
  auditFacts,
  audits,
  entryOf,
  expectItems,
  expectNoSecrets,
  fixture,
  paid,
  payee,
  secretsOf,
  skipped,
  suite,
  withManualAdmin,
} from './manual-paid-harness.ts';

const s = suite();

it('[AC-B2-09m#63] 每个 paid 项恰一条 withdrawal_manual_paid，操作人是调用者、时间是注入时钟；含 withdrawal_id、前后状态、channel_order_id、paid_at、paid_fen；不含收款账号、姓名、手机号', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    const entry = entryOf(f, w);

    await expectItems(await h.manualPaid([entry]), [paid(w.id)]);

    const records = await audits(f, ACTION);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.admin_id).toBe(h.entry.id);
    expect(record.at).toEqual(f.clock.now());
    const facts = auditFacts(record);
    for (const piece of [w.id, 'APPROVED', 'PAID_MANUAL', entry.channel_order_id]) {
      expect(facts.text).toContain(piece);
    }
    expect(Date.parse(String(facts.fields.get('paid_at')))).toBe(Date.parse(entry.paid_at));
    expect(Number(facts.fields.get('paid_fen'))).toBe(12_347);
    expectNoSecrets(facts.text, secretsOf(w, ACCOUNT.alipay, who));
  });
});

it('[AC-B2-09m#64] 同一请求两项 paid、两项跳过：恰两条审计，各自只说自己那一单，跳过的单一条都没有', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const first = await approved(f, h, who);
    const second = await approved(f, h, who);
    const wrong = await approved(f, h, who);
    const unknown = randomUUID();

    await expectItems(
      await h.manualPaid([
        entryOf(f, first),
        entryOf(f, wrong, { paid_fen: 1 }),
        entryOf(f, { id: unknown, net_fen: NET }),
        entryOf(f, second),
      ]),
      [
        paid(first.id),
        skipped(wrong.id, 'amount_mismatch'),
        skipped(unknown, 'not_found'),
        paid(second.id),
      ],
    );

    const texts = (await audits(f, ACTION)).map((record) => auditFacts(record).text);
    expect(texts).toHaveLength(2);
    expect(texts.filter((text) => text.includes(first.id))).toHaveLength(1);
    expect(texts.filter((text) => text.includes(second.id))).toHaveLength(1);
    expect(texts.filter((text) => text.includes(first.id) && text.includes(second.id))).toEqual([]);
    expect(texts.filter((text) => text.includes(wrong.id) || text.includes(unknown))).toEqual([]);
  });
});

it('[AC-B2-09m#65] 被拒的请求（10403、10003、重复 id、不合格请求体）不写 withdrawal_manual_paid 审计', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    const entry = entryOf(f, w);
    const sent = [
      await h.manualPaid([entry], { caller: h.viewer }),
      await h.manualPaid([entry], { stepUp: null }),
      await h.manualPaid([entry, entry]),
      await h.manualPaidBody({ items: [] }),
    ];

    expect(sent.map((item) => item.statusCode)).toEqual([403, 403, 400, 400]);
    expect(await audits(f, ACTION)).toEqual([]);
  });
});
