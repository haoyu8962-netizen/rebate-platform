// B2-02ze rule-test kit (claude-independent, SPEC_REF d49d8aa5): FU-AUDIT-REASON-FREE-TEXT-PII —
// 08 BR-ID-33 「接口、H5、列表、日志…不得出现明文」 applied to the free text an operator types into
// an audited operation (reason, note) and that lands in audit_logs.before / after through admin's
// shared redaction (apps/api/src/modules/admin/infra/audit-redaction.ts, used by audit-writer.ts and
// system-audit.ts). Value patterns apply to free-text fields only; structured fields (*_fen, ids,
// idempotency keys) stay byte for byte (task brief §9.1, 编排裁定 D10-2315 (a)).
//
// What free text masks (task brief §7, 负责人 2026-11-21 「订单号不是敏感信息，不打码」, D10-2354; the
// earlier 「宁可多脱敏」 reading is void): only what is recognisably personal.
// - Card / payee account: a run of 13–19 digits (grouping spaces or hyphens taken out first) that
//   passes the Luhn check; only its last four digits stay. A long number failing Luhn stays as written.
// - Identity number: 18 characters with a correct check character, or 15 digits whose 7th–12th digits
//   are a valid date; masked first 1 + last 1 (1****************X, BR-ID-33). Otherwise as written.
// - Mobile (11 digits, 1[3-9]…, 3 + 4: 138****5678) and e-mail: as before.
// - A prefix or separator does not decide: `card:` + a Luhn number is masked; a number glued to
//   letters or to a prefix is judged by its digit run alone.
// Known cost, accepted (not asserted): about one order number in ten passes Luhn or an identity
// check by chance and is masked; a card mistyped by one digit fails Luhn and is not masked.
//
// Every number below was checked by hand; the Luhn total (digit sum after doubling every second
// digit from the right) or the identity check is written next to it. No card shares a run of 8
// digits with any other number written into the same record (fixed ids, no random ones), so the
// digits-only check cannot be tripped by the numbers kept on purpose. All samples are synthetic
// (documentation-style numbers, example.* domains).
import { expect } from 'vitest';

/** The opening of every free text sample; the tag after it tells the records apart. */
export const OPENING = '核对说明';
/** The non-personal closing of every sample: must survive the redaction (not wiped whole). */
export const CLOSING = '已当面核实，按流程处理';

export const PHONE = '13812345678';
export const PHONE_MASK = '138****5678';
export const PHONE_B = '13900001111';
export const PHONE_B_MASK = '139****1111';
/**
 * 18 characters ending in X: weighted sum 167, 167 mod 11 = 2 → check X (correct). Its 17-digit run
 * fails Luhn (total 41), so it cannot be taken for a card.
 */
export const ID_X = '11010519491231002X';
export const ID_X_MASK = `1${'*'.repeat(16)}X`;
/** 18 digits: weighted sum 190, mod 11 = 3 → check 9 (correct); Luhn total 58 (fails). */
export const ID_DIGITS = '110105199003071239';
export const ID_DIGITS_MASK = `1${'*'.repeat(16)}9`;
/**
 * 18 digits with a wrong check digit: weighted sum 310, mod 11 = 2 → the check would be X, it is 3;
 * Luhn total 74 (fails). Neither identity nor card: stays as written.
 */
export const ID_WRONG_CHECK = '320106198508164523';
/** 15 digits, 7th–12th 491231 (1949-12-31, valid date); Luhn total 31 (fails). Masked. */
export const ID_OLD = '110105491231002';
/** The 15-digit number masked as an identity number: its first digit, stars, its last digit. */
export const ID_OLD_MASKED = /旧证件 1\*+2，/;
/** 15 digits, 7th–12th 871345 (month 13, no date); Luhn total 53 (fails). Stays as written. */
export const ID_OLD_BAD_DATE = '440301871345123';
export const EMAIL = 'alice.w@example.com';
export const EMAIL_DOMAIN = 'example.com';
/** An address with a plus tag and a sub-domain. */
export const EMAIL_PLUS = 'bob.lee+refund@mail.corp.example.cn';
export const EMAIL_PLUS_DOMAIN = 'mail.corp.example.cn';
export const EMAIL_C = 'carol.z@example.org';
export const EMAIL_C_DOMAIN = 'example.org';

