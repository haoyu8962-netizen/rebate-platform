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

// B2-02ze: `note` is a free-text field, where a mobile number is masked 3 + 4 (BR-ID-33) instead
// of being replaced whole; `contact` is not free text and keeps the earlier rule.
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
    note: '手机 138****8000，备用 138****8000',
    contact: AUDIT_REDACTED,
    count: 12,
    target: `admin:${id}`,
    order_no: 'T2031060713800138000',
    ids: [id],
  });
});

// B2-02ze r2 (负责人 2026-11-21 「订单号不是敏感信息，不打码」, D10-2354 / D10-2365): only what is
// recognisably personal is masked — cards / accounts of 13–19 digits passing Luhn, identity numbers
// with a valid check character or date. Changed from r1 (「宁可多脱敏」, void): long numbers failing
// Luhn (8427359012345, 6222-0298-7715-8462) and prefixed / lettered runs are no longer masked or
// kept by their prefix, but judged by their digits.
it('[AC-B2-02ze-REDACT#1] free text: e-mail, identity numbers, Luhn cards and mobiles are masked; uuids, non-Luhn and short numbers are kept', () => {
  expect(redactFreeText('邮箱 alice.w@example.com，bob.lee+refund@mail.corp.example.cn')).toBe(
    '邮箱 a***@***.com，b***@***.cn',
  );
  // r4 (money r2 第 2 条, every recogniser, union): 440524188001010014 is an identity number and,
  // its 18 digits passing Luhn, a card too: the card hides its first digit, the identity number
  // the rest but the last.
  expect(redactFreeText('证件 11010519491231002X，440524188001010014，110105491231002')).toBe(
    `证件 1${'*'.repeat(16)}X，${'*'.repeat(17)}4，1${'*'.repeat(13)}2`,
  );
  expect(
    redactFreeText(
      '卡 6222 0371 9584 7364，6222-0298-7715-8467，6222/0371/9584/7364，6217003816629349051',
    ),
  ).toBe('卡 ************7364，************8467，************7364，***************9051');
  expect(redactFreeText('卡 6222 0371 9584 7364ABC，手机 tel:13812345678')).toBe(
    '卡 ************7364ABC，手机 tel:138****5678',
  );
  const kept =
    'c0ffee00-b2b2-4d2e-9a2e-5f1a2b3c4d5e 12345678-1234-1234-1234-123456789012 ' +
    '参考号 8427359012345、对照 6222-0298-7715-8462、WD2026112100001234、W2026112187654322ABC、' +
    'taobao:1234567、123456789012、2026-11-21T02:00:00.000Z';
  expect(redactFreeText(kept)).toBe(kept);
});

it('[AC-B2-02ze-REDACT#2] only free-text keys (also nested and suffixed) get the value patterns; structured fields stay as they are', () => {
  expect(
    redactSnapshot({
      reject_note: '卡 6222037195847364',
      reason_code: 'USER_REQUEST',
      order_id: '2026112112345678',
      idempotency_key: '2026112109876549',
      card_ref: '6222037195847364',
      amount_fen: -1_234_567_890_123,
      refund_fen: '98765432109876',
      detail: { note: 'a.b@example.com', list: ['6259651208437736', '2026112112345678'] },
      remarks: ['8427359012345', 6222037195847364],
    }),
  ).toEqual({
    reject_note: '卡 ************7364',
    reason_code: 'USER_REQUEST',
    order_id: '2026112112345678',
    idempotency_key: '2026112109876549',
    card_ref: '6222037195847364',
    amount_fen: -1_234_567_890_123,
    refund_fen: '98765432109876',
    detail: { note: 'a***@***.com', list: ['6259651208437736', '2026112112345678'] },
    remarks: ['8427359012345', '************7364'],
  });
});

/** The digits of a text, separators and stars taken out. */
const digitsIn = (text: string): string => text.replace(/[^0-9]/g, '');

