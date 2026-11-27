import { expect, it } from 'vitest';
import { SENSITIVE_KEYS } from '../../platform/index.ts';
import { AUDIT_REDACTED, redactFreeText, redactSnapshot } from './audit-redaction.ts';

it('[AC-F1-06b-REDACT#1] replaces values under sensitive key names at any depth, keeps masked fields', () => {
  const input = {
    phone: '13800000000',
    phone_masked: '138****0000',
    nested: [{ ID_Card: '110101199001011234', note: 'ok' }],
    permissions: ['a', 'b'],
  };
  const copy = structuredClone(input);
  expect(redactSnapshot(input, SENSITIVE_KEYS)).toEqual({
    phone: AUDIT_REDACTED,
    phone_masked: '138****0000',
    nested: [{ ID_Card: AUDIT_REDACTED, note: 'ok' }],
    permissions: ['a', 'b'],
  });
  expect(input).toEqual(copy);
  expect(redactSnapshot([1, 'x', null], SENSITIVE_KEYS)).toEqual([1, 'x', null]);
});

it('[AC-F1-06b-REDACT#2] matches key names by contained fragment, without any extra names', () => {
  const after = {
    totp_secret: 'GEZDGNBV',
    totpSecretCipher: 'x',
    password_hash: 'x',
    verify_phone: '13800138000',
    verify_phone_hmac: 'x',
    verify_phone_masked: '138****8000',
    stepUpToken: { level: 'sms' },
    is_super: true,
    login_name: 'ops-b',
  };
  expect(redactSnapshot(after)).toEqual({
    totp_secret: AUDIT_REDACTED,
    totpSecretCipher: AUDIT_REDACTED,
    password_hash: AUDIT_REDACTED,
    verify_phone: AUDIT_REDACTED,
    verify_phone_hmac: AUDIT_REDACTED,
    verify_phone_masked: '138****8000',
    stepUpToken: AUDIT_REDACTED,
    is_super: true,
    login_name: 'ops-b',
  });
});

// `note` is a free-text field, where a mobile number is masked 3 + 4 (BR-ID-33) instead of being
// replaced whole (separators and a +86 prefix as written); `contact` is not free text and keeps
// the earlier rule.
it('[AC-F1-06b-REDACT#3] replaces phone-shaped values in free text and numbers, keeps ids', () => {
  const id = '019a0000-0000-7000-8000-000000000001';
  expect(
    redactSnapshot({
      note: '手机 13800138000，备用 +86 138-0013-8000',
      contact: 13800138000,
      count: 12,
      target: `admin:${id}`,
      order_no: 'T2031060713800138000',
      ids: [id],
    }),
  ).toEqual({
    note: '手机 138****8000，备用 +86 138-****-8000',
    contact: AUDIT_REDACTED,
    count: 12,
    target: `admin:${id}`,
    order_no: 'T2031060713800138000',
    ids: [id],
  });
});

// B2-02zg (D10-3266): free text is normalised first, then masked. Each test below says how a wrong
// implementation turns it red.

// Wrong: free-text values outside the free-text keys masked, or a free-text key left alone — the
// structured fields change, or reject_note / remarks keep the plain numbers.
it('[AC-B2-02zg-REDACT#1] only free-text keys (also nested and suffixed) get the value patterns; structured fields stay as they are', () => {
  expect(
    redactSnapshot({
      reject_note: '卡 6222037195847364',
      reason_code: 'USER_REQUEST',
      order_id: '2026112112345678',
      idempotency_key: '2026112109876549',
      card_ref: '6222037195847364',
      out_refund_no: 'RF2026112187654322',
      amount_fen: -1_234_567_890_123,
      refund_fen: '98765432109876',
      detail: { note: 'a.b@example.com', list: ['6259651208437736', '2026112112345678'] },
      remarks: ['8427359012345', 6222037195847364, 12345],
    }),
  ).toEqual({
    reject_note: '卡 ************7364',
    reason_code: 'USER_REQUEST',
    order_id: '2026112112345678',
    idempotency_key: '2026112109876549',
    card_ref: '6222037195847364',
    out_refund_no: 'RF2026112187654322',
    amount_fen: -1_234_567_890_123,
    refund_fen: '98765432109876',
    detail: { note: '***', list: ['6259651208437736', '2026112112345678'] },
    remarks: ['*********2345', '************7364', 12345],
  });
});

