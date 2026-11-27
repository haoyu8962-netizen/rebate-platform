// B2-02zg rule-test kit (claude-independent, SPEC_REF 1025764b; takes over B2-02ze):
// FU-AUDIT-REASON-FREE-TEXT-PII — 08 BR-ID-33 「接口、H5、列表、日志…不得出现明文」 applied to the free
// text an operator types into an audited operation (reason, note) and that lands in
// audit_logs.before / after through admin's shared redaction (apps/api/src/modules/admin/infra/
// audit-redaction.ts, used by audit-writer.ts and system-audit.ts). Value patterns apply to free-text
// fields only; structured fields (*_fen, ids, idempotency keys, out_refund_no, target) stay byte for
// byte.
//
// Free text is normalised first, then masked (编排 D10-3266; D10-2328 / D10-2354 / D10-2384
// 「单号 / 参考号在自由文本里保持原样」 are void):
// - Normalise: Unicode NFKC; every dash / minus (U+2212 included) and every white space (NBSP,
//   U+202F, ideographic space, tab included) is one separator. `/ . , _` are no separators.
// - Recognised types, BR-ID-33 default shapes: mobile 3 + 4 (138****5678), identity number first 1 +
//   last 1 (1****************X), card only its last four.
// - "@" in free text (写测 5, 负责人 2026-11-27 15:00, 编排 D10-3479 / D10-3481; supersedes 写测 4's
//   「@ 与认得出的域名照常显示」; the 细则 「收款账号的脱敏格式」 two-character shape stays for
//   structured payout fields only): every run of non-white-space characters that holds an "@"
//   (full-width ＠ included, judged after NFKC) becomes 「***」 whole, from the white space before it
//   or the start of the text to the white space after it or the end — the domain is not shown, and
//   Chinese, punctuation or digits glued to the address go with it (zhangsan@example.com → ***).
//   White space is every Unicode white space (line breaks included). Runs without "@" as before.
// - Anything else: separators taken out, a run of 11 or more digits (maybe a final X / x) shows only
//   its last four — order numbers, references, numbers failing Luhn, identity numbers with a wrong
//   check character or no date, long digit runs glued to letters. Fewer than 11 digits stay.
// - Masks are decided on the normalised text and mapped back character by character: what is
//   neither a digit nor a separator in the original stays as written.
// The star count of a card or of the fallback and what becomes of the separators inside a masked run
// are the implementation's; the shapes below assert only which digits show.
//
// No card or long number shares a run of 8 digits with any other number written into the same
// record (fixed ids, no random ones), so the digits-only check cannot be tripped by the numbers kept
// on purpose. Every e-mail is preceded and followed by white space, so where the e-mail-shaped text
// starts and ends is not in question. All samples are synthetic (documentation-style numbers, example.* domains).
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
 * 18 characters ending in X: weighted sum 167, 167 mod 11 = 2 → check X (correct). Recognised as
 * an identity number: first 1 + last 1.
 */
export const ID_X = '11010519491231002X';
export const ID_X_MASK = `1${'*'.repeat(16)}X`;
/** 18 digits: weighted sum 190, mod 11 = 3 → check 9 (correct). */
export const ID_DIGITS = '110105199003071239';
export const ID_DIGITS_MASK = `1${'*'.repeat(16)}9`;
/**
 * 18 digits with a wrong check digit (weighted sum 310, mod 11 = 2 → the check would be X, it is
 * 3): not recognised, so the fallback — only its last four 4523 show.
 */
export const ID_WRONG_CHECK = '320106198508164523';
/** 15 digits, 7th–12th 491231 (1949-12-31, a real date): masked as an identity number. */
export const ID_OLD = '110105491231002';
/** The 15-digit number masked as an identity number: its first digit, stars, its last digit. */
export const ID_OLD_MASKED = /旧证件 1\*+2，/;
/** 15 digits, 7th–12th 871345 (month 13, no date): the fallback, only 5123 shows. */
export const ID_OLD_BAD_DATE = '440301871345123';
export const EMAIL = 'alice.w@example.com';
/** The whole run with the "@" (white space to white space) as 「***」: no domain shown (D10-3479). */
export const EMAIL_MASK = '***';
/** An address with a plus tag and a sub-domain. */
export const EMAIL_PLUS = 'bob.lee+refund@mail.corp.example.cn';
export const EMAIL_PLUS_MASK = '***';
export const EMAIL_C = 'carol.z@example.org';
export const EMAIL_C_MASK = '***';

