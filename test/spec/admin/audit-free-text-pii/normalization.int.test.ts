// B2-02zg (claude-independent, SPEC_REF 1025764b; takes over B2-02ze): 08 BR-ID-33 on the free text
// of a system audit record, normalised first and then masked (编排 D10-3266): admin's
// createSystemAuditWriter().appendAction (apps/api/src/modules/admin/infra/system-audit.ts) on the
// caller's transaction, as payout's system rejection uses it. The free text (sampleD in ./kit.ts)
// carries a full-width mobile number, a card grouped by U+2212, a number grouped by NBSP / U+202F /
// ideographic space, an identity number with a space before its X, a mobile number followed by
// 「-备注」, compatibility characters NFKC expands (㎡, ①), a full-width order number, a full-width
// e-mail with ＠ and a number grouped by "/" (kept). Structured fields — the same order number in
// ASCII, an out_refund_no with a 16-digit run, a digits-only idempotency key, a 13-digit amount, the
// withdrawal id and target — stay as they are. Real pieces: the writer and PostgreSQL through
// ../../payment/orders/kit.ts (couli_app, a fresh database per file). Every id is fixed. Top-level
// it() only.
import { expect, it } from 'vitest';
import {
  createSystemAuditWriter,
  type SystemActionAudit,
} from '../../../../apps/api/src/modules/admin/infra/system-audit.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { suite } from '../../payment/orders/kit.ts';
import { ORDER16, expectRedacted, sampleD } from './kit.ts';

const s = suite();

const ACTION = 'b2_02zg_free_text_probe';
/** contracts audit_system_actor: payout's system rejection is the writer's real caller. */
const ACTOR: SystemActionAudit['actor'] = 'system:payout';
const APP_ID = 'b2zg_free_text_probe';
const WITHDRAWAL_ID = 'feedface-cafe-4bad-beef-decafbadf00d';
/** Digits only, 16 long: structured, kept although the same digits in free text would be masked. */
const IDEMPOTENCY_KEY = '2026112109876549';
/** A refund number with a 16-digit run: structured, kept. */
const OUT_REFUND_NO = 'RF2026112187654322';

it('[AC-B2-02zg#12] 系统审计 appendAction 的自由文本先归一再打码：全角数字手机号 3+4、U+2212 分组的卡号与 NBSP / U+202F / 全角空格分组的长数字只留末四位、末位 X 前带空格的证件首 1 末 1、紧跟「-备注」的手机号 3+4、全角订单号只留末四位、全角 ＠ 邮箱 @ 前整段遮成 ***@example.com，都不以明文落库；兼容字符（㎡、①）与「/」分组的数字原样，说明文字保留；结构化的订单号、退款单号、纯数字幂等键、13 位金额、提现单号与 target 原样', async () => {
  const db = s.db();
  const clock = new FixedClock('2026-11-26T02:00:00.000Z');
  const reason = sampleD('壬');

  const writer = createSystemAuditWriter({ clock });
  await db.transaction().execute((trx) =>
    writer.appendAction(trx, {
      appId: APP_ID,
      actor: ACTOR,
      action: ACTION,
      target: `withdrawals:${WITHDRAWAL_ID}`,
      before: { reason: reason.text, order_id: ORDER16 },
      after: {
        withdrawal_id: WITHDRAWAL_ID,
        idempotency_key: IDEMPOTENCY_KEY,
        out_refund_no: OUT_REFUND_NO,
        amount_fen: 1_234_567_890_123,
      },
    }),
  );

  const rows = await db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', APP_ID)
    .where('action', '=', ACTION)
    .execute();
  expect(rows).toHaveLength(1);
  const row = rows[0]!;

  expectRedacted(row, reason);

  // Structured fields: no value pattern applies.
  expect(row.target).toBe(`withdrawals:${WITHDRAWAL_ID}`);
  expect(row.before).toMatchObject({ order_id: ORDER16 });
  expect(row.after).toMatchObject({
    withdrawal_id: WITHDRAWAL_ID,
    idempotency_key: IDEMPOTENCY_KEY,
    out_refund_no: OUT_REFUND_NO,
    amount_fen: 1_234_567_890_123,
  });
});