it('[AC-B2-02ze-MUST#1] 第①条 正例：过 Luhn 的卡号在任何分组写法下都只露末 4，不露 BIN / 前 6 位', () => {
  for (const written of [
    '6222037195847364',
    '6222 0371 9584 7364',
    '6222-0371-9584-7364',
    '6222/0371/9584/7364',
    '6222.0371.9584.7364',
    '6222\u30000371\u30009584\u30007364',
    '622 2037 1958 4736 4',
    '6 2 2 2 0 3 7 1 9 5 8 4 7 3 6 4',
    '６２２２０３７１９５８４７３６４',
    '6222 0371 9584 7364 2026',
  ]) {
    const masked = redactFreeText(`收款卡 ${written} 已核`);
    expect(masked, written).not.toContain('622203');
    expect(masked, written).toMatch(/^收款卡 \*{12}7364( 2026)? 已核$/);
    expect(digitsIn(masked).startsWith('7364'), written).toBe(true);
  }
});

it('[AC-B2-02ze-MUST#1] 第①条 反例：不过 Luhn 的同形数字与 12 位以下的分组数字原样保留，不当卡号', () => {
  for (const written of [
    '6228 4810 3357 2196',
    '6228-4810-3357-2196',
    '1234 5678',
    '6222 0371 9584',
  ]) {
    expect(redactFreeText(`对照 ${written} 已核`)).toBe(`对照 ${written} 已核`);
  }
});

it('[AC-B2-02ze-MUST#2] 第②条 正例：邮箱只遮本地部分、只留可辨末段，完整域名不原样出现，也不整段替换为 ***', () => {
  for (const [address, masked, domain] of [
    ['alice.w@example.com', 'a***@***.com', 'example.com'],
    ['bob.lee+refund@mail.corp.example.cn', 'b***@***.cn', 'example.cn'],
    ['Carol_Z@Example.ORG', 'C***@***.ORG', 'Example.ORG'],
  ] as const) {
    const out = redactFreeText(`联系 ${address}，已核`);
    expect(out).toBe(`联系 ${masked}，已核`);
    expect(out).not.toContain(domain);
    expect(out).not.toContain(address.split('@')[0]);
    expect(out).not.toMatch(/联系 \*+，/);
  }
});

it('[AC-B2-02ze-MUST#2] 第②条 反例：不是邮箱的 @ 写法（@张三、无顶级域、单字母顶级域）原样保留', () => {
  const kept = '请 @张三 处理，见 ops@localhost 与 x@y.z，@ 符号单独出现';
  expect(redactFreeText(kept)).toBe(kept);
});

it('[AC-B2-02ze-MUST#3] 第③条 正例：过 Luhn 的 13–19 位数字串确实打码（星号替换，不是重新分组或加空格）', () => {
  for (const [card, tail] of [
    ['5903182647057', '7057'],
    ['6222037195847364', '7364'],
    ['6217003816629349051', '9051'],
  ] as const) {
    const out = redactFreeText(`卡 ${card}`);
    expect(out).toBe(`卡 ${'*'.repeat(card.length - 4)}${tail}`);
    expect(digitsIn(out)).toBe(tail);
  }
});

it('[AC-B2-02ze-MUST#3] 第③条 反例：不过 Luhn 的长数字串（订单号、参考号、错一位的卡号）原样', () => {
  const kept =
    '订单 2026112112345678，参考号 8427359012345，19 位 6013829475610384726，' +
    '错一位的卡 6222037195847365';
  expect(redactFreeText(kept)).toBe(kept);
});

it('[AC-B2-02ze-MUST#5] 第⑤条 正例：卡号下界 13 位、上界 19 位过 Luhn 打码', () => {
  expect(redactFreeText('卡 5903182647057')).toBe('卡 *********7057');
  expect(redactFreeText('卡 6217003816629349051')).toBe('卡 ***************9051');
});

it('[AC-B2-02ze-MUST#5] 第⑤条 反例：12 位与 20 位即使过 Luhn 也不打码', () => {
  const kept = '12 位 622203719589，20 位 62220371958473641230';
  expect(redactFreeText(kept)).toBe(kept);
});

it('[AC-B2-02ze-MUST#6] 第⑥条 正例：紧贴字母或前缀的数字段照样按数字段判，过 Luhn 即打码', () => {
  expect(redactFreeText('cardNo6259651208437736')).toBe('cardNo************7736');
  expect(redactFreeText('card:6259651208437736，卡6259651208437736号')).toBe(
    'card:************7736，卡************7736号',
  );
});

