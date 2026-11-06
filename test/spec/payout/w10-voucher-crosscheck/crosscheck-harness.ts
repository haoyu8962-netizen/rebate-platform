// B2-09x / BR-WDR-15, BR-TEXT-14 / D10-703 / SPEC_REF 18f0015.
// Existing HTTP entry is the test seam: no business mocks and no production-code edits.
import { expect } from 'vitest';
import type { ChannelBillLine } from '../../../../apps/api/src/modules/payout/domain/channel-result.ts';
import {
  ACCOUNT,
  AFTER_FREEZE,
  answer,
  balanceOf,
  entries,
  expectNoSecrets,
  paidBody,
  payee,
  platformLine,
  refused,
  rowOf,
  secretsOf,
  seedAttempt,
  state,
  textOf,
  unknownWithdrawal,
  userLine,
  voucherOf,
  type ReviewFixture,
  type UnknownAdmin,
  type WithdrawalRow,
} from '../admin-unknown-payouts/unknown-harness.ts';
import {
  BILL_DATE,
  LINE_SUCCESS,
  lineOf,
  reconRows,
  type ReconFixture,
} from '../recon-channel/kit.ts';
import { expectQueued, jobs, stored } from '../recon-late-paid/late-paid-harness.ts';

export * from '../admin-unknown-payouts/unknown-harness.ts';
export { withLoggedUnknownAdmin } from '../unknown-list-row/logged-admin-harness.ts';
export { suite } from '../recon-late-paid/late-paid-harness.ts';
export { LINE_SUCCESS, LINE_FAIL, LINE_UNKNOWN } from '../recon-channel/kit.ts';
export type { ReconFixture } from '../recon-channel/kit.ts';

export async function candidate(a: ReviewFixture, h: UnknownAdmin) {
  const who = await payee(a, h);
  // Exactly one transfer, seeded by unknownWithdrawal. Do not add another transfer attempt.
  const w = await unknownWithdrawal(a, h, who, { automatic: false });
  const body = paidBody(a, w);
  return { who, w, body };
}
export type Candidate = Awaited<ReturnType<typeof candidate>>;

export function query(
  a: ReviewFixture,
  c: Candidate,
  order: string,
  options: { result?: 'success' | 'fail' | 'unknown'; at?: Date; paidAt?: string } = {},
) {
  return seedAttempt(a, c.w, {
    kind: 'query',
    result: options.result ?? 'success',
    at: options.at ?? a.clock.now(),
    response: {
      status: LINE_SUCCESS,
      channel_order_id: order,
      ...(options.paidAt === undefined ? {} : { paid_at: options.paidAt }),
    },
  });
}

export function billLine(w: WithdrawalRow, order: string, patch: Partial<ChannelBillLine> = {}) {
  return lineOf(
    { outBizNo: w.out_biz_no, net: w.net_fen },
    {
      channelOrderId: order,
      ...patch,
    },
  );
}

/** Only the real daily reconciliation writes recon_channel; prove the stored evidence exists. */
export async function bills(f: ReconFixture, lines: readonly ChannelBillLine[]) {
  // R2 only persists non-success lines when comparing a PAID_* snapshot. Build that historical
  // read fixture, run the real writer, then restore today's PAYING fixture before invoking W10.
  // This is seed construction, not a production transition; recon_channel is never hand-written.
  const nonSuccessKeys = lines
    .filter((line) => line.status !== LINE_SUCCESS && line.outBizNo !== null)
    .map((line) => line.outBizNo!);
  const restore =
    nonSuccessKeys.length === 0
      ? []
      : await f.h.db
          .withSchema('app')
          .selectFrom('withdrawals')
          .select(['id', 'status', 'paid_at'])
          .where('app_id', '=', f.appId)
          .where('out_biz_no', 'in', nonSuccessKeys)
          .execute();
  for (const row of restore) {
    await f.h.payout
      .withSchema('app')
      .updateTable('withdrawals')
      .set({ status: 'PAID_API', paid_at: f.clock.now() })
      .where('app_id', '=', f.appId)
      .where('id', '=', row.id)
      .execute();
  }
  f.setBill(BILL_DATE, lines);
  try {
    await f.runDay();
  } finally {
    for (const row of restore) {
      await f.h.payout
        .withSchema('app')
        .updateTable('withdrawals')
        .set({ status: row.status, paid_at: row.paid_at })
        .where('app_id', '=', f.appId)
        .where('id', '=', row.id)
        .execute();
    }
  }
  const rows = await reconRows(f);
  for (const line of lines) {
    expect(rows).toContainEqual(
      expect.objectContaining({
        app_id: f.appId,
        out_biz_no: line.outBizNo,
        channel_order_id: line.channelOrderId,
        channel_status: line.status,
        channel_amount_fen: line.amountFen,
      }),
    );
  }
}

export async function snapshot(f: ReconFixture, a: ReviewFixture) {
  return { state: await state(a), jobs: await jobs(f), stored: await stored(f) };
}