/** 16-digit card grouped by spaces, Luhn total 60 (passes); its digits; its last four. */
export const CARD_SPACED = '6222 0371 9584 7364';
export const CARD_SPACED_DIGITS = '6222037195847364';
export const CARD_SPACED_TAIL = '7364';
/** Same length and grouping, Luhn total 72 (fails): stays as written. */
export const CARD_SPACED_NOT_LUHN = '6228 4810 3357 2196';
/** 16-digit card grouped by hyphens, Luhn total 70 (passes); its digits; its last four. */
export const CARD_HYPHEN = '6222-0298-7715-8467';
export const CARD_HYPHEN_DIGITS = '6222029877158467';
export const CARD_HYPHEN_TAIL = '8467';
/** 19-digit card, ungrouped, Luhn total 70 (passes); its last four. */
export const CARD_PLAIN = '6217003816629349051';
export const CARD_PLAIN_TAIL = '9051';
/** Same length, ungrouped, Luhn total 97 (fails): stays as written. */
export const CARD_PLAIN_NOT_LUHN = '6013829475610384726';
/** 16 digits written right after `card:`, Luhn total 70 (passes): masked all the same. */
export const CARD_PREFIXED = '6259651208437736';
export const CARD_PREFIXED_TAIL = '7736';
/** 13 digits (the lower bound), Luhn total 50 (passes): masked. */
export const CARD13 = '5903182647057';
export const CARD13_TAIL = '7057';

/** A 16-digit order number, Luhn total 56 (fails): stays as written in free text. */
export const ORDER16 = '2026112112345678';
/** A 13-digit payment reference, Luhn total 57 (fails): stays as written. */
export const REF13 = '8427359012345';
/** Short prefixed and lettered numbers: stay. */
export const TAOBAO_REF = 'taobao:1234567';
export const PREFIXED_NO = 'W20261121ABC';
/** Prefixed and lettered with a 16-digit run 2026112187654322, Luhn total 61 (fails): stay. */
export const TAOBAO_LONG = 'taobao:2026112187654322';
export const PREFIXED_LONG = 'W2026112187654322ABC';
/** 12 digits, Luhn total 50 (passes) but below 13: stays as written. */
export const SHORT_NO = '123456789017';
/** A fixed uuid whose groups all carry letters (no digit-only group a card pattern could take). */
export const FREE_UUID = 'c0ffee00-b2b2-4d2e-9a2e-5f1a2b3c4d5e';

/** One free text sample: the text to submit and what the stored record must (not) show. */
export interface Sample {
  readonly text: string;
  /** OPENING + tag: finds the free-text leaf in the record. */
  readonly opening: string;
  /** Plain values that must appear nowhere in target, before or after. */
  readonly plain: readonly string[];
  /** Card digits: in no leaf a run of 8 or more of them once its non-digits are taken out. */
  readonly cards: readonly string[];
  /** Last four characters of identity numbers: in no free-text leaf (first 1 + last 1 only). */
  readonly idTails: readonly string[];
  /** Parts every free-text leaf still contains after the redaction. */
  readonly kept: readonly string[];
  /** Shapes every free-text leaf still matches after the redaction. */
  readonly shapes: readonly RegExp[];
}

/** Something (the masked address) still stands between the label and the next comma. */
function emailStandsIn(label: string): RegExp {
  return new RegExp(`${label} \\s*[^，\\s][^，]*，`);
}

/**
 * Between the label and the next comma the only digits left are the card's last four (只露末 4);
 * how the rest is drawn (stars, 尾号, grouping) is the implementation's.
 */
function cardTailOnly(label: string, tail: string): RegExp {
  return new RegExp(`${label}[^，\\d]*${tail}[^，\\d]*，`);
}

/**
 * E-mail, 18-character identity number ending in X, 16-digit Luhn card grouped by spaces and, next
 * to it, a 16-digit non-Luhn number grouped the same way (kept), mobile.
 */
