// B2-04zr refusal rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreateUnionReceipt and adminReverseUnionReceipt — order of checks fund.cash_entry (10403
// data.reason=admin_permission_denied; a super admin holds every point) → step-up totp (10003
// data.tier=totp) → body (20001 data.fields: the schema; a blank note; a receipt_date later than the
// current accounting day of the injected Clock, +08:00; CASH_BANK while
// payout.channel_enabled.bank_card is off). An earlier receipt_date has no lower bound; CASH_ALIPAY
// does not look at that switch. Every refusal changes nothing. The order is pinned with bodies the
// route schema accepts: Fastify runs the route schema before any handler. Each switch state gets its
// own entry, so a cached configuration read cannot decide a case. Requests go through the real admin
// entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  BANK_SWITCH,
  CASH_ENTRY,
  REASON,
  answer,
  chars,
  denied,
  entryBody,
  everything,
  fieldsError,
  fixture,
  idOf,
  newKey,
  receiptOf,
  receiptRow,
  receiptVouchers,
  seedReceipt,
  setSwitch,
  stepUpRequired,
  suite,
  voucherOf,
  withReceiptAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-04zr#7] 权限：只持 fund.view、没有权限点、只有别的权限点 → 录入与红冲都 10403 data.reason=admin_permission_denied，先于二次验证与请求体（空白 note、将来日期、未开通的 CASH_BANK、空白 reason、未知记录）；不带令牌 → 10001；什么都不变', async () => {
  const f = fixture(s);
  const row = await seedReceipt(f);
  await withReceiptAdmin(f, async (h) => {
    const before = await everything(f);
    const outsiders = [
      h.viewer,
      await h.caller([]),
      await h.caller(['fund.recon', 'payout.execute']),
    ];
    for (const caller of outsiders) {
      await denied(await h.create(entryBody(), { caller }));
      for (const body of [
        entryBody({ note: '   ' }),
        entryBody({ receipt_date: '2026-10-30' }),
        entryBody({ cash_account: 'CASH_BANK' }),
      ]) {
        await denied(await h.create(body, { caller, stepUp: null }));
      }
      await denied(await h.reverse(row.receipt_id, { reason: REASON }, { caller }));
      await denied(await h.reverse(row.receipt_id, { reason: '   ' }, { caller, stepUp: null }));
      await denied(await h.reverse(randomUUID(), { reason: REASON }, { caller, stepUp: null }));
    }
    await answer(await h.create(entryBody(), { caller: null }), 10001);
    await answer(await h.reverse(row.receipt_id, { reason: REASON }, { caller: null }), 10001);
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-04zr#8] 二次验证（动态码档）：不带 X-Step-Up-Token、令牌是别的账号的、令牌是短信档的 → 录入 10003 data.tier=totp，先于请求体；什么都不变；令牌不进请求体哈希，拿到令牌后用同一 Idempotency-Key 重放即成功且只有一条记录', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    const before = await everything(f);
    const key = newKey();
    const colleague = await h.caller([CASH_ENTRY]);
    await stepUpRequired(await h.create(entryBody(), { key, stepUp: null }));
    await stepUpRequired(await h.create(entryBody(), { key, stepUp: await h.stepUp(colleague) }));
    await stepUpRequired(
      await h.create(entryBody(), { key, stepUp: await h.stepUp(h.operator, 'sms') }),
    );
    for (const body of [
      entryBody({ note: '   ' }),
      entryBody({ receipt_date: '2026-10-30' }),
      entryBody({ cash_account: 'CASH_BANK' }),
    ]) {
      await stepUpRequired(await h.create(body, { stepUp: null }));
    }
    expect(await everything(f)).toEqual(before);

    const id = idOf(await receiptOf(await h.create(entryBody(), { key })));
    expect((await receiptRow(f, id)).created_by).toBe(h.operator.id);
    expect((await everything(f)).receipts).toHaveLength(1);
  });
});

