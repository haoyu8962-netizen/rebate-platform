// B2-09w / BR-WDR-15 / D10-702 ①. Real admin HTTP + PG + Redis; synthetic data only.
// Every case includes the new missing-T list behavior, so unchanged resolve/isolation guards
// cannot make a case pass on the old implementation. Run only in the orchestrator's container.
import { expect, it } from 'vitest';
import {
  ACCOUNT,
  DAY,
  PROOF,
  answer,
  attemptsOf,
  expectNoSecrets,
  fixture,
  lowAndHigh,
  otherApp,
  paidBody,
  payee,
  rowOf,
  secretsOf,
  seedAttempt,
  state,
  suite,
  unknownWithdrawal,
  withUnknownAdmin,
} from '../admin-unknown-payouts/unknown-harness.ts';
import { withLoggedUnknownAdmin } from './logged-admin-harness.ts';
import { pageOf, warnings, withoutTransfer } from './row-harness.ts';

const s = suite();

it('[AC-B2-09w#1] 两张正常单加一张无transfer单仍200且三行齐全，正常行全部字段保持原样，无查询的异常行字段完整并通过契约', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const who = await payee(f, h);
    const newer = await unknownWithdrawal(f, h, who, { age: DAY, automatic: false });
    const older = await unknownWithdrawal(f, h, who, { age: 3 * DAY, automatic: false });
    await seedAttempt(f, newer, {
      kind: 'query',
      result: 'unknown',
      at: f.clock.now(),
      respCode: 'SYNTHETIC_NORMAL',
    });
    const baseline = await pageOf(await h.list());
    expect(baseline.items.map((item) => item.withdrawal_id)).toEqual([older.id, newer.id]);
    const missing = await withoutTransfer(f, h, who);
    const before = await state(f);
    const page = await pageOf(await h.list());
    expect(page).toMatchObject({ page: 1, page_size: 20, total: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.items.slice(0, 2)).toEqual(baseline.items);
    expect(page.items[2]).toEqual({
      withdrawal_id: missing.id,
      out_biz_no: missing.out_biz_no,
      user: { user_id: who.userId, phone_masked: baseline.items[0]!.user.phone_masked },
      payout_channel: 'alipay',
      amount_fen: 12_560,
      net_fen: 12_347,
      first_transfer_at: null,
      latest_query: null,
      fail_blockers: [
        'resolve_too_early',
        'resolve_bill_unverifiable',
        'resolve_query_unverifiable',
      ],
    });
    expect(await state(f)).toEqual(before);
  });
});

it('[AC-B2-09w#2] 只有query没有transfer时T仍为null且仍too_early，最新query的所有公开字段照常返回，旧查询和cancel不能充当T', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const who = await payee(f, h);
    const missing = await withoutTransfer(f, h, who);
    await seedAttempt(f, missing, {
      kind: 'cancel',
      result: 'unknown',
      at: new Date(f.clock.now().getTime() - 3 * DAY),
    });
    await seedAttempt(f, missing, {
      kind: 'query',
      result: 'fail',
      at: new Date(f.clock.now().getTime() - 2 * DAY),
      response: { channel_order_id: 'SYNTHETIC_OLD_QUERY' },
    });
    const paidAt = new Date(f.clock.now().getTime() - 60_000).toISOString();
    await seedAttempt(f, missing, {
      kind: 'query',
      result: 'success',
      at: f.clock.now(),
      respCode: 'SYNTHETIC_QUERY_OK',
      respSubCode: 'SYNTHETIC_DETAIL',
      response: {
        status: 'SYNTHETIC_SUCCESS',
        channel_order_id: 'SYNTHETIC_QUERY_ORDER',
        paid_at: paidAt,
        payee_account: ACCOUNT.alipay,
        payee_name: missing.payee_name,
      },
    });
    const before = await state(f);
    const response = await h.list();
    const page = await pageOf(response);
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      withdrawal_id: missing.id,
      out_biz_no: missing.out_biz_no,
      user: { user_id: who.userId },
      payout_channel: 'alipay',
      amount_fen: 12_560,
      net_fen: 12_347,
      first_transfer_at: null,
    });
    expect(page.items[0]!.latest_query).toEqual({
      result: 'success',
      at: f.clock.now().toISOString(),
      resp_code: 'SYNTHETIC_QUERY_OK',
      resp_sub_code: 'SYNTHETIC_DETAIL',
      channel_status: 'SYNTHETIC_SUCCESS',
      channel_order_id: 'SYNTHETIC_QUERY_ORDER',
      paid_at: paidAt,
    });
    expect(page.items[0]!.fail_blockers).toEqual([
      'resolve_too_early',
      'resolve_bill_unverifiable',
      'resolve_query_unverifiable',
    ]);
    expectNoSecrets(response.body, secretsOf(missing, ACCOUNT.alipay, who));
    expect(await state(f)).toEqual(before);
  });
});

