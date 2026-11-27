// B2-02zh (test-change, 编排 D10-3580; FU-B2-02ZG-SPEC-HYPHEN-LOCAL): 08 BR-ID-33 细则「审计自由文本里的邮箱
// 整段遮」— every run of non-white-space characters holding an "@" (half or full width ＠), from the
// Unicode white space before it (full-width space, NBSP, tab and line breaks included) or the start of the
// text to the white space after it or the end, becomes 「***」; no domain is shown. This file pins five
// boundary classes with hard-coded expected output: a hyphen or another Unicode dash glued to the left of
// the "@", a mobile number as the local part, an unrecognised domain glued to punctuation, and a tab as a
// run boundary. Function under test: redactFreeText (apps/api/src/modules/admin/infra/audit-redaction.ts).
// All samples are synthetic. Top-level it() only.
import { expect, it } from 'vitest';
import { redactFreeText } from '../../../../apps/api/src/modules/admin/infra/audit-redaction.ts';

function expectRedacted(samples: ReadonlyArray<readonly [string, string]>): void {
  for (const [written, masked] of samples) {
    expect(redactFreeText(written), JSON.stringify(written)).toBe(masked);
  }
}

it('[AC-B2-02zh#1] 邮箱整段遮 · @ 左侧紧贴 ASCII 横线：横线不是片段边界，含 @ 的片段从空白（或文本开头）到空白整段换成「***」，横线左边的文字一起遮', () => {
  // 错实现会怎样红：从 @ 往左扫时停在横线上，留下「收款账号 li-*** 已核」或「王小明-*** 已核」。
  expectRedacted([
    ['收款账号 li-wei@example.com 已核', '收款账号 *** 已核'],
    ['王小明-13812345678@qq.com 已核', '*** 已核'],
  ]);
});

it('[AC-B2-02zh#2] 邮箱整段遮 · @ 左侧紧贴减号 U+2212 或其他 Unicode 横线：同 ASCII 横线，不是片段边界，整段换成「***」', () => {
  // 错实现会怎样红：把 U+2212 当分隔（像数字分组那样）停下左扫，露出「备注−」或「li−」。
  expectRedacted([
    ['备注\u{2212}alice@example.com', '***'],
    ['收款账号 li\u{2212}wei@example.com 已核', '收款账号 *** 已核'],
  ]);
});

it('[AC-B2-02zh#3] 邮箱整段遮 · 本地部分是手机号：含 @ 的片段整段换成「***」，不先按手机号 3+4 遮', () => {
  // 错实现会怎样红：手机号规则先跑，输出「收款账号 138****5678@qq.com 已核」，域名照样露出。
  expectRedacted([['收款账号 13812345678@qq.com 已核', '收款账号 *** 已核']]);
});

it('[AC-B2-02zh#4] 邮箱整段遮 · 认不出的域名紧贴中文标点：片段一直到下一个空白或文本结尾，连「，已核」一起换成「***」；在文本结尾时同样整段遮', () => {
  // 错实现会怎样红：只认像域名的 @ 后缀，认不出「内网」就原样放过，或在「，」处截断留下「，已核」。
  expectRedacted([
    ['收款账号 bob.lee@内网，已核', '收款账号 ***'],
    ['联系 bob.lee@内网', '联系 ***'],
  ]);
});

it('[AC-B2-02zh#5] 邮箱整段遮 · 制表符是片段边界：@ 片段到制表符为止，制表符与其后文字原样保留', () => {
  // 错实现会怎样红：只认空格不认制表符，把「\t已核」一起吞掉，输出「备注 ***」。
  expectRedacted([['备注 alice@example.com\t已核', '备注 ***\t已核']]);
});