// 要点 1 正例。Wrong: no NFKC (full-width digits kept as written, ＠ not seen), or a separator class
// without U+2212 / NBSP / U+3000 / line breaks (the groups judged one by one, < 11 digits, kept).
it('[AC-B2-02zg-REDACT#2] 归一：NFKC 后全角数字与 ＠ 照判；U+2212、各类横线、NBSP、U+202F、全角空格、制表符、换行都是分隔，分组连成一串', () => {
  expect(redactFreeText('卡 6222\u22120371\u22129584\u22127364 已核')).toBe(
    '卡 ****\u2212****\u2212****\u22127364 已核',
  );
  expect(redactFreeText('号 6228\u00a04810\u202f3357\u30002196')).toBe(
    '号 ****\u00a0****\u202f****\u30002196',
  );
  expect(redactFreeText('号 6228\t4810\r\n3357\u20282196')).toBe('号 ****\t****\r\n****\u20282196');
  expect(redactFreeText('号 6228\u2014\u20134810\ufe633357\uff0d2196')).toBe(
    '号 ****\u2014\u2013****\ufe63****\uff0d2196',
  );
  expect(redactFreeText('手机 １３８１２３４５６７８ 已核')).toBe('手机 １３８****５６７８ 已核');
  expect(redactFreeText('证件 11010519491231002 X')).toBe(`证件 1${'*'.repeat(16)} X`);
  expect(redactFreeText('手机 13812345678-备注')).toBe('手机 138****5678-备注');
});

// 要点 1 反例。Wrong: `/ . , _` (or any other mark) taken as separators — the four groups join into
// 16 digits and are masked.
it('[AC-B2-02zg-REDACT#3] 归一 反例：「/ . , _」与冒号不是分隔，各段 < 11 位原样；空白连起来仍 < 11 位的原样', () => {
  const kept =
    '6222/0371/9584/7364，6222.0371.9584.7364，6222,0371,9584,7364，6222_0371_9584_7364，' +
    '1234567890/1234567890，12345 67890，１２３４５６７８９０，2026-11-21 10:30，' +
    '2026-11-21T02:00:00.000Z，taobao:1234567，W20261121ABC，c0ffee00-b2b2-4d2e-9a2e-5f1a2b3c4d5e';
  expect(redactFreeText(kept)).toBe(kept);
  expect(redactFreeText('6222/0371 9584 7364')).toBe('6222/**** **** 7364');
});

// 要点 2 正例。Wrong: a recogniser missing or its shape changed — the mobile not 3 + 4, the identity
// number not first 1 + last 1, the card showing more than its last 4, a run holding an "@" not
// starred whole (zh***@…, ***@example.com).
it('[AC-B2-02zg-REDACT#4] 认得出的按 BR-ID-33 形状：手机 3+4（含 86 / +86）、身份证首 1 末 1（18 位 X / x / 数字、15 位）、过 Luhn 的卡只留末 4、含 @ 的片段整段换成「***」、不显示域名', () => {
  expect(redactFreeText('手机 13812345678，138 1234 5678，+86 138 1234 5678，8613812345678')).toBe(
    '手机 138****5678，138 **** 5678，+86 138 **** 5678，86138****5678',
  );
  expect(
    redactFreeText(
      '证件 11010519491231002X，11010519491231002x，110105199003071239，110105491231002',
    ),
  ).toBe(`证件 1${'*'.repeat(16)}X，1${'*'.repeat(16)}x，1${'*'.repeat(16)}9，1${'*'.repeat(13)}2`);
  expect(redactFreeText('卡 6222 0371 9584 7364，6217003816629349051，5903182647057')).toBe(
    '卡 **** **** **** 7364，***************9051，*********7057',
  );
  expect(
    redactFreeText(
      '邮箱 zhangsan@example.com ab@x.com a@x.com bob.lee+refund@mail.corp.example.cn',
    ),
  ).toBe('邮箱 *** *** *** ***');
});