it('[AC-B2-02ze-MUST#6] 第⑥条 反例：紧贴字母或前缀、但数字段不过 Luhn 的单号原样', () => {
  const kept = 'WD2026112100001234，taobao:2026112187654322，W2026112187654322ABC';
  expect(redactFreeText(kept)).toBe(kept);
});

it('[AC-B2-02ze-MUST#7] 第⑦条 正例：18 位校验位正确（含末位 X）与 15 位第 7–12 位为真实日期的证件按首 1 末 1 打码', () => {
  expect(redactFreeText('证件 11010519491231002X，110105199003071239，110105491231002')).toBe(
    `证件 1${'*'.repeat(16)}X，1${'*'.repeat(16)}9，1${'*'.repeat(13)}2`,
  );
});

it('[AC-B2-02ze-MUST#7] 第⑦条 反例：校验位错的 18 位（11010519491231003X 末位应为 8）与 15 位非真实日期（2 月 31 日、13 月、非闰年 2 月 29 日）原样', () => {
  const kept =
    '证件 11010519491231003X，320106198508164523，440301870231124，440301871345123，440301870229123';
  expect(redactFreeText(kept)).toBe(kept);
});

// ---- B2-02ze 实现 r3（money r1 五条发现；原例取自评审）----

it('[AC-B2-02ze-R3#1] money r1 第 1 条：分组之间连续多个分隔符（原例两个空格）与空格、短横、斜杠、点、全角空格的任意组合，去掉分隔符后判长度与 Luhn，照样只露末 4', () => {
  expect(redactFreeText('收款卡 6222 0371  9584 7364 已核')).toBe('收款卡 ************7364 已核');
  for (const written of [
    '6222  0371   9584    7364',
    '6222 - 0371 / 9584 . 7364',
    '6222　　0371 -- 9584//7364',
    '6222 .　-/ 0371 9584 7364',
  ]) {
    const masked = redactFreeText(`卡 ${written} 已核`);
    expect(masked, written).toBe('卡 ************7364 已核');
    expect(masked).not.toContain('6222');
  }
  // 反例：连续分隔符隔开的不过 Luhn 的同形数字仍原样。
  const kept = '对照号 6228 4810  3357 2196 已核';
  expect(redactFreeText(kept)).toBe(kept);
});

it('[AC-B2-02ze-R3#2] money r1 第 2 条：重叠候选取「各候选除自身末 4 外」的并集一次遮住；原例 1003 6222 0371 9584 7364 除 7364 外全遮', () => {
  // 1003 6222 0371 9584 与 6222 0371 9584 7364 都过 Luhn：两候选重叠。
  const masked = redactFreeText('余额重算原因：核对编号与卡 1003 6222 0371 9584 7364 已核');
  expect(masked).toBe('余额重算原因：核对编号与卡 ****************7364 已核');
  expect(masked.replace(/[^0-9]/g, '')).toBe('7364');
  // 反向例：卡号在前、后面跟着别的组：卡号只露末 4，后面不属于任何候选的组原样。
  expect(redactFreeText('卡 6222 0371 9584 7364 1003 已核')).toBe('卡 ************7364 1003 已核');
  // 反例：整串没有任何可认候选时一个字也不动（分组与分隔符原样）。
  const kept = '单号 2026 1121 0000 1234 5678 已核';
  expect(redactFreeText(kept)).toBe(kept);
});

it('[AC-B2-02ze-R3#3] money r1 第 3 条：国际化域名（Unicode 与 Punycode）邮箱、Unicode 本地部分照样遮本地部分、留可辨末段，完整域名不原样出现', () => {
  const masked = redactFreeText('驳回原因：收款账号 alice@例子.中国 不符');
  expect(masked).toBe('驳回原因：收款账号 a***@***.中国 不符');
  expect(masked).not.toContain('alice');
  expect(masked).not.toContain('例子');
  expect(redactFreeText('alice@xn--fsqu00a.xn--fiqs8s')).toBe('a***@***.xn--fiqs8s');
  expect(redactFreeText('bob@xn--fsqu00a.com')).toBe('b***@***.com');
  expect(redactFreeText('邮箱 张三@公司.中国，josé.müller@bücher.de')).toBe(
    '邮箱 张***@***.中国，j***@***.de',
  );
  // r4（money r2 第 3 条，本地部分不按文字体系拆）：紧贴的中文并进本地部分（多遮，已知代价），
  // 紧跟的第二个邮箱仍各自打码，两个本地部分与域名都不原样出现。
  const glued = redactFreeText('邮箱alice@example.com和bob@x.cn已核');
  expect(glued).toBe('邮***@***.com和***@***.cn已核');
  for (const plain of ['alice', 'bob', 'example', 'x.cn']) expect(glued).not.toContain(plain);
});