it('[AC-B2-04zr#9] 二次验证（动态码档）：红冲同样 10003 data.tier=totp，先于 reason 与 receipt_id 的检查；什么都不变；拿到令牌后同一 Idempotency-Key 重放即成功', async () => {
  const f = fixture(s);
  const row = await seedReceipt(f);
  await withReceiptAdmin(f, async (h) => {
    const before = await everything(f);
    const key = newKey();
    const colleague = await h.caller([CASH_ENTRY]);
    const body = { reason: REASON };
    await stepUpRequired(await h.reverse(row.receipt_id, body, { key, stepUp: null }));
    await stepUpRequired(
      await h.reverse(row.receipt_id, body, { key, stepUp: await h.stepUp(colleague) }),
    );
    await stepUpRequired(
      await h.reverse(row.receipt_id, body, { key, stepUp: await h.stepUp(h.operator, 'sms') }),
    );
    await stepUpRequired(await h.reverse(row.receipt_id, { reason: '   ' }, { stepUp: null }));
    await stepUpRequired(await h.reverse(randomUUID(), body, { stepUp: null }));
    expect(await everything(f)).toEqual(before);

    await receiptOf(await h.reverse(row.receipt_id, body, { key }));
    expect((await receiptRow(f, row.receipt_id)).reversed_by).toBe(h.operator.id);
  });
});

it('[AC-B2-04zr#10] 超管没有权限点行也能录入与红冲，created_by / reversed_by 是超管；超管同样要动态码档（无令牌 10003）', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    const root = await h.caller([], { superAdmin: true });
    await stepUpRequired(await h.create(entryBody(), { caller: root, stepUp: null }));
    const id = idOf(await receiptOf(await h.create(entryBody(), { caller: root })));
    expect((await receiptRow(f, id)).created_by).toBe(root.id);

    await stepUpRequired(await h.reverse(id, { reason: REASON }, { caller: root, stepUp: null }));
    await receiptOf(await h.reverse(id, { reason: REASON }, { caller: root }));
    expect((await receiptRow(f, id)).reversed_by).toBe(root.id);
  });
});

it('[AC-B2-04zr#11] 请求体 schema：缺字段、platform 与 cash_account 不在枚举、amount_fen 不是大于 0 的安全整数、receipt_date 不是日期、note 为空串或超过 500 字、多带键（method、created_by）→ 20001 data.fields 恰为该字段；什么都不变', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    const before = await everything(f);
    const without = (name: string) =>
      Object.fromEntries(Object.entries(entryBody()).filter(([key]) => key !== name));
    const cases: readonly (readonly [unknown, string])[] = [
      [without('platform'), 'platform'],
      [without('receipt_date'), 'receipt_date'],
      [without('amount_fen'), 'amount_fen'],
      [without('cash_account'), 'cash_account'],
      [entryBody({ platform: 'nope' }), 'platform'],
      [entryBody({ cash_account: 'CASH' }), 'cash_account'],
      [entryBody({ amount_fen: 0 }), 'amount_fen'],
      [entryBody({ amount_fen: -1 }), 'amount_fen'],
      [entryBody({ amount_fen: 1.5 }), 'amount_fen'],
      [entryBody({ amount_fen: '100' }), 'amount_fen'],
      [entryBody({ amount_fen: 9_007_199_254_740_992 }), 'amount_fen'],
      [entryBody({ receipt_date: '2026-02-30' }), 'receipt_date'],
      [entryBody({ receipt_date: 'yesterday' }), 'receipt_date'],
      [entryBody({ note: '' }), 'note'],
      [entryBody({ note: chars(501) }), 'note'],
      [entryBody({ method: 'R1_RECON' }), 'method'],
      [entryBody({ created_by: h.operator.id }), 'created_by'],
    ];
    for (const [body, field] of cases) {
      await fieldsError(await h.create(body), [field]);
    }
    expect(await everything(f)).toEqual(before);
  });
});

