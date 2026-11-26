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
    detail: { note: 'a.***@example.com', list: ['6259651208437736', '2026112112345678'] },
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
// number not first 1 + last 1, the card showing more than its last 4, the e-mail not 2 + 「***」.
it('[AC-B2-02zg-REDACT#4] 认得出的按 BR-ID-33 形状：手机 3+4（含 86 / +86）、身份证首 1 末 1（18 位 X / x / 数字、15 位）、过 Luhn 的卡只留末 4、邮箱留前 2 位 +「***」', () => {
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
  ).toBe('邮箱 zh***@example.com a***@x.com ***@x.com bo***@mail.corp.example.cn');
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

// 要点 3 正例（句点并入域名的错实现会红）。Wrong: the right side taken up to white space only, so the
// sentence's dot / comma / bracket joins the domain — 「example.com.」 is no domain, the piece is
// starred whole (or the punctuation is lost), not al***@example.com followed by the punctuation.
it('[AC-B2-02zg-REDACT#6] 邮箱右边界：句末句点、半角 , ; : ! ? ) ] } " \' 与中文标点都不并进地址，域名末尾不许是点', () => {
  for (const [written, masked] of [
    ['Confirmed alice@example.com.', 'Confirmed al***@example.com.'],
    ['Confirmed alice@example.com...', 'Confirmed al***@example.com...'],
    [
      'alice@example.com, bob@example.org; carol@example.cn:',
      'al***@example.com, bo***@example.org; ca***@example.cn:',
    ],
    [
      '(alice@example.com) [alice@example.com] {alice@example.com}',
      '(al***@example.com) [al***@example.com] {al***@example.com}',
    ],
    ['"alice@example.com" \'alice@example.com\'!', '"al***@example.com" \'al***@example.com\'!'],
    ['邮箱 alice@example.com。', '邮箱 al***@example.com。'],
    ['账号「alice@example.com」、《ab@x.com》？', '账号「al***@example.com」、《a***@x.com》？'],
    ['邮箱（ａｌｉｃｅ＠ｅｘａｍｐｌｅ．ｃｏｍ）。', '邮箱（ａｌ***＠ｅｘａｍｐｌｅ．ｃｏｍ）。'],
  ] as const) {
    expect(redactFreeText(written), written).toBe(masked);
  }
});

// 要点 3 反例。Wrong: a right side that is no domain shown as written, or an "@" next to white
// space taken as an address.
it('[AC-B2-02zg-REDACT#7] 邮箱形 反例：@ 后不像域名的整段打码（@ 留着）；@ 一侧是空白的原样', () => {
  expect(redactFreeText('账号 alice@localhost 已核')).toBe('账号 *****@********* 已核');
  expect(redactFreeText('转 bob.lee@内网，已核')).toBe('转 *******@**，已核');
  expect(redactFreeText('写成 alice@example.c 不认')).toBe('写成 *****@********* 不认');
  const kept = '请 @张三 处理，ops @ team，@ 符号单独出现，结尾@';
  expect(redactFreeText(kept)).toBe(kept);
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
// ㍻ / ㍿ / ﬃ shifted), an expansion kept whole (⑩ shown) or masked whole (its kept 0 lost), or the
// e-mail rewritten in ASCII (ｚｈ → zh, ＠ → @).
it('[AC-B2-02zg-REDACT#10] 位置映射：在归一文本上判、逐字符映射回原文；兼容字符展开跨进保留区只露归一后的那几位；全角邮箱回写保留原字符', () => {
  expect(redactFreeText('参考号 2345678⑩123 已核')).toBe('参考号 ********0123 已核');
  expect(redactFreeText('流水 ⑳26112112345678')).toBe('流水 ************5678');
  expect(redactFreeText('证件 ⑪010519491231002X')).toBe(`证件 1${'*'.repeat(16)}X`);
  expect(redactFreeText('ﬃ㍻㍿ 手机 13812345678，㍿ 证件 11010519491231002X')).toBe(
    `ﬃ㍻㍿ 手机 138****5678，㍿ 证件 1${'*'.repeat(16)}X`,
  );
  expect(redactFreeText('收款 ｚｈａｎｇｓａｎ＠ｅｘａｍｐｌｅ．ｃｏｍ')).toBe(
    '收款 ｚｈ***＠ｅｘａｍｐｌｅ．ｃｏｍ',
  );
  expect(redactFreeText('收款 zhangsan＠ｅｘａｍｐｌｅ.com')).toBe(
    '收款 zh***＠ｅｘａｍｐｌｅ.com',
  );
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

// 本地部分里的撇号。Wrong: every apostrophe ending the left side — o'connor only (mary.o'co***); or
// none — the quote opening '…' joins the address and is kept as one of its first 2 characters.
it('[AC-B2-02zg-REDACT#13] 邮箱左边界：本地部分内部的撇号属于地址；前面是空白、标点或开头的撇号是引号，不并入', () => {
  expect(redactFreeText("驳回 mary.o'connor@example.com 已核")).toBe('驳回 ma***@example.com 已核');
  expect(redactFreeText("备注 o'brien@example.com。")).toBe("备注 o'***@example.com。");
  expect(redactFreeText("'mary.o'connor@example.com'")).toBe("'ma***@example.com'");
  expect(redactFreeText("见 'alice@example.com' 与 ''bob@example.org")).toBe(
    "见 'al***@example.com' 与 ''bo***@example.org",
  );
});

// 组合字符。Wrong: NFKC code point by code point — e + U+0301 counted as two characters (e***@…,
// ab***@…); or the whole text rewritten in its composed form where nothing is masked.
it('[AC-B2-02zg-REDACT#14] 归一按字素：基字符与后随组合符一起 NFKC、算一个字符，邮箱前缀保留长度按它算；没打码的组合序列原样', () => {
  expect(redactFreeText('收款 é@example.com 已核')).toBe('收款 ***@example.com 已核');
  expect(redactFreeText('收款 ab́@x.com')).toBe('收款 a***@x.com');
  expect(redactFreeText('收款 josé@example.com')).toBe('收款 jo***@example.com');
  const kept = 'café 1234567890 ñ';
  expect(redactFreeText(kept)).toBe(kept);
});