export function sampleA(tag: string): Sample {
  const opening = `${OPENING}${tag}`;
  return {
    text:
      `${opening}：用户邮箱 ${EMAIL}，身份证 ${ID_X}，银行卡 ${CARD_SPACED}，` +
      `对照号 ${CARD_SPACED_NOT_LUHN}，手机 ${PHONE}，${CLOSING}`,
    opening,
    plain: [EMAIL, 'alice.w', EMAIL_DOMAIN, ID_X, CARD_SPACED, CARD_SPACED_DIGITS, PHONE],
    cards: [CARD_SPACED_DIGITS],
    idTails: [ID_X.slice(-4)],
    kept: [
      opening,
      '用户邮箱',
      '身份证',
      CLOSING,
      PHONE_MASK,
      ID_X_MASK,
      `对照号 ${CARD_SPACED_NOT_LUHN}，`,
    ],
    shapes: [emailStandsIn('用户邮箱'), cardTailOnly('银行卡 ', CARD_SPACED_TAIL)],
  };
}

/**
 * E-mail with a plus tag and a sub-domain; 18-digit identity number with a correct check digit
 * (masked) and one with a wrong check digit (kept); 15-digit identity number with a valid date
 * (masked) and one without (kept); 16-digit Luhn card grouped by hyphens; mobile.
 */
export function sampleB(tag: string): Sample {
  const opening = `${OPENING}${tag}`;
  return {
    text:
      `${opening}：邮箱 ${EMAIL_PLUS}，证件 ${ID_DIGITS}，旧证件 ${ID_OLD}，卡号 ${CARD_HYPHEN}，` +
      `备查 ${ID_WRONG_CHECK}，另查 ${ID_OLD_BAD_DATE}，手机 ${PHONE_B}，${CLOSING}`,
    opening,
    plain: [
      EMAIL_PLUS,
      'bob.lee',
      '+refund',
      EMAIL_PLUS_DOMAIN,
      ID_DIGITS,
      ID_OLD,
      CARD_HYPHEN,
      CARD_HYPHEN_DIGITS,
      PHONE_B,
    ],
    cards: [CARD_HYPHEN_DIGITS],
    // Masked as identity numbers, not as cards keeping their last four.
    idTails: [ID_DIGITS.slice(-4), ID_OLD.slice(-4)],
    kept: [
      opening,
      '邮箱',
      '旧证件',
      CLOSING,
      PHONE_B_MASK,
      `证件 ${ID_DIGITS_MASK}，`,
      `备查 ${ID_WRONG_CHECK}，`,
      `另查 ${ID_OLD_BAD_DATE}，`,
    ],
    shapes: [emailStandsIn('邮箱'), ID_OLD_MASKED, cardTailOnly('卡号 ', CARD_HYPHEN_TAIL)],
  };
}

/**
 * Order-like numbers in one text: a 16-digit order number and a 13-digit reference failing Luhn,
 * short prefixed / lettered numbers, the same with a 16-digit non-Luhn run, a 12-digit number
 * passing Luhn and a uuid — all kept; a 19-digit Luhn card next to a 19-digit non-Luhn number
 * (kept), `card:` + a Luhn card and a 13-digit Luhn card (masked); e-mail, identity number, mobile.
 */
export function sampleC(tag: string): Sample {
  const opening = `${OPENING}${tag}`;
  return {
    text:
      `${opening}：订单 ${ORDER16} 与 ${TAOBAO_REF}、${PREFIXED_NO}、${TAOBAO_LONG}、` +
      `${PREFIXED_LONG}、流水 ${SHORT_NO}、收款参考号 ${REF13}、` +
      `关联单 ${FREE_UUID} 一并核对；邮箱 ${EMAIL_C}，身份证 ${ID_X}，卡号 ${CARD_PLAIN}，` +
      `比对卡 ${CARD_PLAIN_NOT_LUHN}，绑卡 card:${CARD_PREFIXED}，短卡号 ${CARD13}，` +
      `手机 ${PHONE}，${CLOSING}`,
    opening,
    plain: [EMAIL_C, 'carol.z', EMAIL_C_DOMAIN, ID_X, CARD_PLAIN, CARD_PREFIXED, CARD13, PHONE],
    cards: [CARD_PLAIN, CARD_PREFIXED, CARD13],
    idTails: [ID_X.slice(-4)],
    kept: [
      opening,
      `订单 ${ORDER16} 与 `,
      `与 ${TAOBAO_REF}、`,
      `、${PREFIXED_NO}、`,
      `、${TAOBAO_LONG}、`,
      `、${PREFIXED_LONG}、`,
      `流水 ${SHORT_NO}、`,
      `收款参考号 ${REF13}、`,
      `关联单 ${FREE_UUID} `,
      `比对卡 ${CARD_PLAIN_NOT_LUHN}，`,
      CLOSING,
      PHONE_MASK,
      ID_X_MASK,
    ],
    shapes: [
      emailStandsIn('邮箱'),
      cardTailOnly('卡号 ', CARD_PLAIN_TAIL),
      cardTailOnly('绑卡 card:', CARD_PREFIXED_TAIL),
      cardTailOnly('短卡号 ', CARD13_TAIL),
    ],
  };
}

