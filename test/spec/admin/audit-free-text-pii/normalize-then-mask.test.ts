// B2-02zg (claude-independent, SPEC_REF 1025764b; takes over B2-02ze): 08 BR-ID-33 「接口…日志…不得
// 出现明文」 on one free-text string of an audited operation, as redesigned by 编排 D10-3266
// (D10-2328 / D10-2354 / D10-2384 「单号 / 参考号在自由文本里保持原样」 are void): normalise first, then
// mask.
//   1. Normalise: Unicode NFKC; every dash / minus (U+2212 included) and every white space (NBSP,
//      U+202F, ideographic space, tab included) is one separator; `/ . , _` are no separators.
//   2. Recognised types keep the BR-ID-33 default shapes: mobile 3 + 4 (138****5678, also written
//      with +86 / 86), identity number first 1 + last 1 (18 with X / x, 15), card only its last four.
//   3. "@" (写测 5, 负责人 2026-11-27 15:00, 编排 D10-3479 / D10-3481; supersedes 写测 4's 「@ 与认得出的
//      域名照常显示」, and the 细则 two-character shape stays for structured payout fields only): every
//      run of non-white-space characters holding an "@" (full-width ＠ included, judged after NFKC)
//      becomes 「***」 whole, from the white space before it or the start of the text to the white
//      space after it or the end, whatever is on either side of the "@" — no domain is shown, a lone
//      "@" is a run of its own, digits in the run go with it. White space is every Unicode white
//      space (line breaks included). Runs without "@" as before.
//   4. Anything else: separators taken out, a run of 11 or more digits (maybe a final X / x) shows
//      only its last four — no Luhn, check character or boundary test. Fewer than 11 digits stay.
//   5. Masks are decided on the normalised text and mapped back character by character: what is
//      neither a digit nor a separator in the original stays as written.
// Structured fields (order_id, idempotency_key, *_fen, card_ref, out_refund_no, withdrawal_id,
// target) stay as they are.
// BR-ID-33 fixes the star count only for the mobile number and the identity number; for a card and
// the fallback, and for what becomes of separators inside a masked run and of the kept digits'
// width, the tests compare `squeezed` text (NFKC, white space and dashes taken out) and only ask which
// digits show. Functions under test: redactFreeText, redactSnapshot (apps/api/src/modules/admin/
// infra/audit-redaction.ts). All samples are synthetic. Top-level it() only.
import { expect, it } from 'vitest';
import {
  redactFreeText,
  redactSnapshot,
} from '../../../../apps/api/src/modules/admin/infra/audit-redaction.ts';
import { squeezed } from './kit.ts';

/** `written` between 收款 and 已核, masked; its squeezed form must be 收款 + `shape` + 已核. */
function expectMasked(written: string, shape: string): string {
  const out = redactFreeText(`收款 ${written} 已核`);
  expect(squeezed(out), `${written} → ${out}`).toMatch(new RegExp(`^收款${shape}已核$`, 'u'));
  return out;
}

it('[AC-B2-02zg#1] 兜底：认不出类型的去分隔连续 ≥ 11 位数字（含末位 X）一律只留末四位——订单号、参考号、12 位与 11 位非手机号、不过 Luhn 的卡形串、20 位参考号（连写与分组）、带字母前缀 / 后缀单号里的长数字段、校验位错的证件号、日期不合法的 15 位号、去横线后的 UUID 长数字', () => {
  for (const [written, shape] of [
    ['2026112112345678', '\\*+5678'],
    ['8427359012345', '\\*+2345'],
    ['123456789017', '\\*+9017'],
    ['12345678901', '\\*+8901'],
    ['6013829475610384726', '\\*+4726'],
    ['6228 4810 3357 2196', '\\*+2196'],
    ['6222037195847365', '\\*+7365'],
    ['62220371958473641230', '\\*+1230'],
    ['6222 0371 9584 7364 1230', '\\*+1230'],
    ['WD2026112100001234', 'WD\\*+1234'],
    ['taobao:2026112187654322', 'taobao:\\*+4322'],
    ['W2026112187654322ABC', 'W\\*+4322ABC'],
    ['320106198508164523', '\\*+4523'],
    ['11010519491231003X', '\\*+003X'],
    ['440301871345123', '\\*+5123'],
    ['12345678-1234-1234-1234-123456789012', '\\*+9012'],
    ['019a0000-0000-7000-8000-000000000001', '019a\\*+0001'],
  ] as const) {
    const out = expectMasked(written, shape);
    expect(out, written).not.toContain(written);
  }
});