it('[AC-B2-09w#3] T从早到晚在前，两个null按withdrawal_id升序在后，分页边界不丢行也不重复', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const who = await payee(f, h);
    const { low, high } = lowAndHigh();
    // Insert null/high first and give it the oldest created_at; neither controls ordering.
    const nullHigh = await withoutTransfer(f, h, who, {
      id: high,
      created_at: new Date(f.clock.now().getTime() - 10 * DAY),
    });
    const newer = await unknownWithdrawal(f, h, who, { age: DAY, automatic: false });
    const nullLow = await withoutTransfer(f, h, who, { id: low });
    const older = await unknownWithdrawal(f, h, who, { age: 3 * DAY, automatic: false });
    const full = await pageOf(await h.list());
    expect(full.total).toBe(4);
    expect(full.items.map((item) => item.withdrawal_id)).toEqual([
      older.id,
      newer.id,
      nullLow.id,
      nullHigh.id,
    ]);
    expect(full.items.map((item) => item.first_transfer_at)).toEqual([
      new Date(f.clock.now().getTime() - 3 * DAY).toISOString(),
      new Date(f.clock.now().getTime() - DAY).toISOString(),
      null,
      null,
    ]);
    const first = await pageOf(await h.list('?page=1&page_size=3'));
    const second = await pageOf(await h.list('?page=2&page_size=3'));
    const empty = await pageOf(await h.list('?page=3&page_size=3'));
    expect(first).toEqual({ page: 1, page_size: 3, total: 4, items: full.items.slice(0, 3) });
    expect(second).toEqual({ page: 2, page_size: 3, total: 4, items: full.items.slice(3) });
    expect(empty).toEqual({ page: 3, page_size: 3, total: 4, items: [] });
  });
});

it('[AC-B2-09w#4] 每次列表对无transfer单恰一条warn且字段点名单号，正常单不告警，日志不含手机号收款账号姓名', async () => {
  const f = fixture(s);
  const lines: string[] = [];
  await withLoggedUnknownAdmin(f, lines, async (h) => {
    const who = await payee(f, h);
    const normal = await unknownWithdrawal(f, h, who, { automatic: false });
    lines.length = 0;
    await pageOf(await h.list());
    expect(warnings(lines)).toEqual([]);
    const missing = await withoutTransfer(f, h, who);
    for (const request of [1, 2]) {
      lines.length = 0;
      const response = await h.list();
      const records = warnings(lines);
      expect(records, `list request ${request}`).toHaveLength(1);
      expect(records[0]).toMatchObject({ withdrawal_id: missing.id });
      expect(JSON.stringify(records)).not.toContain(normal.id);
      expectNoSecrets(lines.join(''), secretsOf(missing, ACCOUNT.alipay, who));
      const page = await pageOf(response);
      expect(page.items.map((item) => item.withdrawal_id)).toEqual([normal.id, missing.id]);
    }
  });
});

it('[AC-B2-09w#5] 无transfer单仍可列出但判成功和判失败都20902，含成功query也不能代替transfer，状态分录余额审计完全不变', async () => {
  const f = fixture(s);
  await withUnknownAdmin(f, async (h) => {
    const missing = await withoutTransfer(f, h, await payee(f, h));
    for (const hasQuery of [false, true]) {
      if (hasQuery) {
        await seedAttempt(f, missing, {
          kind: 'query',
          result: 'success',
          at: f.clock.now(),
          response: { channel_order_id: 'SYNTHETIC_QUERY_SUCCESS' },
        });
      }
      for (const body of [paidBody(f, missing), { resolution: 'failed', proof_text: PROOF }]) {
        const before = await state(f);
        await answer(await h.resolve(missing.id, body), 20902, { resource: 'withdrawal' });
        expect(await rowOf(f, missing)).toEqual(missing);
        expect(await state(f)).toEqual(before);
        expect(
          (await attemptsOf(f, missing)).filter((attempt) => attempt.kind === 'transfer'),
        ).toEqual([]);
      }
    }
    const page = await pageOf(await h.list());
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ withdrawal_id: missing.id, first_transfer_at: null });
  });
});

it('[AC-B2-09w#6] 外app无transfer单既不计入本app列表也不触发本app告警，与本app异常单并存仍严格隔离', async () => {
  const f = fixture(s);
  const lines: string[] = [];
  await withLoggedUnknownAdmin(f, lines, async (h) => {
    const normal = await unknownWithdrawal(f, h, await payee(f, h), { automatic: false });
    const g = otherApp(f);
    const foreignWho = await payee(g, h);
    const foreign = await withoutTransfer(g, h, foreignWho);
    lines.length = 0;
    const baseline = await pageOf(await h.list());
    expect(baseline.total).toBe(1);
    expect(baseline.items.map((item) => item.withdrawal_id)).toEqual([normal.id]);
    expect(warnings(lines)).toEqual([]);
    expect(lines.join('')).not.toContain(foreign.id);
    const local = await withoutTransfer(f, h, await payee(f, h));
    const foreignBefore = await state(g);
    lines.length = 0;
    const response = await h.list();
    const page = await pageOf(response);
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.withdrawal_id)).toEqual([normal.id, local.id]);
    expect(page.items[0]).toEqual(baseline.items[0]);
    expect(warnings(lines)).toHaveLength(1);
    expect(warnings(lines)[0]).toMatchObject({ withdrawal_id: local.id });
    for (const text of [response.body, lines.join('')]) {
      expect(text).not.toContain(foreign.id);
      expect(text).not.toContain(foreign.out_biz_no);
      expectNoSecrets(text, secretsOf(foreign, ACCOUNT.alipay, foreignWho));
    }
    expect(await state(g)).toEqual(foreignBefore);
  });
});