/** What the tests read of an audit_logs row. */
export interface AuditRecord {
  readonly target: string | null;
  readonly before: unknown;
  readonly after: unknown;
}

/** One string-like leaf of target / before / after with its path. */
export interface Leaf {
  readonly path: string;
  readonly value: string;
}

function collect(value: unknown, path: string, out: Leaf[]): void {
  if (value === null || value === undefined) return;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    out.push({ path, value: String(value) });
    return;
  }
  if (Array.isArray(value)) {
    (value as unknown[]).forEach((item, index) => collect(item, `${path}.${String(index)}`, out));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      collect(item, `${path}.${key}`, out);
    }
  }
}

/** Every leaf of the record (target, before, after), with its path. */
export function leavesOf(record: AuditRecord): Leaf[] {
  const out: Leaf[] = [];
  collect(record.target, 'target', out);
  collect(record.before, 'before', out);
  collect(record.after, 'after', out);
  return out;
}

/** target, before and after serialised whole (the text the plain values are looked for in). */
export function serialized(record: AuditRecord): string {
  return JSON.stringify([record.target, record.before, record.after], (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/** Every run of 8 digits of `digits` (any longer run contains one of them). */
function runsOf8(digits: string): string[] {
  const runs: string[] = [];
  for (let i = 0; i + 8 <= digits.length; i += 1) runs.push(digits.slice(i, i + 8));
  return runs;
}

/**
 * BR-ID-33 on one audit record: none of the sample's plain values anywhere in it (of an e-mail
 * neither the local part nor the domain); in no leaf, with its non-digits taken out, a run of 8 or
 * more digits of a card (a regrouped card is still the card); the free text is still there (at
 * least one leaf with its opening) and each such leaf keeps the non-personal words, the numbers that
 * are not personal data, the mobile and identity masks, shows of each card only its last four
 * digits, still has something standing where each e-mail was, and holds no identity number's last
 * four characters. Returns those leaves.
 */
export function expectRedacted(record: AuditRecord, sample: Sample): Leaf[] {
  const whole = serialized(record);
  for (const value of sample.plain) {
    expect(whole, `审计记录里不应出现明文 ${value}`).not.toContain(value);
  }
  const leaves = leavesOf(record);
  for (const leaf of leaves) {
    const digitsOnly = leaf.value.replace(/\D/g, '');
    for (const card of sample.cards) {
      for (const run of runsOf8(card)) {
        const message = `${leaf.path} 去掉非数字后不应含卡号 ${card} 的连续 8 位 ${run}`;
        expect(digitsOnly, message).not.toContain(run);
      }
    }
  }
  const free = leaves.filter((leaf) => leaf.value.includes(sample.opening));
  expect(
    free.length,
    `自由文本（${sample.opening}…）应仍在审计记录里，只打码不整段抹掉：${whole}`,
  ).toBeGreaterThan(0);
  for (const leaf of free) {
    for (const part of sample.kept) {
      expect(leaf.value, `${leaf.path} 应原样保留 ${part}`).toContain(part);
    }
    for (const shape of sample.shapes) {
      expect(leaf.value, `${leaf.path} 应符合 ${String(shape)}`).toMatch(shape);
    }
    for (const tail of sample.idTails) {
      const message = `${leaf.path} 证件只留首末各 1 位，不应出现末四位 ${tail}`;
      expect(leaf.value, message).not.toContain(tail);
    }
  }
  return free;
}

/** The values of the record's leaves (for the structured fields kept as they are). */
export function leafValues(record: AuditRecord): string[] {
  return leavesOf(record).map((leaf) => leaf.value);
}