/** 16-digit card grouped by spaces (Luhn total 60); its digits; its last four. */
export const CARD_SPACED = '6222 0371 9584 7364';
export const CARD_SPACED_DIGITS = '6222037195847364';
export const CARD_SPACED_TAIL = '7364';
/** Same length and grouping, Luhn total 72 (fails): the fallback all the same, only 2196 shows. */
export const CARD_SPACED_NOT_LUHN = '6228 4810 3357 2196';
export const CARD_SPACED_NOT_LUHN_DIGITS = '6228481033572196';
/** 16-digit card grouped by hyphens (Luhn total 70); its digits; its last four. */
export const CARD_HYPHEN = '6222-0298-7715-8467';
export const CARD_HYPHEN_DIGITS = '6222029877158467';
export const CARD_HYPHEN_TAIL = '8467';
/** 19-digit card, ungrouped (Luhn total 70); its last four. */
export const CARD_PLAIN = '6217003816629349051';
export const CARD_PLAIN_TAIL = '9051';
/** Same length, ungrouped, Luhn total 97 (fails): the fallback, only 4726 shows. */
export const CARD_PLAIN_NOT_LUHN = '6013829475610384726';
/** 16 digits written right after `card:`; only 7736 shows. */
export const CARD_PREFIXED = '6259651208437736';
export const CARD_PREFIXED_TAIL = '7736';
/** 13 digits; only 7057 shows. */
export const CARD13 = '5903182647057';
export const CARD13_TAIL = '7057';

/** A 16-digit order number: in free text the fallback, only 5678 shows; structured, it stays. */
export const ORDER16 = '2026112112345678';
/** A 13-digit payment reference: the fallback, only 2345 shows. */
export const REF13 = '8427359012345';
/** Short prefixed and lettered numbers (7 and 8 digits, fewer than 11): stay. */
export const TAOBAO_REF = 'taobao:1234567';
export const PREFIXED_NO = 'W20261121ABC';
/** Prefixed and lettered with a 16-digit run 2026112187654322: the run shows only 4322. */
export const TAOBAO_LONG = 'taobao:2026112187654322';
export const PREFIXED_LONG = 'W2026112187654322ABC';
export const LONG_RUN = '2026112187654322';
/** 12 digits: the fallback, only 9017 shows. */
export const SHORT_NO = '123456789017';
/** A fixed uuid whose groups all carry letters: no run of 11 digits, stays as written. */
export const FREE_UUID = 'c0ffee00-b2b2-4d2e-9a2e-5f1a2b3c4d5e';

/** sampleD: a mobile number in full-width digits. */
export const PHONE_FULL = '１３８１２３４５６７８';
/** sampleD: the card CARD_SPACED_DIGITS grouped by U+2212 MINUS SIGN. */
export const CARD_MINUS = '6222\u{2212}0371\u{2212}9584\u{2212}7364';
/** sampleD: CARD_SPACED_NOT_LUHN grouped by NBSP, U+202F and the ideographic space. */
export const NOT_LUHN_WIDE_SPACED = '6228\u{a0}4810\u{202f}3357\u{3000}2196';
/** sampleD: ID_X with a space before its check character. */
export const ID_SPACE_X = '11010519491231002 X';
/** sampleD: ORDER16 in full-width digits. */
export const ORDER_FULL = '２０２６１１２１１２３４５６７８';
/** sampleD: an e-mail address in full-width letters with a full-width ＠ and ．. */
export const EMAIL_FULL = 'ｚｈａｎｇｓａｎ＠ｅｘａｍｐｌｅ．ｃｏｍ';
/** sampleD: 16 digits grouped by "/" — no separator, four runs of 4: stays as written. */
export const SLASHED = '1100/2200/3300/4400';