it('[AC-B2-02ze-R3#3] money r1 第 3 条 反例：普通中文句子里的「@」不当邮箱', () => {
  const kept = '转给财务@张三处理。价格@3.5元，@所有人 请核对';
  expect(redactFreeText(kept)).toBe(kept);
});

it('[AC-B2-02ze-R3#5] money r1 第 5 条（本轮不修，已知代价）：分组书写的 20 位参考号若某段过 Luhn，按卡号打码；连写的 20 位原样', () => {
  expect(redactFreeText('参考号 6222 0371 9584 7364 1230')).toBe('参考号 ************7364 1230');
  expect(redactFreeText('参考号 62220371958473641230')).toBe('参考号 62220371958473641230');
});

// ---- B2-02ze 实现 r4（money r2 三条 S0；按原则改，原例取自评审）----

it('[AC-B2-02ze-R4#1] money r2 第 1 条：分隔符是一类字符——不换行空格 U+00A0、窄不换行空格 U+202F、制表符、全角空格、长破折号各自分组的卡号都只露末 4', () => {
  // 原例：组间是 U+00A0。
  expect(redactFreeText('收款卡 6222\u00A00371\u00A09584\u00A07364 已核')).toBe(
    '收款卡 ************7364 已核',
  );
  for (const separator of [
    '\u00A0',
    '\u202F',
    '\t',
    '\u3000',
    '\u2014',
    '\u2007',
    '\uFF0E',
    ',',
    '_',
  ]) {
    const written = ['6222', '0371', '9584', '7364'].join(separator);
    const masked = redactFreeText(`卡 ${written} 已核`);
    expect(masked, JSON.stringify(separator)).toBe('卡 ************7364 已核');
    expect(masked.replace(/[^0-9]/g, '')).toBe('7364');
  }
  // 连续、混用。
  expect(redactFreeText('卡 6222\u00A0\u202F0371\t—\u30009584 \u2013 7364 已核')).toBe(
    '卡 ************7364 已核',
  );
  // 反例：同样分隔、不过 Luhn 的数字原样。
  const kept = '对照号 6228\u00A04810\u202F3357\t2196 已核';
  expect(redactFreeText(kept)).toBe(kept);
});

it('[AC-B2-02ze-R4#2] money r2 第 2 条：所有识别器都算、取并集、不短路——整段过证件校验时卡号候选照样遮，卡号首位不露', () => {
  // 原例：前四组是过 Luhn 的卡号，拼上 03 后整段 18 位恰好过证件校验。
  const masked = redactFreeText('6222 0371 9584 7364 03 已核');
  // 卡号要遮 6222 0371 9584（首位 6 也在内），证件要遮第 2–17 位：并集只剩末位 3。
  expect(masked).toBe(`${'*'.repeat(17)}3 已核`);
  expect(masked).not.toMatch(/^6/);
  expect(masked.replace(/[^0-9]/g, '')).toBe('3');
});

it('[AC-B2-02ze-R4#2] money r2 第 2 条：手机号与卡号重叠——两者各自应遮的位都被遮住', () => {
  // 620005 138 1234 是过 Luhn 的 13 位卡号（应遮 620005 138，露 1234）；
  // 138 1234 5679 是手机号（应遮中间 1234，露 138 与 5679）；整段 17 位不过 Luhn。
  const masked = redactFreeText('核对 620005 138 1234 5679 已核');
  expect(masked).toBe(`核对 ${'*'.repeat(13)}5679 已核`);
  for (const plain of ['620005', '138', '1234']) expect(masked).not.toContain(plain);
  // 只有手机号、没有卡号时仍按 3 + 4（反例：并集不多遮手机号露出的位）。
  expect(redactFreeText('核对 138 1234 5679 已核')).toBe('核对 138****5679 已核');
});

