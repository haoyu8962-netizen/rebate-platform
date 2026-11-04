// B2-09m idempotency rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid — `Idempotency-Key` required: same key and body → the first result, whatever
// X-Step-Up-Token carries; same key with another body → 20901; same key while still running → 40901; the
// step-up token is not part of the body hash, so a replay after a 10003 keeps its key. A new key for the
// same content finds the item recorded: not_approved. A running request is held on the member's users row
// from outside. Requests go through the real admin entry (manual-paid-harness.ts). Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ACTION,
  AFTER_FREEZE,
  answer,
  approved,
  audits,
  balanceOf,
  changes,
  entryOf,
  expectItems,
  expectNothingWritten,
  fixture,
  lockUsersRow,
  newKey,
  paid,
  payee,
  reviewing,
  rowOf,
  skipped,
  state,
  stepUpRequired,
  suite,
  track,
  voucherOf,
  waiting,
  withManualAdmin,
} from './manual-paid-harness.ts';

const s = suite();

it('[AC-B2-09m#57] 同键同体：重放原样返回第一次的逐项结果（不是变成 not_approved，每次 step-up 令牌不同也一样），不多凭证、审计、事件，钱只动一次', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    const notYet = await reviewing(f, h, who);
    const items = [entryOf(f, w), entryOf(f, notYet)];
    const key = newKey();
    const sent = await h.manualPaid(items, { key });
    await expectItems(sent, [paid(w.id), skipped(notYet.id, 'not_approved')]);
    const after = await state(f);

    for (let i = 0; i < 2; i += 1) {
      const again = await h.manualPaid(items, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }

    expect(await state(f)).toEqual(after);
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
    expect(await audits(f, ACTION)).toHaveLength(1);
    expect(await changes(f.db, f.appId)).toHaveLength(1);
  });
});

it('[AC-B2-09m#58] 同键异体 → 20901（流水号、实付时间、实付金额或项数不同）；什么都不新增', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    const other = await approved(f, h, who);
    const entry = entryOf(f, w);
    const key = newKey();
    await expectItems(await h.manualPaid([entry], { key }), [paid(w.id)]);
    const after = await state(f);

    await answer(await h.manualPaid([{ ...entry, channel_order_id: 'another' }], { key }), 20901);
    await answer(await h.manualPaid([{ ...entry, paid_fen: entry.paid_fen + 1 }], { key }), 20901);
    await answer(await h.manualPaid([entry, entryOf(f, other)], { key }), 20901);

    expect(await state(f)).toEqual(after);
    expect(await rowOf(f, other)).toEqual(other);
  });
});

it('[AC-B2-09m#59] 进行中（确定性）：同一 key 的第一次在 users 行锁上等待时再发（同体或异体）→ 40901，单不动；放行后第一次照常完成，之后重放得到它的应答，一张凭证一条审计', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    const entry = entryOf(f, w);
    const key = newKey();
    const lock = await lockUsersRow(f.db, f.appId, who.userId);
    const first = track(h.manualPaid([entry], { key }));
    try {
      expect(await waiting(f, 1, [first]), '第一次补录应在 users 行锁上等待').toBe(true);
      await answer(await h.manualPaid([entry], { key }), 40901);
      await answer(await h.manualPaid([{ ...entry, paid_fen: 1 }], { key }), 40901);
      expect(await rowOf(f, w)).toEqual(w);
    } finally {
      await lock.release();
      await Promise.allSettled([first.promise]);
    }
    const sent = await first.promise;
    await expectItems(sent, [paid(w.id)]);
    expect((await h.manualPaid([entry], { key })).body).toBe(sent.body);
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
    expect(await audits(f, ACTION)).toHaveLength(1);
  });
});

it('[AC-B2-09m#60] Idempotency-Key 必填：不带或格式不对 → 20001，什么都不写、不留幂等记录', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    const entry = entryOf(f, w);
    const before = await state(f);

    for (const key of [null, 'short', 'bad key with spaces']) {
      await answer(await h.manualPaid([entry], { key }), 20001);
    }

    expect(await state(f)).toEqual(before);
    expect(before.idempotency).toEqual([]);
  });
});

it('[AC-B2-09m#61] 令牌不进请求体哈希：10003 之后带令牌用同一 Idempotency-Key 能执行', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    const entry = entryOf(f, w);
    const key = newKey();

    await stepUpRequired(await h.manualPaid([entry], { key, stepUp: null }));
    expect(await rowOf(f, w)).toEqual(w);

    await expectItems(await h.manualPaid([entry], { key }), [paid(w.id)]);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: 0n,
    });
  });
});

it('[AC-B2-09m#62] 异键重放同内容：已补录的得 not_approved（先于流水号占用），不多凭证、审计、事件、tax_ytd', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    const entry = entryOf(f, w);
    await expectItems(await h.manualPaid([entry]), [paid(w.id)]);
    const after = await state(f);

    await expectItems(await h.manualPaid([entry]), [skipped(w.id, 'not_approved')]);

    expectNothingWritten(after, await state(f));
  });
});