/** One free text sample: the text to submit and what the stored record must (not) show. */
export interface Sample {
  readonly text: string;
  /** OPENING + tag: finds the free-text leaf in the record. */
  readonly opening: string;
  /** Plain values that must appear nowhere in target, before or after. */
  readonly plain: readonly string[];
  /** Plain values that must appear in no free-text leaf (a structured field may hold them). */
  readonly freePlain: readonly string[];
  /**
   * Card and long-number digits: in no leaf a run of 8 or more of them once its non-digits are
   * taken out.
   */
  readonly cards: readonly string[];
  /** Last characters of identity numbers: in no free-text leaf (first 1 + last 1 only). */
  readonly idTails: readonly string[];
  /** Parts every free-text leaf still contains after the redaction. */
  readonly kept: readonly string[];
  /** Shapes every free-text leaf still matches after the redaction. */
  readonly shapes: readonly RegExp[];
  /** Shapes every free-text leaf matches once squeezed (see `squeezed`). */
  readonly squeezedShapes: readonly RegExp[];
}

/**
 * NFKC, then white space and dashes (U+2212 included) taken out: how kept digits and separators are
 * written is the implementation's.
 */
export function squeezed(text: string): string {
  return text.normalize('NFKC').replace(/[\s\p{Pd}\u{2212}]/gu, '');
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Between `before` and `after` the only digits left are `tail`, the last four of the number
 * written there, with at least one star standing for the rest (只留末四位); the star count and the
 * grouping are the implementation's.
 */
export function tailOnly(before: string, tail: string, after: string): RegExp {
  return new RegExp(
    `${escaped(before)}[^\\d，、；]*\\*[^\\d，、；]*${escaped(tail)}${escaped(after)}`,
    'u',
  );
}

/**
 * E-mail, 18-character identity number ending in X, 16-digit Luhn card grouped by spaces and, next
 * to it, a 16-digit non-Luhn number grouped the same way (the fallback: masked all the same),
 * mobile.
 */
export function sampleA(tag: string): Sample {
  const opening = `${OPENING}${tag}`;
  return {
    text:
      `${opening}：用户邮箱 ${EMAIL} 已核，身份证 ${ID_X}，银行卡 ${CARD_SPACED}，` +
      `对照号 ${CARD_SPACED_NOT_LUHN}，手机 ${PHONE}，${CLOSING}`,
    opening,
    plain: [
      EMAIL,
      'alice.w',
      'example.com',
      ID_X,
      CARD_SPACED,
      CARD_SPACED_DIGITS,
      CARD_SPACED_NOT_LUHN,
      CARD_SPACED_NOT_LUHN_DIGITS,
      PHONE,
    ],
    freePlain: [],
    cards: [CARD_SPACED_DIGITS, CARD_SPACED_NOT_LUHN_DIGITS],
    idTails: [ID_X.slice(-4)],
    kept: [
      opening,
      `用户邮箱 ${EMAIL_MASK} 已核，`,
      `身份证 ${ID_X_MASK}，`,
      `手机 ${PHONE_MASK}，`,
      CLOSING,
    ],
    shapes: [
      tailOnly('银行卡 ', CARD_SPACED_TAIL, '，对照号'),
      tailOnly('对照号 ', '2196', '，手机'),
    ],
    squeezedShapes: [],
  };
}

/**
 * E-mail with a plus tag and a sub-domain; 18-digit identity number with a correct check digit and
 * 15-digit one with a real date (both masked first 1 + last 1); 16-digit Luhn card grouped by
 * hyphens; an 18-digit number with a wrong check digit and a 15-digit one without a date (the
 * fallback: only their last four); mobile.
 */
export function sampleB(tag: string): Sample {
  const opening = `${OPENING}${tag}`;
  return {
    text:
      `${opening}：邮箱 ${EMAIL_PLUS} 已核，证件 ${ID_DIGITS}，旧证件 ${ID_OLD}，` +
      `卡号 ${CARD_HYPHEN}，备查 ${ID_WRONG_CHECK}，另查 ${ID_OLD_BAD_DATE}，` +
      `手机 ${PHONE_B}，${CLOSING}`,
    opening,
    plain: [
      EMAIL_PLUS,
      'bob.lee',
      '+refund',
      'mail.corp.example.cn',
      'example.cn',
      ID_DIGITS,
      ID_OLD,
      CARD_HYPHEN,
      CARD_HYPHEN_DIGITS,
      ID_WRONG_CHECK,
      ID_OLD_BAD_DATE,
      PHONE_B,
    ],
    freePlain: [],
    cards: [CARD_HYPHEN_DIGITS, ID_WRONG_CHECK, ID_OLD_BAD_DATE],
    // Masked as identity numbers, not by the fallback keeping their last four.
    idTails: [ID_DIGITS.slice(-4), ID_OLD.slice(-4)],
    kept: [
      opening,
      `邮箱 ${EMAIL_PLUS_MASK} 已核，`,
      `证件 ${ID_DIGITS_MASK}，`,
      `手机 ${PHONE_B_MASK}，`,
      CLOSING,
    ],
    shapes: [
      ID_OLD_MASKED,
      tailOnly('卡号 ', CARD_HYPHEN_TAIL, '，备查'),
      tailOnly('备查 ', '4523', '，另查'),
      tailOnly('另查 ', '5123', '，手机'),
    ],
    squeezedShapes: [],
  };
}

/**
 * Order-like numbers in one text: a 16-digit order number, a 13-digit reference, prefixed /
 * lettered numbers with a 16-digit run, a 12-digit number — all the fallback, only their last four;
 * short prefixed / lettered numbers and a uuid without a digit run of 11 — kept; a 19-digit Luhn card
 * next to a 19-digit non-Luhn number, `card:` + a card and a 13-digit card (only their last four);
 * e-mail, identity number, mobile.
 */
export function sampleC(tag: string): Sample {
  const opening = `${OPENING}${tag}`;
  return {
    text:
      `${opening}：订单 ${ORDER16} 与 ${TAOBAO_REF}、${PREFIXED_NO}、${TAOBAO_LONG}、` +
      `${PREFIXED_LONG}、流水 ${SHORT_NO}、收款参考号 ${REF13}、` +
      `关联单 ${FREE_UUID} 一并核对；邮箱 ${EMAIL_C} 已核，身份证 ${ID_X}，卡号 ${CARD_PLAIN}，` +
      `比对卡 ${CARD_PLAIN_NOT_LUHN}，绑卡 card:${CARD_PREFIXED}，短卡号 ${CARD13}，` +
      `手机 ${PHONE}，${CLOSING}`,
    opening,
    plain: [
      EMAIL_C,
      'carol.z',
      'example.org',
      ID_X,
      CARD_PLAIN,
      CARD_PLAIN_NOT_LUHN,
      CARD_PREFIXED,
      CARD13,
      REF13,
      SHORT_NO,
      LONG_RUN,
      PHONE,
    ],
    // The structured order_id next to it holds the same number.
    freePlain: [ORDER16],
    cards: [CARD_PLAIN, CARD_PLAIN_NOT_LUHN, CARD_PREFIXED, CARD13],
    idTails: [ID_X.slice(-4)],
    kept: [
      opening,
      `与 ${TAOBAO_REF}、${PREFIXED_NO}、taobao:`,
      `关联单 ${FREE_UUID} 一并核对；邮箱 ${EMAIL_C_MASK} 已核，`,
      `身份证 ${ID_X_MASK}，`,
      `手机 ${PHONE_MASK}，`,
      CLOSING,
    ],
    shapes: [
      tailOnly('订单 ', '5678', ' 与 '),
      tailOnly('、taobao:', '4322', '、W'),
      tailOnly('、W', '4322', 'ABC、流水'),
      tailOnly('流水 ', '9017', '、收款参考号'),
      tailOnly('收款参考号 ', '2345', '、关联单'),
      tailOnly('卡号 ', CARD_PLAIN_TAIL, '，比对卡'),
      tailOnly('比对卡 ', '4726', '，绑卡'),
      tailOnly('绑卡 card:', CARD_PREFIXED_TAIL, '，短卡号'),
      tailOnly('短卡号 ', CARD13_TAIL, '，手机'),
    ],
    squeezedShapes: [],
  };
}

/**
 * Normalisation (D10-3266 ①, B2-02ze money r4 S0): a full-width mobile number, a card grouped by
 * U+2212, a non-Luhn number grouped by NBSP / U+202F / ideographic space, an identity number with a
 * space before its X, a mobile number followed by 「-备注」, compatibility characters that NFKC
 * expands (㎡ → m2, ① → 1), a full-width order number, a full-width e-mail with ＠, and a number
 * grouped by "/" (no separator: kept).
 */
export function sampleD(tag: string): Sample {
  const opening = `${OPENING}${tag}`;
  return {
    text:
      `${opening}：全角手机 ${PHONE_FULL}，卡号 ${CARD_MINUS}，对照号 ${NOT_LUHN_WIDE_SPACED}，` +
      `证件 ${ID_SPACE_X}，手机 ${PHONE_B}-备注，面积 ㎡ 号①，订单 ${ORDER_FULL}，` +
      `邮箱 ${EMAIL_FULL} 已核，路径 ${SLASHED}，${CLOSING}`,
    opening,
    plain: [
      PHONE_FULL,
      PHONE,
      CARD_MINUS,
      CARD_SPACED_DIGITS,
      NOT_LUHN_WIDE_SPACED,
      CARD_SPACED_NOT_LUHN_DIGITS,
      ID_SPACE_X,
      ID_X.slice(0, 17),
      PHONE_B,
      ORDER_FULL,
      EMAIL_FULL,
      'ｚｈａｎｇｓａｎ',
      'zhangsan',
      'ｅｘａｍｐｌｅ',
      'example.com',
    ],
    freePlain: [],
    cards: [CARD_SPACED_DIGITS, CARD_SPACED_NOT_LUHN_DIGITS],
    idTails: ['002X', '002 X'],
    kept: [opening, '全角手机', '面积 ㎡ 号①，', '邮箱 *** 已核，', `路径 ${SLASHED}，`, CLOSING],
    shapes: [],
    squeezedShapes: [
      /全角手机138\*{4}5678,卡号/u,
      /,卡号\*+7364,对照号/u,
      /,对照号\*+2196,证件/u,
      /,证件1\*{16}X,手机/u,
      /,手机139\*{4}1111备注,面积/u,
      /,订单\*+5678,邮箱/u,
      /,邮箱\*{3}已核,路径/u,
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
 * BR-ID-33 on one audit record (normalise, then mask; D10-3266): none of the sample's plain values
 * anywhere in it (of an e-mail the full address, the local part and the domain); in no leaf, with its non-digits
 * taken out, a run of 8 or more digits of a card or long number (a regrouped number is still the
 * number); the free text is still there (at least one leaf with its opening) and each such leaf
 * holds none of the free-only plain values, keeps the non-personal words, the numbers too short to be
 * masked, the mobile, identity and e-mail masks (the whole run with the "@" 「***」), shows of each card or long number only its last
 * four digits, and holds no identity number's last four characters. Returns those leaves.
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
        const message = `${leaf.path} 去掉非数字后不应含 ${card} 的连续 8 位 ${run}`;
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
    for (const value of sample.freePlain) {
      expect(leaf.value, `${leaf.path} 自由文本里不应出现明文 ${value}`).not.toContain(value);
    }
    for (const part of sample.kept) {
      expect(leaf.value, `${leaf.path} 应原样保留 ${part}`).toContain(part);
    }
    for (const shape of sample.shapes) {
      expect(leaf.value, `${leaf.path} 应符合 ${String(shape)}`).toMatch(shape);
    }
    for (const shape of sample.squeezedShapes) {
      const message = `${leaf.path} 归一并去掉空白与横线后应符合 ${String(shape)}`;
      expect(squeezed(leaf.value), message).toMatch(shape);
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
