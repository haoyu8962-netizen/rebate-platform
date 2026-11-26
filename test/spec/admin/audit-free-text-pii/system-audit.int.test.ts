// B2-02ze (claude-independent, SPEC_REF d49d8aa5): 08 BR-ID-33 on the free text of a system audit
// record: admin's createSystemAuditWriter().appendAction (apps/api/src/modules/admin/infra/
// system-audit.ts) on the caller's transaction, as payout's system rejection uses it. Task brief
// §9.1 #2, #3, #4 and §7 (D10-2354, 「订单号不是敏感信息，不打码」): value patterns only on free-text
// fields (reason, note, also nested); structured fields (order_id, withdrawal_id, recon_diff_id,
// idempotency_key — here digits only, 16 long and passing Luhn —, *_fen as numbers or integer
// strings, 13+ digits, negative) stay as they are; inside free text only Luhn-passing 13–19 digit
// runs (also after `card:`) and identity numbers are masked, while order numbers and references
// failing Luhn, prefixed / lettered numbers, a 12-digit number and a uuid stay. Real pieces: the
// writer and PostgreSQL through ../../payment/orders/kit.ts (couli_app, a fresh database per file).
// Every id is fixed (no random digits that could meet a card's). Top-level it() only.
import { expect, it } from 'vitest';
import {
  createSystemAuditWriter,
  type SystemActionAudit,
} from '../../../../apps/api/src/modules/admin/infra/system-audit.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { suite } from '../../payment/orders/kit.ts';
import { ORDER16, expectRedacted, sampleB, sampleC } from './kit.ts';

const s = suite();

const ACTION = 'b2_02ze_free_text_probe';
/** contracts audit_system_actor: payout's system rejection is the writer's real caller. */
const ACTOR: SystemActionAudit['actor'] = 'system:payout';
const APP_ID = 'b2ze_free_text_probe';
const WITHDRAWAL_ID = 'feedface-cafe-4bad-beef-decafbadf00d';
const RECON_DIFF_ID = 'deadbeef-face-4ace-acdc-0badc0ffee11';
/**
 * An idempotency key of digits only (16 long; the contract allows it), Luhn total 70 (passes):
 * structured, so kept even though the same digits in free text would be masked as a card.
 */
const IDEMPOTENCY_KEY = '2026112109876549';

it('[AC-B2-02ze#7] 系统审计 appendAction 的自由文本（before.reason、嵌套的 after.detail.note）里的邮箱（本地部分与域名都不原样留下）、身份证（18 位末位 X、18 位校验位正确、15 位日期合法，只留首末各 1 位）、过 Luhn 的卡号（19 位、连字符分组、card: 前缀、13 位，只露末 4）、手机号都不以明文落库，说明文字保留；自由文本里不过 Luhn 的 16 位订单号、13 位参考号、19 位长号，校验位错的 18 位号、日期不合法的 15 位号，12 位数字、uuid、taobao:1234567、W20261121ABC、taobao: 与 W…ABC 带不过 Luhn 的 16 位数字段，都原样；结构化的订单号（16 位）、提现单号、差错单号、纯数字幂等键（16 位，过 Luhn）、13 位以上金额（数字与整数字符串、含负数）与 target 原样', async () => {
  const db = s.db();
  const clock = new FixedClock('2026-11-21T02:00:00.000Z');
  const reason = sampleC('庚');
  const note = sampleB('辛');

  const writer = createSystemAuditWriter({ clock });
  await db.transaction().execute((trx) =>
    writer.appendAction(trx, {
      appId: APP_ID,
      actor: ACTOR,
      action: ACTION,
      target: `withdrawals:${WITHDRAWAL_ID}`,
      before: {
        reason: reason.text,
        order_id: ORDER16,
        amount_fen: -1_234_567_890_123,
      },
      after: {
        withdrawal_id: WITHDRAWAL_ID,
        recon_diff_id: RECON_DIFF_ID,
        idempotency_key: IDEMPOTENCY_KEY,
        refund_fen: '98765432109876',
        adjust_fen: '-12345678901234',
        amount_fen: 1_234_567_890_123,
        detail: { note: note.text },
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
  expect(row.system_actor).toBe(ACTOR);
  expect(row.admin_id).toBeNull();

  expectRedacted(row, reason);
  expectRedacted(row, note);

  // Structured fields: no value pattern applies.
  expect(row.target).toBe(`withdrawals:${WITHDRAWAL_ID}`);
  expect(row.before).toMatchObject({ order_id: ORDER16, amount_fen: -1_234_567_890_123 });
  expect(row.after).toMatchObject({
    withdrawal_id: WITHDRAWAL_ID,
    recon_diff_id: RECON_DIFF_ID,
    idempotency_key: IDEMPOTENCY_KEY,
    refund_fen: '98765432109876',
    adjust_fen: '-12345678901234',
    amount_fen: 1_234_567_890_123,
  });
});