it('[AC-B2-04zr#12] note 去空白后为空 → 20001 data.fields=[note]；恰好 500 字可以；receipt_date 没有下限（2001-01-01 可以），当天可以，次日 → 20001 data.fields=[receipt_date]，且都按请求内容入记录', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    const before = await everything(f);
    for (const note of ['   ', ' \t\n ']) {
      await fieldsError(await h.create(entryBody({ note })), ['note']);
    }
    await fieldsError(await h.create(entryBody({ receipt_date: '2026-10-30' })), ['receipt_date']);
    expect(await everything(f)).toEqual(before);

    const longest = idOf(await receiptOf(await h.create(entryBody({ note: chars(500) }))));
    expect((await receiptRow(f, longest)).note).toBe(chars(500));
    const oldest = idOf(await receiptOf(await h.create(entryBody({ receipt_date: '2001-01-01' }))));
    expect((await receiptRow(f, oldest)).day).toBe('2001-01-01');
    const today = idOf(await receiptOf(await h.create(entryBody({ receipt_date: '2026-10-29' }))));
    expect((await receiptRow(f, today)).day).toBe('2026-10-29');
  });
});

it('[AC-B2-04zr#13] receipt_date 按注入时钟 +08:00 的当前会计日判断：11-03 23:59 时 11-03 可以、11-04 不可以；11-04 00:00（UTC 仍是 11-03）时 11-04 可以、11-05 不可以；凭证会计日同样按 +08:00', async () => {
  const f = fixture(s, { instant: '2026-11-03T15:59:00.000Z' });
  await withReceiptAdmin(f, async (h) => {
    await fieldsError(await h.create(entryBody({ receipt_date: '2026-11-04' })), ['receipt_date']);
    const last = idOf(await receiptOf(await h.create(entryBody({ receipt_date: '2026-11-03' }))));
    expect((await voucherOf(f, `RECEIPT:taobao:${last}`)).day).toBe('2026-11-03');

    f.clock.set('2026-11-03T16:00:00.000Z');
    const first = idOf(await receiptOf(await h.create(entryBody({ receipt_date: '2026-11-04' }))));
    expect((await receiptRow(f, first)).day).toBe('2026-11-04');
    expect((await voucherOf(f, `RECEIPT:taobao:${first}`)).day).toBe('2026-11-04');
    await fieldsError(await h.create(entryBody({ receipt_date: '2026-11-05' })), ['receipt_date']);
    expect(await receiptVouchers(f)).toHaveLength(2);
  });
});

it('[AC-B2-04zr#14] 开关 payout.channel_enabled.bank_card：没有配置行（缺省关）或显式关时 CASH_BANK → 20001 data.fields=[cash_account]、什么都不变，CASH_ALIPAY 不看这个开关照常录入；开时 CASH_BANK 通过', async () => {
  for (const value of [undefined, false]) {
    const off = fixture(s);
    if (value !== undefined) await setSwitch(off, BANK_SWITCH, value);
    await withReceiptAdmin(off, async (h) => {
      const before = await everything(off);
      await fieldsError(await h.create(entryBody({ cash_account: 'CASH_BANK' })), ['cash_account']);
      expect(await everything(off)).toEqual(before);
      const id = idOf(await receiptOf(await h.create(entryBody())));
      expect((await receiptRow(off, id)).cash_account).toBe('CASH_ALIPAY');
    });
  }
  const on = fixture(s);
  await setSwitch(on, BANK_SWITCH, true);
  await withReceiptAdmin(on, async (h) => {
    const bank = idOf(await receiptOf(await h.create(entryBody({ cash_account: 'CASH_BANK' }))));
    expect((await receiptRow(on, bank)).cash_account).toBe('CASH_BANK');
    const alipay = idOf(await receiptOf(await h.create(entryBody())));
    expect((await receiptRow(on, alipay)).cash_account).toBe('CASH_ALIPAY');
  });
});