it('[AC-B2-02ze-R4#3] money r2 第 3 条：邮箱按地址形状认——域名同一级中英混写、本地部分中英混写都整个认出', () => {
  // 原例：子域「财务mail」汉字与拉丁字母混写。
  const masked = redactFreeText('收款账号 alice@财务mail.example.cn 不符');
  expect(masked).toBe('收款账号 a***@***.cn 不符');
  for (const plain of ['alice', '财务mail', 'example']) expect(masked).not.toContain(plain);
  // 本地部分中英混写：整个认出，不只认 san。
  const mixed = redactFreeText('联系 张san@x.cn 核对');
  expect(mixed).toBe('联系 张***@***.cn 核对');
  expect(mixed).not.toContain('san');
  expect(redactFreeText('张san@x.cn')).toBe('张***@***.cn');
  expect(redactFreeText('a1@财务2部-mail.例子.中国')).toBe('a***@***.中国');
});

it('[AC-B2-02ze-R4#3] money r2 第 3 条 反例：@ 后在出现「.」之前碰到空白或中文标点的不当邮箱，「。」不当域名分隔', () => {
  const kept = '转给财务@张三处理。价格@3.5元，@所有人 请核对；写成 alice@例子。中国 的不认';
  expect(redactFreeText(kept)).toBe(kept);
});

// r5（D10-3166 ②，有限清单）：Codex money r3 三条 S0。错实现下怎么红见各条注释。
// 错实现（手机号左边界越过加号 / 86 前缀去看前面的字母）下，正例原样返回「WhatsApp+8613812345679」而红。
it('[AC-B2-02ze-R5#1] money r3 S0-1：带 + / ＋ / 86 前缀的手机号以前缀为左边界，紧邻的字母不阻止打码', () => {
  expect(redactFreeText('WhatsApp+8613812345679 待复核')).toBe('WhatsApp138****5679 待复核');
  expect(redactFreeText('WhatsApp＋8613812345679 待复核')).toBe('WhatsApp138****5679 待复核');
  expect(redactFreeText('WhatsApp8613812345679 待复核')).toBe('WhatsApp138****5679 待复核');
  expect(redactFreeText('tel+13812345678')).toBe('tel138****5678');
});

it('[AC-B2-02ze-R5#1] money r3 S0-1 反例：号码右边紧贴字母（单号里的一段）仍不当手机号', () => {
  const kept = '单号 SN8613812345679A，W2026112187654322ABC';
  expect(redactFreeText(kept)).toBe(kept);
});

// 错实现（顶级域名后紧跟 @ 即拒绝整个候选）下，正例原样返回 alice@example.cn 而红。
it('[AC-B2-02ze-R5#2] money r3 S0-2：顶级域名后紧跟 @ 时邮箱在 @ 前截止，前面的完整地址照常打码', () => {
  const masked = redactFreeText('收款邮箱 alice@example.cn@财务 请复核');
  expect(masked).toBe('收款邮箱 a***@***.cn@财务 请复核');
  expect(masked).not.toContain('alice');
  expect(masked).not.toContain('example');
  expect(redactFreeText('alice@例子.中国@财务')).toBe('a***@***.中国@财务');
});

it('[AC-B2-02ze-R5#2] money r3 S0-2 反例：单字母顶级域名后紧跟 @ 仍不当邮箱', () => {
  const kept = '写成 alice@example.c@财务 的不认';
  expect(redactFreeText(kept)).toBe(kept);
});

// 错实现（扫描不认全角 Ｘ，只把前 17 位交给识别器）下，正例原样返回全角证件号而红。
it('[AC-B2-02ze-R5#3] money r3 S0-3：全角数字加全角 Ｘ / ｘ 的 18 位证件号先归一再判，首 1 末 1', () => {
  expect(redactFreeText('证件号 １１０１０５１９４９１２３１００２Ｘ 不符')).toBe(
    '证件号 1****************X 不符',
  );
  expect(redactFreeText('１１０１０５１９４９１２３１００２ｘ')).toBe('1****************x');
});

it('[AC-B2-02ze-R5#3] money r3 S0-3 反例：全角写法但校验位错（应为 X，前 17 位末位改 3）的 18 位原样', () => {
  const kept = '证件号 １１０１０５１９４９１２３１００３Ｘ 不符';
  expect(redactFreeText(kept)).toBe(kept);
});
