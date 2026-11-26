// B2-02zg (claude-independent, SPEC_REF 1025764b; 写测 2 after rule-test review r1, four S1): 08 BR-ID-33
// 「接口…日志…不得出现明文」 on one free-text string, normalised first and then masked (编排 D10-3266; the
// rules are restated in ./normalize-then-mask.test.ts). This file adds what review r1 found missing:
//   S1-① line breaks are white space too (\n, \r, \r\n, U+2028, U+2029): a grouped long number split
//        over lines is still one run;
//   S1-② an e-mail address right next to Chinese (or ASCII) punctuation is masked in the 细则 shape,
//        the punctuation stays as written;
//   S1-③ the fallback's final x may be lower case (and written after a separator or full width): only
//        the last four characters show, as with X;
//   S1-④ the mapping back: a compatibility character NFKC expands into several digits is masked or kept
//        digit by digit of the normalised text (neither kept whole nor masked whole), and an e-mail's
//        kept characters, "@" and domain are the original characters at their original places.
// For a card, the fallback and grouped numbers the tests compare `squeezed` text (NFKC, white space and
// dashes taken out) and only ask which digits show, as in normalize-then-mask.test.ts. Function under
// test: redactFreeText (apps/api/src/modules/admin/infra/audit-redaction.ts). All samples are
// synthetic. Top-level it() only.
import { expect, it } from 'vitest';
import { redactFreeText } from '../../../../apps/api/src/modules/admin/infra/audit-redaction.ts';
import { squeezed } from './kit.ts';

/** `written` between 收款 and 已核, masked; its squeezed form must be 收款 + `shape` + 已核. */
function expectMasked(written: string, shape: string): string {
  const out = redactFreeText(`收款 ${written} 已核`);
  const message = `${JSON.stringify(written)} → ${JSON.stringify(out)}`;
  expect(squeezed(out), message).toMatch(new RegExp(`^收款${shape}已核$`, 'u'));
  return out;
}

/**
 * `before` + `local` + `domain` + `after` redacted: starts with `before` + `shown` and ends with
 * `domain` + `after` exactly as written (original characters, original places), with 「***」 (as
 * stars, half or full width) and nothing else in between.
 */
function expectEmail(
  before: string,
  local: string,
  domain: string,
  after: string,
  shown: string,
): void {
  const written = `${before}${local}${domain}${after}`;
  const out = redactFreeText(written);
  const head = `${before}${shown}`;
  const tail = `${domain}${after}`;
  const message = `${written} → ${out}`;
  expect(out.startsWith(head), message).toBe(true);
  expect(out.endsWith(tail), message).toBe(true);
  expect(out.length, message).toBeGreaterThanOrEqual(head.length + tail.length);
  expect(out.slice(head.length, out.length - tail.length).normalize('NFKC'), message).toBe('***');
}

it('[AC-B2-02zg#13] 归一 · 换行也是空白：\\n、\\r、\\r\\n、U+2028、U+2029 分隔的分组长数字照样连成一串判——过 Luhn 的卡号只留末 4、认不出的只留末四位、手机号 3+4、证件首 1 末 1；换行与空格、制表符、NBSP、横线混用同样；两行各不足 11 位、连起来 ≥ 11 位的按兜底只留末四位', () => {
  for (const lineBreak of ['\n', '\r', '\r\n', '\u{2028}', '\u{2029}']) {
    const label = JSON.stringify(lineBreak);
    const card = expectMasked(['6222', '0371', '9584', '7364'].join(lineBreak), '\\*+7364');
    expect(card, label).not.toContain('0371');
    const other = expectMasked(['6228', '4810', '3357', '2196'].join(lineBreak), '\\*+2196');
    expect(other, label).not.toContain('6228');
    expectMasked(['138', '1234', '5678'].join(lineBreak), '138\\*{4}5678');
    expectMasked(['110105', '19491231', '002X'].join(lineBreak), '1\\*{16}X');
    expectMasked(['20261121', '12345678'].join(lineBreak), '\\*+5678');
    expectMasked(['12345', '678901'].join(lineBreak), '\\*+8901');
  }
  // The review's own sample: a card wrapped by CR LF in the middle of its groups.
  const wrapped = redactFreeText('卡号 6222 0371\r\n9584 7364 已核');
  expect(squeezed(wrapped), wrapped).toMatch(/^卡号\*+7364已核$/u);
  expectMasked('6228 \r\n\t4810\u{2028}-3357\u{a0}\n2196', '\\*+2196');
  expectMasked('138 \n1234\r\n 5678', '138\\*{4}5678');
});

it('[AC-B2-02zg#14] 邮箱紧邻中文标点（，。、；：（）「」【】《》！？）或 ASCII 括号逗号：地址照样按细则形状打码（@ 前留前 2 位 +「***」、只有 2 位留 1 位、1 位不留，@ 与域名照常显示），标点不并进地址、原样保留', () => {
  for (const [written, masked] of [
    ['邮箱 alice@example.com，已核', '邮箱 al***@example.com，已核'],
    ['邮箱（alice@example.com）已核', '邮箱（al***@example.com）已核'],
    ['收款账号 alice@example.com。', '收款账号 al***@example.com。'],
    ['邮箱：alice@example.com；已核', '邮箱：al***@example.com；已核'],
    ['账号「alice@example.com」已核', '账号「al***@example.com」已核'],
    ['【bob.lee+refund@mail.corp.example.cn】已核', '【bo***@mail.corp.example.cn】已核'],
    ['《zhangsan@example.com》、备用', '《zh***@example.com》、备用'],
    ['确认 ab@x.com！', '确认 a***@x.com！'],
    ['是 a@x.com？', '是 ***@x.com？'],
    ['alice@example.com，bob@example.org。', 'al***@example.com，bo***@example.org。'],
    ['邮箱(alice@example.com),已核', '邮箱(al***@example.com),已核'],
    // 写测 3 (review r2, D10-3284): English text, ASCII punctuation right after the address.
    ['Confirmed alice@example.com.', 'Confirmed al***@example.com.'],
    ['Confirmed alice@example.com, thanks', 'Confirmed al***@example.com, thanks'],
    ['Account (alice@example.com) confirmed', 'Account (al***@example.com) confirmed'],
    ['Account "alice@example.com" confirmed', 'Account "al***@example.com" confirmed'],
  ] as const) {
    expect(redactFreeText(written), written).toBe(masked);
  }
});