// 要点 2 反例。Wrong: a check skipped (any 18 characters taken for an identity number, any 11 digits
// for a mobile number) — the shape would show the first digit / 138…; the fallback shows only the
// last four.
it('[AC-B2-02zg-REDACT#5] 认得出 反例：校验位错的 18 位、日期不对的 15 位、1[3-9] 以外开头的 11 位、多一位的 12 位都不按证件 / 手机形状，走兜底只留末四位', () => {
  expect(redactFreeText('11010519491231003X')).toBe(`${'*'.repeat(14)}003X`);
  expect(redactFreeText('440301871345123')).toBe(`${'*'.repeat(11)}5123`);
  expect(redactFreeText('12345678901')).toBe(`${'*'.repeat(7)}8901`);
  expect(redactFreeText('138123456789')).toBe(`${'*'.repeat(8)}6789`);
  expect(redactFreeText('13812345678X')).toBe(`${'*'.repeat(8)}678X`);
});

// 规则 2 正例（标点）。Wrong: the run cut at punctuation (a sentence dot, comma, bracket, quote,
// full-width punctuation) instead of white space only — the domain, the bracket or the text glued
// to the address shows (***@example.com., ***，bob…), or two addresses with no white space between
// them become two masks with the punctuation kept.
it('[AC-B2-02zg-REDACT#6] 含 @ 的片段只在空白处断：句点、逗号、分号、冒号、括号、引号与中文标点都在片段内一起遮，不显示域名', () => {
  for (const [written, masked] of [
    ['Confirmed alice@example.com.', 'Confirmed ***'],
    ['Confirmed alice@example.com...', 'Confirmed ***'],
    ['alice@example.com, bob@example.org; carol@example.cn:', '*** *** ***'],
    ['(alice@example.com) [alice@example.com] {alice@example.com}', '*** *** ***'],
    ['"alice@example.com" \'alice@example.com\'!', '*** ***'],
    ['邮箱 alice@example.com。', '邮箱 ***'],
    ['账号「alice@example.com」、《ab@x.com》？', '***'],
    ['邮箱（ａｌｉｃｅ＠ｅｘａｍｐｌｅ．ｃｏｍ）。', '***'],
  ] as const) {
    expect(redactFreeText(written), written).toBe(masked);
  }
});

// 规则 2（不论 @ 两侧是什么）。Wrong: an "@" still judged for e-mail shape (a side being blank, the
// right side not shaped like a domain) — 请 @张三 处理, ops @ team, 价格@3.5元, a lone "@" or one at
// the end left as written; or a second "@" ending the run.
it('[AC-B2-02zg-REDACT#7] 含 @ 的片段不论 @ 两侧是什么都整段遮：@ 一侧是空白、单独的 @、@ 后不像域名、结尾的 @、同段两个 @', () => {
  expect(redactFreeText('账号 alice@localhost 已核')).toBe('账号 *** 已核');
  expect(redactFreeText('转 bob.lee@内网，已核')).toBe('转 ***');
  expect(redactFreeText('写成 alice@example.c 不认')).toBe('写成 *** 不认');
  expect(redactFreeText('请 @张三 处理，ops @ team，@ 符号单独出现，结尾@')).toBe(
    '请 *** 处理，ops *** *** ***',
  );
  expect(redactFreeText('价格@3.5元')).toBe('***');
  expect(redactFreeText('联系 a@b@c，d 已核')).toBe('联系 *** 已核');
  expect(redactFreeText('@')).toBe('***');
});

// 要点 4 正例。Wrong: a Luhn, check-character or boundary gate kept on the fallback — the order
// number, the reference, the prefixed run or the uuid digits stay as written.
it('[AC-B2-02zg-REDACT#8] 兜底：去分隔后 ≥ 11 位数字（可带末位 X / x）一律只留末四字符，不看 Luhn、校验位、前后字母', () => {
  expect(redactFreeText('订单 2026112112345678 参考号 8427359012345')).toBe(
    '订单 ************5678 参考号 *********2345',
  );
  expect(redactFreeText('W2026112187654322ABC taobao:2026112187654322')).toBe(
    'W************4322ABC taobao:************4322',
  );
  expect(redactFreeText('对照 6228 4810 3357 2196，参考 62220371958473641230')).toBe(
    '对照 **** **** **** 2196，参考 ****************1230',
  );
  expect(redactFreeText('备查 11010519491231003 x，123456789012x')).toBe(
    `备查 ${'*'.repeat(14)}003 x，${'*'.repeat(9)}012x`,
  );
  expect(redactFreeText('12345678-1234-1234-1234-123456789012')).toBe(
    '********-****-****-****-********9012',
  );
  expect(redactFreeText('1234567890 1')).toBe('*******890 1');
});

