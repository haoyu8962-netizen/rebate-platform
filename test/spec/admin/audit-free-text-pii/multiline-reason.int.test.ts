// B2-02zg (claude-independent, SPEC_REF 1025764b; 写测 2 after rule-test review r1 S1-①): 08 BR-ID-33 on
// a free-text reason typed over several lines, normalised first and then masked (编排 D10-3266: line
// breaks are white space, so a separator): admin's createSystemAuditWriter().appendAction
// (apps/api/src/modules/admin/infra/system-audit.ts) on the caller's transaction, as payout's system
// rejection uses it. The reason carries a Luhn card wrapped by CR LF between its groups, a non-Luhn
// number grouped by U+2028 / LF / CR, a mobile number and an identity number split over lines, an
// identity number with a wrong check character whose lower-case x is on the next line (the fallback,
// S1-③), an e-mail address inside full-width brackets (S1-②) and an order number split over two
// lines. The same reason lands in before.reason and after.detail.note. Real pieces: the writer and
// PostgreSQL through ../../payment/orders/kit.ts (couli_app, a fresh database per file). Every id is
// fixed. Top-level it() only.
import { expect, it } from 'vitest';
import {
  createSystemAuditWriter,
  type SystemActionAudit,
} from '../../../../apps/api/src/modules/admin/infra/system-audit.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { suite } from '../../payment/orders/kit.ts';
import {
  CARD_SPACED_DIGITS,
  CARD_SPACED_NOT_LUHN_DIGITS,
  CLOSING,
  EMAIL,
  EMAIL_MASK,
  ID_X,
  OPENING,
  ORDER16,
  PHONE,
  expectRedacted,
  type Sample,
} from './kit.ts';

const s = suite();

const ACTION = 'b2_02zg_multiline_probe';
/** contracts audit_system_actor: payout's system rejection is the writer's real caller. */
const ACTOR: SystemActionAudit['actor'] = 'system:payout';
const APP_ID = 'b2zg_multiline_probe';
const WITHDRAWAL_ID = 'feedface-cafe-4bad-beef-decafbadf00d';
/** 17 digits + x, check character wrong (the right one would be 8): the fallback, 003x shows. */
const ID_WRONG_DIGITS = '11010519491231003';

const OPENING_TAG = `${OPENING}癸`;

/**
 * One reason over five lines (LF, CR LF, CR and U+2028 all used). The digits it keeps after the
 * redaction — 7364, 2196, 138 5678, 1 (X), 003 (x), 5678 — share no run of 8 with any number below.
 */
const MULTILINE: Sample = {
  text:
    `${OPENING_TAG}：多行原因，第一行说明\n` +
    `卡号 6222 0371\r\n9584 7364，对照号 6228\u{2028}4810\n3357\r2196，\n` +
    `手机 138\n1234\n5678，证件 110105\r\n19491231\n002X，备查 ${ID_WRONG_DIGITS}\nx，\n` +
    `邮箱（${EMAIL}）已核；订单 20261121\n12345678，${CLOSING}`,
  opening: OPENING_TAG,
  plain: [
    CARD_SPACED_DIGITS,
    CARD_SPACED_NOT_LUHN_DIGITS,
    '0371',
    '9584',
    '4810',
    '3357',
    PHONE,
    '1234',
    ID_X,
    ID_X.slice(0, 17),
    ID_WRONG_DIGITS,
    EMAIL,
    'alice.w',
    ORDER16,
    '12345678',
  ],
  freePlain: [],
  cards: [
    CARD_SPACED_DIGITS,
    CARD_SPACED_NOT_LUHN_DIGITS,
    ID_X.slice(0, 17),
    ID_WRONG_DIGITS,
    ORDER16,
  ],
  idTails: [ID_X.slice(-4)],
  kept: [OPENING_TAG, '多行原因，第一行说明\n卡号', `邮箱（${EMAIL_MASK}）已核；订单`, CLOSING],
  shapes: [],
  // Squeezed: NFKC (，→ , （→ ( ）→ ) ；→ ;), then white space — line breaks included — and dashes out.
  squeezedShapes: [
    /,第一行说明卡号\*+7364,对照号/u,
    /,对照号\*+2196,手机/u,
    /,手机138\*{4}5678,证件/u,
    /,证件1\*{16}X,备查/u,
    /,备查\*+003x,邮箱/u,
    /,邮箱\(al\*{3}@example\.com\)已核;订单\*+5678,已当面核实/u,
  ],
};

it('[AC-B2-02zg#18] 多行原因落库：换行（LF、CR LF、CR、U+2028）当分隔——跨行的过 Luhn 卡号只留末 4、跨行的不过 Luhn 长号与订单号只留末四位、跨行的手机号 3+4、跨行的证件首 1 末 1、校验位错且小写 x 在下一行的证件号只留 003x、全角括号里的邮箱 al***@example.com 且括号原样，before.reason 与 after.detail.note 都不以明文落库；说明文字与换行外的行文保留，提现单号与 target 原样', async () => {
  const db = s.db();
  const clock = new FixedClock('2026-11-26T02:00:00.000Z');

  const writer = createSystemAuditWriter({ clock });
  await db.transaction().execute((trx) =>
    writer.appendAction(trx, {
      appId: APP_ID,
      actor: ACTOR,
      action: ACTION,
      target: `withdrawals:${WITHDRAWAL_ID}`,
      before: { reason: MULTILINE.text },
      after: { withdrawal_id: WITHDRAWAL_ID, detail: { note: MULTILINE.text } },
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

  const free = expectRedacted(row, MULTILINE);
  // Both copies of the reason are there, masked.
  expect(free.map((leaf) => leaf.path).sort()).toEqual(['after.detail.note', 'before.reason']);

  // Structured fields: no value pattern applies.
  expect(row.target).toBe(`withdrawals:${WITHDRAWAL_ID}`);
  expect(row.after).toMatchObject({ withdrawal_id: WITHDRAWAL_ID });
});