it('[AC-B2-02zg#2] 只有空白与横线算分隔：「/ . , _」隔开的数字不连成一串，每段 < 11 位原样；< 11 位的数字串（含空白连起来仍 < 11 位、全角）原样；空白把两段连成 ≥ 11 位时按兜底只留末四位', () => {
  const kept = [
    '6222/0371/9584/7364',
    '6222.0371.9584.7364',
    '6222,0371,9584,7364',
    '6222_0371_9584_7364',
    '1234567890/1234567890',
    '1234567890.1234567890',
    '1234567890,1234567890',
    '1234567890_1234567890',
    '1234567890',
    '12345 67890',
    '１２３４５６７８９０',
    '2026-11-21 10:30',
    '2026-11-21T02:00:00.000Z',
    'taobao:1234567',
    'W20261121ABC',
    'c0ffee00-b2b2-4d2e-9a2e-5f1a2b3c4d5e',
  ];
  for (const written of kept) {
    expect(redactFreeText(`收款 ${written} 已核`), written).toBe(`收款 ${written} 已核`);
  }
  // A slash stops the run, a space does not: 0371 9584 7364 is one run of 12 digits.
  expectMasked('6222/0371 9584 7364', '6222/\\*+7364');
  expectMasked('1234567890 1', '\\*+8901');
});

it('[AC-B2-02zg#3] 认得出类型的按 BR-ID-33 默认形状：手机号 3+4（含 +86 / 86 前缀与分组）、身份证首 1 末 1（18 位末位 X / x / 数字、15 位）、银行卡只留末 4；含 @ 的邮箱片段从空白到空白整段换成「***」，@ 与域名都不显示', () => {
  // What becomes of a +86 / 86 prefix is not fixed by BR-ID-33; the number itself is 3 + 4.
  const mobile = '\\+?(?:86)?138\\*{4}5678';
  for (const [written, shape] of [
    ['13812345678', '138\\*{4}5678'],
    ['138 1234 5678', '138\\*{4}5678'],
    ['138-1234-5678', '138\\*{4}5678'],
    ['+86 138 1234 5678', mobile],
    ['+8613812345678', mobile],
    ['8613812345678', mobile],
    ['11010519491231002X', '1\\*{16}X'],
    ['11010519491231002x', '1\\*{16}x'],
    ['110105199003071239', '1\\*{16}9'],
    ['110105491231002', '1\\*{13}2'],
    ['6222 0371 9584 7364', '\\*+7364'],
    ['6217003816629349051', '\\*+9051'],
    ['5903182647057', '\\*+7057'],
  ] as const) {
    const out = expectMasked(written, shape);
    expect(out, written).not.toContain(written);
  }
  for (const address of [
    'alice.w@example.com',
    'bob.lee+refund@mail.corp.example.cn',
    'zhangsan@example.com',
  ]) {
    const out = redactFreeText(`收款账号 ${address} 已核`);
    expect(out, address).toBe('收款账号 *** 已核');
    expect(out, address).not.toContain('example');
  }
});