// 要点 4 反例。Wrong: a threshold below 11, or an X glued to a following letter taken in (Ⅻ → XII).
it('[AC-B2-02zg-REDACT#9] 兜底 反例：< 11 位原样；后面紧跟字母的 X 不并入', () => {
  const kept = '面积 1234567890 号 123 X 光 规格 ①Ⅻ 型号 12345XL';
  expect(redactFreeText(kept)).toBe(kept);
  expect(redactFreeText('1234567890123XYZ')).toBe(`${'*'.repeat(9)}0123XYZ`);
});

// 要点 5 正例。Wrong: masks written at their normalised index in the original (every mask after
// ㍻ / ㍿ / ﬃ shifted), an expansion kept whole (⑩ shown) or masked whole (its kept 0 lost), or a
// full-width run holding ＠ not starred whole (its ＠ not seen, or its domain shown).
it('[AC-B2-02zg-REDACT#10] 位置映射：在归一文本上判、逐字符映射回原文；兼容字符展开跨进保留区只露归一后的那几位；全角含 ＠ 的片段整段遮、其外原字符原样', () => {
  expect(redactFreeText('参考号 2345678⑩123 已核')).toBe('参考号 ********0123 已核');
  expect(redactFreeText('流水 ⑳26112112345678')).toBe('流水 ************5678');
  expect(redactFreeText('证件 ⑪010519491231002X')).toBe(`证件 1${'*'.repeat(16)}X`);
  expect(redactFreeText('ﬃ㍻㍿ 手机 13812345678，㍿ 证件 11010519491231002X')).toBe(
    `ﬃ㍻㍿ 手机 138****5678，㍿ 证件 1${'*'.repeat(16)}X`,
  );
  expect(redactFreeText('收款 ｚｈａｎｇｓａｎ＠ｅｘａｍｐｌｅ．ｃｏｍ 已核')).toBe(
    '收款 *** 已核',
  );
  expect(redactFreeText('收款 zhangsan＠ｅｘａｍｐｌｅ.com')).toBe('收款 ***');
});

// 要点 5 反例。Wrong: the text rewritten in its normalised form even where nothing is masked.
it('[AC-B2-02zg-REDACT#11] 位置映射 反例：没有打码的兼容字符、全角字符与标点原样，不写成归一形', () => {
  const kept = '（备注：面积120㎡，①号，ﬁle…™，全角１２３４５）';
  expect(redactFreeText(kept)).toBe(kept);
  expect(redactFreeText('（备注：面积120㎡，手机13812345678）')).toBe(
    '（备注：面积120㎡，手机138****5678）',
  );
});

// 证件号紧跟说明文字。Wrong: the X taken in only when no letter at all follows it (汉字 counted as a
// letter) — the 17 digits fall back alone and 1002 shows next to the X (*************1002X已核);
// or the X refused whatever follows it — 1234567890123XYZ in #9 masks 012X.
it('[AC-B2-02zg-REDACT#12] 校验位对的 17 位数字 + X / x 不论后面跟什么都按证件首 1 末 1，后面的说明原样；不是证件的 X 只在后面不紧跟 ASCII 字母或数字时并入兜底', () => {
  expect(redactFreeText('证件11010519491231002X已核')).toBe(`证件1${'*'.repeat(16)}X已核`);
  expect(redactFreeText('证件 11010519491231002x号码')).toBe(`证件 1${'*'.repeat(16)}x号码`);
  expect(redactFreeText('证件 11010519491231002XAB')).toBe(`证件 1${'*'.repeat(16)}XAB`);
  expect(redactFreeText('单号12345678901X已核')).toBe(`单号${'*'.repeat(8)}901X已核`);
  expect(redactFreeText('备查 11010519491231003X已核')).toBe(`备查 ${'*'.repeat(14)}003X已核`);
});