function privateValues(c: Candidate) {
  return [...secretsOf(c.w, ACCOUNT.alipay, c.who), c.body.proof_text];
}

/** A separate, committed read after HTTP returned proves refusal audit survived rollback. */
export async function refusal(
  f: ReconFixture,
  a: ReviewFixture,
  h: UnknownAdmin,
  c: Candidate,
  reason: 'resolve_order_id_other_order' | 'resolve_order_id_mismatch' | 'resolve_amount_mismatch',
  lines: readonly string[],
  key?: string,
) {
  const before = await snapshot(f, a);
  await refused(
    await h.resolve(c.w.id, c.body, key === undefined ? {} : { key }),
    reason,
    reason === 'resolve_amount_mismatch' ? 'resolution' : 'channel_order_id',
  );
  const after = await snapshot(f, a);
  expect({ ...after, state: { ...after.state, audits: [] } }).toEqual({
    ...before,
    state: { ...before.state, audits: [] },
  });
  const appended = after.state.audits.filter(
    (r) => !before.state.audits.some((b) => b.id === r.id),
  );
  expect(appended).toHaveLength(1);
  expect(appended[0]).toMatchObject({
    app_id: a.appId,
    admin_id: h.executor.id,
    target: c.w.id,
    action: 'withdrawal_resolve_refused',
    after: { withdrawal_id: c.w.id, reason },
  });
  expect(
    after.state.audits.filter((r) => r.target === c.w.id && r.action === 'withdrawal_resolve'),
  ).toEqual([]);
  const facts = appended[0]!.after as Record<string, unknown>;
  // Refusal may carry operational metadata, but no extra payment data in either snapshot.
  const auditText = textOf(appended);
  for (const field of [
    'response',
    'paid_at',
    'out_biz_no',
    'amount_fen',
    'net_fen',
    'fee_fen',
    'tax_fen',
    'proof_text',
    'proof_file',
    'payee_account',
    'payee_name',
    'phone',
  ])
    expect(auditText).not.toContain(`"${field}"`);
  if (Object.hasOwn(facts, 'channel_order_id'))
    expect(facts['channel_order_id']).toBe(c.body.channel_order_id);
  const listed = await answer(await h.audit(c.w.id), 0);
  expect(listed.data).toMatchObject({
    total: 1,
    items: [
      expect.objectContaining({
        action: 'withdrawal_resolve_refused',
        target_type: 'withdrawal',
        target_id: c.w.id,
        permission: 'payout.execute',
      }),
    ],
  });
  expectNoSecrets(textOf([appended, listed.data, lines]), privateValues(c));
}

/** Successful W10 keeps its voucher, proof, balance and late-paid job behavior. */
export async function success(
  f: ReconFixture,
  a: ReviewFixture,
  h: UnknownAdmin,
  c: Candidate,
  options: { key?: string; differs?: boolean } = {},
) {
  await answer(
    await h.resolve(c.w.id, c.body, options.key === undefined ? {} : { key: options.key }),
    0,
  );
  expect(await rowOf(a, c.w)).toMatchObject({
    status: 'PAID_API',
    manual_resolution: 'paid',
    resolver_ids: [h.executor.id],
    channel_order_id: c.body.channel_order_id,
    paid_at: new Date(c.body.paid_at),
    proof_file: c.body.proof_text,
    out_biz_no: c.w.out_biz_no,
  });
  const key = `wd:${c.w.id}:PAID`;
  expect(await voucherOf(a.db, a.appId, key)).toEqual([
    { uniq_key: key, biz_type: 'withdrawal', biz_id: c.w.id, operator: `admin:${h.executor.id}` },
  ]);
  expect(await entries(a.db, a.appId, key)).toEqual([
    userLine(88n, 'TAX_WITHHOLD'),
    platformLine('TAX_PAYABLE', -88n, 'TAX_WITHHOLD'),
    userLine(125n, 'WITHDRAW_FEE'),
    platformLine('FEE_INCOME', -125n, 'WITHDRAW_FEE'),
    userLine(12_347n, 'WITHDRAW_PAID'),
    platformLine('CASH_ALIPAY', -12_347n, 'WITHDRAW_PAID'),
  ]);
  expect(await balanceOf(a.db, a.ledger, a.appId, c.who.userId)).toEqual({
    available_fen: AFTER_FREEZE,
    frozen_fen: 0n,
  });
  await expectQueued(f, c.w.id);
  const rows = (await state(a)).audits.filter(
    (r) => r.target === c.w.id && r.action === 'withdrawal_resolve',
  );
  expect(rows).toHaveLength(1);
  const after = rows[0]!.after as Record<string, unknown>;
  if (options.differs === true) expect(after['paid_at_differs_from_query']).toBe(true);
  else expect(Object.hasOwn(after, 'paid_at_differs_from_query')).toBe(false);
  expectNoSecrets(textOf(rows), privateValues(c));
}

export function warnings(lines: readonly string[]) {
  return lines
    .flatMap((line) => line.trim().split('\n'))
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['level'] === 40);
}