it('[AC-B2-02zg#15] 兜底的末位小写 x：校验位错的 18 位证件号末位小写 x（连写、前带空格 / NBSP / 横线 / 分组、全角 ｘ）与大写 X 同样只留末四字符（003x）；认不出类型的 ≥ 11 位数字带末位 x 同样', () => {
  for (const [written, shape] of [
    ['11010519491231003x', '\\*+003x'],
    ['11010519491231003 x', '\\*+003x'],
    ['11010519491231003\u{a0}x', '\\*+003x'],
    ['11010519491231003-x', '\\*+003x'],
    ['1101 0519 4912 3100 3 x', '\\*+003x'],
    ['11010519491231003ｘ', '\\*+003x'],
    ['11010519491231003X', '\\*+003X'],
    ['11010519491231003 X', '\\*+003X'],
    ['123456789012x', '\\*+012x'],
    ['440301871345123x', '\\*+123x'],
  ] as const) {
    const out = expectMasked(written, shape);
    expect(out, written).not.toContain('1101051949');
  }
});

it('[AC-B2-02zg#16] 位置映射 · 兼容字符展开：打码按归一后的逐位判定——展开成几位数字的字符（⑩ ⑪ ⑫ ⑳）跨在打码区与保留区之间时既不整个保留也不整个遮掉，只露归一后的那几位；展开成多个字的字符（㍻ ㍿ ﬃ）在前时其后各处打码不错位', () => {
  // 2345678 + 10 + 123 = 12 digits: only 0123 shows; the 1 of ⑩ is masked, the 0 is kept.
  const ref = redactFreeText('参考号 2345678⑩123 已核');
  expect(ref.startsWith('参考号 ') && ref.endsWith(' 已核'), ref).toBe(true);
  expect(ref, ref).not.toContain('⑩');
  expect(squeezed(ref), ref).toMatch(/^参考号\*+0123已核$/u);
  // 1234567 + 12 + 123 = 12 digits: only 2123 shows.
  const run = redactFreeText('流水 1234567⑫123 已核');
  expect(run, run).not.toContain('⑫');
  expect(squeezed(run), run).toMatch(/^流水\*+2123已核$/u);
  // ⑳ wholly inside the masked part.
  const order = redactFreeText('订单 ⑳26112112345678 已核');
  expect(order, order).not.toContain('⑳');
  expect(squeezed(order), order).toMatch(/^订单\*+5678已核$/u);
  // ⑪ + 010519491231002X is the identity number 11010519491231002X: its first digit shows, the
  // second (the other half of ⑪) is one of the 16 stars.
  const id = redactFreeText('证件 ⑪010519491231002X 已核');
  expect(id, id).not.toContain('⑪');
  expect(squeezed(id), id).toMatch(/^证件1\*{16}X已核$/u);
  // Expansions of 2 to 4 characters before every mask: each mask lands where its number was written.
  expect(redactFreeText('ﬃ㍻㍿ 手机 13812345678，㍿㍿ 证件 11010519491231002X 已核')).toBe(
    `ﬃ㍻㍿ 手机 138****5678，㍿㍿ 证件 1${'*'.repeat(16)}X 已核`,
  );
  expect(redactFreeText('㍻㍿ 邮箱 alice@example.com，㍻ 手机 13900001111 已核')).toBe(
    '㍻㍿ 邮箱 al***@example.com，㍻ 手机 139****1111 已核',
  );
});

it('[AC-B2-02zg#17] 位置映射 · 邮箱回写不改原文字符：全角（或半角全角混写）的邮箱打码后，@ 前保留的字符、＠ / @ 与域名（含全角 ．）都是原文原位置上的字符，只把 @ 前其余部分换成「***」；@ 前只有 2 位、1 位时同细则', () => {
  expectEmail('收款账号 ', 'ａｌｉｃｅ', '＠ｅｘａｍｐｌｅ．ｃｏｍ', ' 已核', 'ａｌ');
  expectEmail('收款账号 ', 'zhangsan', '＠ｅｘａｍｐｌｅ.com', ' 已核', 'zh');
  expectEmail('收款账号 ', 'ｚｈａｎｇｓａｎ', '@example.com', ' 已核', 'ｚｈ');
  expectEmail('收款账号 ', 'ａｂ', '＠ｘ．ｃｏｍ', ' 已核', 'ａ');
  expectEmail('收款账号 ', 'ａ', '＠ｘ．ｃｏｍ', ' 已核', '');
  expectEmail('邮箱（', 'ａｌｉｃｅ．ｗ', '＠ｅｘａｍｐｌｅ．ｃｎ', '），已核', 'ａｌ');
});