// 规则 1（片段左端）。Wrong: the run starting anywhere but after white space or at the start — at an
// apostrophe (mary.o'***), a quote or bracket (见 '***…), a colon / semicolon / comma (a:***),
// full-width punctuation or CJK (邮箱***…) — so text glued before the "@" shows.
it('[AC-B2-02zg-REDACT#13] 片段左端只在空白或文本开头：撇号、引号、括号、冒号、分号、逗号、全角标点、点、加号、下划线、连字符都在片段内一起遮', () => {
  expect(redactFreeText("驳回 mary.o'connor@example.com 已核")).toBe('驳回 *** 已核');
  expect(redactFreeText("驳回 mary.o''connor@example.com 已核")).toBe('驳回 *** 已核');
  expect(redactFreeText("备注 o'brien@example.com。")).toBe('备注 ***');
  expect(redactFreeText("见 'alice@example.com' 与 ''bob@example.org")).toBe('见 *** 与 ***');
  expect(redactFreeText('见 "alice@example.com" 与 \u201cbob@example.org\u201d')).toBe(
    '见 *** 与 ***',
  );
  expect(redactFreeText('邮箱alice@example.com，账号：bob@example.org；<carol@example.cn>')).toBe(
    '***',
  );
  expect(
    redactFreeText('a:bob@x.com a;bob@x.com a,bob@x.com [bob@x.com] {bob@x.com} 「bob@x.com」'),
  ).toBe('*** *** *** *** *** ***');
  expect(redactFreeText('邮箱 _a-b.c+d@example.com')).toBe('邮箱 ***');
});

// 18 位证件后的 X。Wrong: an X after white space taken into a complete 18-digit identity number — the
// 19 characters fall back and 239 X shows (***************239 X先生); or a glued X taken in.
it('[AC-B2-02zg-REDACT#15] 去分隔 ≥ 17 位：18 位纯数字校验通过即按证件首 1 末 1，其后的 X（隔空白或紧贴）都不并入', () => {
  expect(redactFreeText('证件 110105199003071239 X先生已核')).toBe(
    `证件 1${'*'.repeat(16)}9 X先生已核`,
  );
  expect(redactFreeText('证件 110105199003071239X先生')).toBe(`证件 1${'*'.repeat(16)}9X先生`);
  expect(redactFreeText('证件 1101 0519 9003 0712 39 x')).toBe(`证件 1*** **** **** **** *9 x`);
});

// 17 位 + X。Wrong: the X looked for only right after the digits — 17 digits fall back alone and
// 1002 shows (*************1002 X); or an 18-digit check run before the 17 + X one taking the X
// only through the fallback (*************002 X).
it('[AC-B2-02zg-REDACT#16] 17 位数字后紧贴或隔一个空白的 X / x 合成 18 位校验通过即并入，按证件首 1 末 1；合成不过的走兜底', () => {
  expect(redactFreeText('11010519491231002 X')).toBe(`1${'*'.repeat(16)} X`);
  expect(redactFreeText('证件 11010519491231002 XAB')).toBe(`证件 1${'*'.repeat(16)} XAB`);
  expect(redactFreeText('证件 11010519491231002x')).toBe(`证件 1${'*'.repeat(16)}x`);
  expect(redactFreeText('备查 11010519491231003 X')).toBe(`备查 ${'*'.repeat(14)}003 X`);
});

// 组合字符。Wrong: NFKC code point by code point with the mask written per code point — a combining
// mark of the run left behind next to the 「***」 (***́); or the whole text rewritten in its composed
// form where nothing is masked.
it('[AC-B2-02zg-REDACT#14] 归一按字素：基字符与后随组合符一起 NFKC；含 @ 的片段里的组合序列一起换成「***」不留组合符；没打码的组合序列原样', () => {
  expect(redactFreeText('收款 é@example.com 已核')).toBe('收款 *** 已核');
  expect(redactFreeText('收款 ab́@x.com')).toBe('收款 ***');
  expect(redactFreeText('收款 alice@exámple.coḿ 已核')).toBe('收款 *** 已核');
  const kept = 'café 1234567890 ñ';
  expect(redactFreeText(kept)).toBe(kept);
});

