// B2-12c large amounts (claude-independent; spec-test r1 S1 on posting.int.test.ts #5): BR-FUND-24 ④
// (金额不设单笔上限), ⑥ (红冲按原单整笔), BR-FUND-16 (分录 amount_fen 为 bigint、整数分、借贷和为 0) and
// the contract (amount_fen integer int64 ≥ 1, no upper limit; available_before_fen / _after_fen Fen
// int64). Every sample is above 2^31 (2_147_483_648) and above the largest sample of the other files
// (10_000), below 2^53 so that a JSON number carries it exactly. The response, the form, the voucher
// entries (against specs/ledger-templates.csv), the balance and the audit record are compared to the
// exact integer.
// Amounts by hand: start 1000;
//   +4_294_967_297 (2^32 + 1)      → 4_294_968_297
//   −6_442_450_951                 → −2_147_482_654
//   reversing the −6_442_450_951   → 4_294_968_297
//   reversing the +4_294_967_297   → 1000
import { expect, it } from 'vitest';
import {
  CREATE_ACTION,
  REVERSE_ACTION,
  audits,
  expectAdjusted,
  expectMentions,
  fixture,
  member,
  moneyOf,
  newForm,
  seedReconDiff,
  suite,
  withAdjustAdmin,
  type AdminSent,
  type AuditRow,
  type Ref,
} from './kit.ts';

const s = suite();

const UP = 4_294_967_297n;
const DOWN = 6_442_450_951n;

/** The response text carries the integers exactly (a JSON number, never a string or a rounded float). */
function carries(sent: AdminSent, amount: bigint, before: bigint, after: bigint): void {
  for (const [field, value] of [
    ['amount_fen', amount],
    ['available_before_fen', before],
    ['available_after_fen', after],
  ] as const) {
    expect(sent.body, `${field} ${value.toString()}`).toMatch(
      new RegExp(`"${field}"\\s*:\\s*${value.toString()}[,}\\s]`),
    );
  }
}

/** The one audit record of `action` that names `adjustId`. */
function auditOf(rows: readonly AuditRow[], action: string, adjustId: string): AuditRow {
  const found = rows.filter(
    (row) =>
      row.action === action &&
      JSON.stringify([row.target, row.before, row.after]).includes(adjustId),
  );
  expect(found, `${action} of ${adjustId}`).toHaveLength(1);
  return found[0]!;
}

it('[AC-B2-12c#40] 超过 2^31 的整数分：调增 4294967297、调减 6442450951（余额 −2147482654）、两张各整笔红冲，一步生效；应答、单、凭证分录、余额与审计都按精确整数，借贷和为 0，余额回到 1000', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 1000n });
    const diff: Ref = { ref_type: 'recon_diff', ref_id: (await seedReconDiff(f)).id };

    const upNote = '大额漏记补回';
    const upSent = await h.create(
      newForm({
        userId,
        direction: 'increase',
        amount: UP,
        reason: 'RECON_FIX',
        refs: [diff],
        note: upNote,
        contra: 'COMMISSION_REVENUE',
      }),
    );
    const up = await expectAdjusted(f, upSent, {
      caller: h.maker,
      userId,
      direction: 'increase',
      amount: UP,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
      refs: [diff],
      note: upNote,
      before: { available: 1000n, frozen: 0n },
    });
    expect(up.after).toBe(4_294_968_297n);
    carries(upSent, UP, 1000n, 4_294_968_297n);

    const downNote = '大额多记冲减';
    const downSent = await h.create(
      newForm({
        userId,
        direction: 'decrease',
        amount: DOWN,
        reason: 'OTHER',
        refs: [diff],
        note: downNote,
        contra: 'UNION_RECEIVABLE',
        platform: 'jd',
      }),
    );
    const down = await expectAdjusted(f, downSent, {
      caller: h.maker,
      userId,
      direction: 'decrease',
      amount: DOWN,
      reason: 'OTHER',
      contra: 'UNION_RECEIVABLE',
      platform: 'jd',
      refs: [diff],
      note: downNote,
      before: { available: 4_294_968_297n, frozen: 0n },
    });
    expect(down.after).toBe(-2_147_482_654n);
    carries(downSent, DOWN, 4_294_968_297n, -2_147_482_654n);

    const backDownSent = await h.create({
      reverses_adjust_id: down.row.adjust_id,
      note: '大额冲减有误，整笔冲回',
    });
    const backDown = await expectAdjusted(f, backDownSent, {
      caller: h.maker,
      userId,
      direction: 'increase',
      amount: DOWN,
      reason: 'OTHER',
      contra: 'UNION_RECEIVABLE',
      platform: 'jd',
      refs: [],
      note: '大额冲减有误，整笔冲回',
      reverses: down.row,
      before: { available: -2_147_482_654n, frozen: 0n },
    });
    expect(backDown.after).toBe(4_294_968_297n);
    carries(backDownSent, DOWN, -2_147_482_654n, 4_294_968_297n);

    const backUpSent = await h.create({
      reverses_adjust_id: up.row.adjust_id,
      note: '大额补回有误，整笔冲回',
    });
    const backUp = await expectAdjusted(f, backUpSent, {
      caller: h.maker,
      userId,
      direction: 'decrease',
      amount: UP,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
      refs: [],
      note: '大额补回有误，整笔冲回',
      reverses: up.row,
      before: { available: 4_294_968_297n, frozen: 0n },
    });
    expect(backUp.after).toBe(1000n);
    carries(backUpSent, UP, 4_294_968_297n, 1000n);

    expect(await moneyOf(f, userId)).toEqual({ available: 1000n, frozen: 0n });
    const rows = await audits(f);
    expect(rows.filter((row) => row.action === CREATE_ACTION)).toHaveLength(2);
    expect(rows.filter((row) => row.action === REVERSE_ACTION)).toHaveLength(2);
    expectMentions(auditOf(rows, CREATE_ACTION, up.row.adjust_id), {
      ids: [up.row.adjust_id, userId],
      values: ['increase', UP, 'RECON_FIX', 1000n, 4_294_968_297n],
    });
    expectMentions(auditOf(rows, CREATE_ACTION, down.row.adjust_id), {
      ids: [down.row.adjust_id, userId],
      values: ['decrease', DOWN, 'OTHER', 4_294_968_297n, -2_147_482_654n],
    });
    expectMentions(auditOf(rows, REVERSE_ACTION, backDown.row.adjust_id), {
      ids: [backDown.row.adjust_id, down.row.adjust_id, userId],
      values: ['increase', DOWN, 'OTHER', -2_147_482_654n, 4_294_968_297n],
    });
    expectMentions(auditOf(rows, REVERSE_ACTION, backUp.row.adjust_id), {
      ids: [backUp.row.adjust_id, up.row.adjust_id, userId],
      values: ['decrease', UP, 'RECON_FIX', 4_294_968_297n, 1000n],
    });
  });
});