it('[AC-B2-02zg#4] 含 @ 的片段整段遮：不论 @ 前几位（2 位、1 位、大小写与下划线）、@ 后像不像域名，都从空白到空白整段换成「***」、域名不显示；@ 一侧是空白或 @ 两侧不是邮箱（@张三、单独的 @、价格@3.5元、全角 ＠）同样整段遮，单独的 @ 自成一段；片段里的数字（含手机号）随整段一起遮', () => {
  for (const [address, plains] of [
    ['ab@x.com', ['ab', 'x.com']],
    ['a@x.com', ['x.com']],
    ['Carol_Z@Example.ORG', ['Carol_Z', 'Example.ORG']],
    ['alice@localhost', ['alice', 'localhost']],
    ['bob.lee@内网', ['bob.lee', '内网']],
  ] as const) {
    const out = redactFreeText(`收款账号 ${address} 已核`);
    expect(out, address).toBe('收款账号 *** 已核');
    for (const plain of plains) expect(out, address).not.toContain(plain);
  }
  // 编排 D10-3481, taken literally: no "@" is left as written, whatever is on either side of it.
  for (const [written, masked] of [
    ['请 @张三 处理', '请 *** 处理'],
    ['ops @ team', 'ops *** team'],
    ['价格@3.5元', '***'],
    ['@ 符号单独出现', '*** 符号单独出现'],
    ['请 ＠张三 处理', '请 *** 处理'],
    ['请 @张三 处理，ops @ team，@ 符号单独出现', '请 *** 处理，ops *** *** 符号单独出现'],
    ['联系 13812345678@example.com 已核', '联系 *** 已核'],
    ['手机13812345678@备注', '***'],
  ] as const) {
    expect(redactFreeText(written), written).toBe(masked);
  }
});

it('[AC-B2-02zg#5] 归一 · 全角：全角数字的手机号、证件号（含全角 Ｘ）、订单号先 NFKC 再判，形状同半角；全角字母加全角 ＠ 的邮箱归一后认出 @，整段换成「***」、全角域名不显示', () => {
  const phone = redactFreeText('手机 １３８１２３４５６７８ 已核');
  expect(phone.normalize('NFKC')).toBe('手机 138****5678 已核');
  const id = redactFreeText('证件 １１０１０５１９４９１２３１００２Ｘ 已核');
  expect(id.normalize('NFKC')).toBe(`证件 1${'*'.repeat(16)}X 已核`);
  expectMasked('２０２６１１２１１２３４５６７８', '\\*+5678');
  const email = redactFreeText('收款账号 ｚｈａｎｇｓａｎ＠ｅｘａｍｐｌｅ．ｃｏｍ 已核');
  expect(email.normalize('NFKC')).toBe('收款账号 *** 已核');
  expect(email).not.toContain('ｈａｎｇｓａｎ');
  expect(email).not.toContain('ｚｈ');
  expect(email).not.toContain('＠');
  expect(email).not.toContain('ｅｘａｍｐｌｅ');
});

it('[AC-B2-02zg#6] 归一 · 横线：U+2212 减号与其他横线（‐ ‑ ‒ – — ― ﹣ －）当分隔，分组的长数字连成一串判；连续、混用的分隔同样', () => {
  const groups = ['6228', '4810', '3357', '2196'];
  for (const dash of [
    '\u{2212}',
    '-',
    '\u{2010}',
    '\u{2011}',
    '\u{2012}',
    '\u{2013}',
    '\u{2014}',
    '\u{2015}',
    '\u{fe63}',
    '\u{ff0d}',
  ]) {
    const out = expectMasked(groups.join(dash), '\\*+2196');
    expect(out, JSON.stringify(dash)).not.toContain('6228');
  }
  // The card (Luhn) the same way: only its last four.
  expectMasked('6222\u{2212}0371\u{2212}9584\u{2212}7364', '\\*+7364');
  expectMasked('138\u{2212}1234\u{2212}5678', '138\\*{4}5678');
  expectMasked('6228 \u{2212} 4810\u{2014}\u{2013}3357\u{2212}\u{2212}2196', '\\*+2196');
});

it('[AC-B2-02zg#7] 归一 · 空白：NBSP U+00A0、U+202F、全角空格 U+3000、制表符当分隔，连续、混用同样', () => {
  for (const space of ['\u{a0}', '\u{202f}', '\u{3000}', '\t', ' ']) {
    const out = expectMasked(['6228', '4810', '3357', '2196'].join(space), '\\*+2196');
    expect(out, JSON.stringify(space)).not.toContain('6228');
  }
  expectMasked('6228\u{a0}\u{202f}4810\t\u{3000}3357 \u{a0}2196', '\\*+2196');
  expectMasked('138\u{a0}1234\u{3000}5678', '138\\*{4}5678');
  expectMasked('110105\u{202f}19491231\u{a0}002X', '1\\*{16}X');
});