// 中文与数字紧贴 @。Wrong: the run cut at CJK or at a digit (用户@… or 欧阳明2026 left as written); or
// the mask reaching over white space (收款账号 lost).
it('[AC-B2-02zg-REDACT#17] @ 前后紧贴中文、数字：片段从空白到空白整段换成「***」，空白外的文字原样', () => {
  expect(redactFreeText('收款账号 用户@example.com 待核')).toBe('收款账号 *** 待核');
  expect(redactFreeText('账号用户@example.com')).toBe('***');
  expect(redactFreeText('欧阳明2026@example.com')).toBe('***');
  expect(redactFreeText('备注\u3000账号：张三@example.cn。')).toBe('备注\u3000***');
  expect(redactFreeText('账号 user用户@example.com，已核')).toBe('账号 ***');
  expect(redactFreeText('邮箱alice@example.com 与 邮箱 bob@example.org')).toBe('*** 与 邮箱 ***');
  expect(redactFreeText('联系 用户@内网 处理')).toBe('联系 *** 处理');
  expect(redactFreeText('收款账号 用户@公司.example.cn-待核')).toBe('收款账号 ***');
});

// 不含 @ 的片段照旧。Wrong: a run without an "@" starred because a neighbouring run has one, or
// the whole text starred; or the digit rules skipped in the runs around an "@" run.
it('[AC-B2-02zg-REDACT#18] 不含 @ 的片段照旧：邻段有 @ 不影响，手机号、证件号、卡号、长数字兜底照常判，没有可遮的原样', () => {
  expect(redactFreeText('手机 13812345678 邮箱 a@x.com 卡 6222037195847364')).toBe(
    '手机 138****5678 邮箱 *** 卡 ************7364',
  );
  expect(redactFreeText('13812345678@qq.com 手机 13812345678')).toBe('*** 手机 138****5678');
  expect(redactFreeText('证件 11010519491231002X @ 已核')).toBe(
    `证件 1${'*'.repeat(16)}X *** 已核`,
  );
  const kept = '备注 无邮箱 面积120㎡ 123-4567';
  expect(redactFreeText(kept)).toBe(kept);
});

// 18 位证件 + 分隔符 + 数字。Wrong: the separator joining the next digits into the run — 19 digits
// fall back and 239<tab>2 shows (***************239\t2); or the next digits swallowed into the
// identity mask; or the split made without a separator, so 19 digits written together or a card
// grouped 4-4-4-4-3 is masked as an identity number (first digit shown).
it('[AC-B2-02zg-REDACT#19] 去分隔 > 18 位：前 18 位校验通过且第 18 位后紧跟分隔符，只把前 18 位按证件首 1 末 1，其后另起一段；无分隔符的照原顺序', () => {
  const id = `1${'*'.repeat(16)}9`;
  expect(redactFreeText('证件 110105199003071239\t2')).toBe(`证件 ${id}\t2`);
  expect(redactFreeText('证件 110105199003071239 2')).toBe(`证件 ${id} 2`);
  expect(redactFreeText('证件 110105199003071239-13812345678')).toBe(`证件 ${id}-138****5678`);
  expect(redactFreeText('证件 110105199003071239 12345678901234')).toBe(
    `证件 ${id} ${'*'.repeat(10)}1234`,
  );
  expect(redactFreeText('证件 1101051990030712392')).toBe(`证件 ${'*'.repeat(15)}2392`);
  expect(redactFreeText('卡 1101 0519 9003 0712 392')).toBe('卡 **** **** **** ***2 392');
  expect(redactFreeText('证件 110105199003071238 2')).toBe(`证件 ${'*'.repeat(15)}238 2`);
});

// 必满足项（D10-3495）。Wrong, case by case: the run cut at a dash or minus (收款账号 li-*** 已核,
// 王小明-*** 已核, 备注−***); the digit rules run first inside the run (王小明-138****5678@qq.com);
// a tab not taken as white space (备注 *** instead of 备注 ***<tab>已核, 已核 lost); the run cut at
// the full-width comma (联系 ***，***。) or the domain shown; an "@" with a blank side left as written.
it('[AC-B2-02zg-REDACT#20] 必满足项：横线与 U+2212 不断片段、片段内手机号不单独判、制表符是空白、相邻地址与 @张三 整段遮', () => {
  expect(redactFreeText('收款账号 li-wei@example.com 已核')).toBe('收款账号 *** 已核');
  expect(redactFreeText('王小明-13812345678@qq.com 已核')).toBe('*** 已核');
  expect(redactFreeText('备注\u2212alice@example.com')).toBe('***');
  expect(redactFreeText('备注 alice@example.com\t已核')).toBe('备注 ***\t已核');
  expect(redactFreeText('联系 alice@example.com，bob@example.org。')).toBe('联系 ***');
  expect(redactFreeText('请 @张三 处理')).toBe('请 *** 处理');
});

// 规则 1（Unicode 空白）。Wrong: the run cut at anything but white space — another dash (‐ – — －),
// a digit, a CJK character, a quote or a bracket — so text glued to the "@" shows; or not cut at
// Unicode white space (NBSP, U+202F, U+3000, tab, line breaks), so the text across it is starred
// too; or the white space itself starred or dropped.
it('[AC-B2-02zg-REDACT#21] 片段只在 Unicode 空白或文本首尾断：各类横线、数字、中文、引号、括号一起遮，空白本身与空白外的文字原样', () => {
  for (const blank of [
    ' ',
    '\u00a0',
    '\u202f',
    '\u3000',
    '\t',
    '\n',
    '\r\n',
    '\r',
    '\u2028',
    '\u2029',
  ]) {
    const label = JSON.stringify(blank);
    expect(
      redactFreeText(`前${blank}「张\u2010三–2026—x－」li@example.com，已核${blank}已核`),
      label,
    ).toBe(`前${blank}***${blank}已核`);
  }
  expect(redactFreeText('（2026）\u201c李\u201d-wei@example.com')).toBe('***');
});

// 规则 2（不显示域名）。Wrong: a recognised domain still shown (***@example.com）已核), what follows
// it in the run kept, or the mask stopping at a second "@" or at punctuation.
it('[AC-B2-02zg-REDACT#22] 认得出的域名也不显示：域名与其后同段的文字一起遮，下一个空白后的原样', () => {
  expect(redactFreeText('邮箱（alice@example.com）已核 下一句')).toBe('*** 下一句');
  expect(redactFreeText('邮箱（alice@内网）已核 下一句')).toBe('*** 下一句');
  expect(redactFreeText('联系 ops@localhost。备注')).toBe('联系 ***');
  expect(redactFreeText('收款账号 用户@example.com-待核 下一句')).toBe('收款账号 *** 下一句');
  expect(redactFreeText('账号用户@mail.example.cn-备注，已核')).toBe('***');
});

// 片段内数字随整段。Wrong: the digit rules (mobile, card, identity number, fallback) run before the
// "@" rule or over its characters — the run shows 138****5678, ************7364, 1****…9 or the
// fallback's last four next to the 「***」.
it('[AC-B2-02zg-REDACT#23] 含 @ 的片段先于手机号、证件号、卡号与长数字兜底：片段里的数字随整段遮，不单独打码', () => {
  expect(redactFreeText('收款 6222037195847364@bank.cn 已核')).toBe('收款 *** 已核');
  expect(redactFreeText('收款 110105199003071239@x.com')).toBe('收款 ***');
  expect(redactFreeText('收款 2026112112345678@x.com')).toBe('收款 ***');
  expect(redactFreeText('收款 １３８１２３４５６７８＠ｑｑ．ｃｏｍ')).toBe('收款 ***');
  expect(redactFreeText('手机13812345678@备注')).toBe('***');
});

// 位置映射。Wrong: the 「***」 written at the normalised index (text after ㍿ / ﬃ shifted), one star
// per hidden character, or an expansion of the run left partly behind (⑩ → 0 kept).
it('[AC-B2-02zg-REDACT#24] 位置映射：被遮片段在原文里的整段（含兼容字符、全角字符）只写一个「***」，片段前后的原文字符原样', () => {
  expect(redactFreeText('ﬃ㍿ 账号⑩＠ｘ．ｃｏｍ ㍻ 已核')).toBe('ﬃ㍿ *** ㍻ 已核');
  expect(redactFreeText('１２３\u3000ａ＠ｂ\u3000４５６')).toBe('１２３\u3000***\u3000４５６');
  expect(redactFreeText('@ ')).toBe('*** ');
});