it('[AC-B2-02zg#8] 归一 · 证件末位 X 前带空白：去分隔后与前 17 位连成 18 位判，校验位对的首 1 末 1，错的按兜底只留末四位（含 X）', () => {
  expectMasked('11010519491231002 X', '1\\*{16}X');
  expectMasked('11010519491231002\u{a0}x', '1\\*{16}x');
  expectMasked('1101 0519 4912 3100 2 X', '1\\*{16}X');
  expectMasked('11010519491231003 X', '\\*+003X');
});

it('[AC-B2-02zg#9] 归一 · 手机号紧跟或紧接「-备注」：横线是分隔，不挡手机号的边界，照样 3+4，「备注」原样', () => {
  for (const [written, shape] of [
    ['13812345678-备注', '138\\*{4}5678备注'],
    ['13812345678\u{2014}备注', '138\\*{4}5678备注'],
    ['备注-13812345678', '备注138\\*{4}5678'],
    ['+86-138-1234-5678-备注', '\\+?(?:86)?138\\*{4}5678备注'],
  ] as const) {
    const out = expectMasked(written, shape);
    expect(out, written).toContain('备注');
    expect(out, written).not.toContain('1234');
  }
});

it('[AC-B2-02zg#10] 位置映射：NFKC 展开的兼容字符（㎡ ㎏ ① Ⅻ ﬁ … ™）与全角标点在原文里原样保留，其后的打码落在原来的位置上，不错位', () => {
  const out = redactFreeText(
    '规格 ㎡㎏①Ⅻ：证件 11010519491231002X，手机 13812345678，' +
      '邮箱 zhangsan@example.com 已核，参考号 8427359012345。',
  );
  expect(out).toMatch(
    /^规格 ㎡㎏①Ⅻ：证件 1\*{16}X，手机 138\*{4}5678，邮箱 \*{3} 已核，参考号 \*+2345。$/u,
  );
  expect(redactFreeText('（备注：面积120㎡，手机13812345678）')).toBe(
    '（备注：面积120㎡，手机138****5678）',
  );
  const ligature = redactFreeText('ﬁle…™ 卡 6228 4810 3357 2196 已核');
  expect(ligature.startsWith('ﬁle…™ 卡'), ligature).toBe(true);
  expect(squeezed(ligature)).toMatch(/^file\.\.\.TM卡\*+2196已核$/u);
  expect(redactFreeText('①号单 2026112112345678 已核')).toMatch(/^①号单 \*+5678 已核$/u);
});

it('[AC-B2-02zg#11] 结构化字段（order_id、idempotency_key、*_fen、card_ref、out_refund_no、withdrawal_id、target）照旧原样，不走自由文本规则；同一份快照里的 reason / note / remarks 按兜底只留末四位', () => {
  const id = '019a0000-0000-7000-8000-000000000001';
  const out = redactSnapshot({
    reason: '订单 2026112112345678 已核',
    note: { detail: '参考号 8427359012345' },
    remarks: [8427359012345],
    order_id: '2026112112345678',
    idempotency_key: '2026112109876549',
    card_ref: '6222037195847364',
    out_refund_no: 'RF2026112187654322',
    withdrawal_id: id,
    target: `withdrawals:${id}`,
    amount_fen: -1_234_567_890_123,
    refund_fen: '98765432109876',
  }) as Record<string, unknown>;
  expect(out).toMatchObject({
    order_id: '2026112112345678',
    idempotency_key: '2026112109876549',
    card_ref: '6222037195847364',
    out_refund_no: 'RF2026112187654322',
    withdrawal_id: id,
    target: `withdrawals:${id}`,
    amount_fen: -1_234_567_890_123,
    refund_fen: '98765432109876',
  });
  expect(squeezed(String(out.reason))).toMatch(/^订单\*+5678已核$/u);
  expect(squeezed(String((out.note as Record<string, unknown>).detail))).toMatch(
    /^参考号\*+2345$/u,
  );
  expect(String((out.remarks as unknown[])[0])).toMatch(/^\*+2345$/);
});
