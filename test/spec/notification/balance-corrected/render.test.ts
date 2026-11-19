// B2-02z render rules of BALANCE_CORRECTED (claude-independent; D10-2092 ⑤, D10-2093, D10-2115;
// contracts/openapi.yaml recalcBalanceAdminReconDiff「Member notice」; 08 BR-TEXT-10): default title
// 「余额更正」, default body verbatim with {before} / {after} formatted per BR-TEXT-10 (App format),
// sent for an increase and a decrease alike, none when the available balance is unchanged;
// operators may reword the title and body (notify_templates override) but not the variables; the
// message is always code BALANCE_CORRECTED, variant default, category service.
// Unit test, no database. The renderer is imported directly from its file (not through
// notification/index.ts). Expected texts come from ./texts.ts, written from the rules.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  BALANCE_CORRECTED_CODE,
  renderBalanceCorrectedMessage,
} from '../../../../apps/api/src/modules/notification/application/balance-corrected-message.ts';
import {
  AMOUNT_VECTORS,
  CODE,
  TEMPLATE,
  TEMPLATE_WITHDRAWABLE,
  TITLE,
  appYuan,
  bodyOf,
} from './texts.ts';

/** Integer fen well inside the PG bigint range, negatives included. */
const fen = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });
/** A before / after pair whose available balance changed. */
const changed = fc.tuple(fen, fen).filter(([before, after]) => before !== after);
/** Operator text without braces, with replacement-pattern lookalikes mixed in. */
const plain = fc.string({ maxLength: 12 }).filter((s) => !s.includes('{') && !s.includes('}'));
const dollar = fc.constantFrom('$&', '$1', '$$', '$`', "$'", '$<before>');
const piece = fc.array(fc.oneof(plain, dollar), { maxLength: 4 }).map((parts) => parts.join(''));
const title = piece.filter((s) => s.trim().length > 0);
/** A notify_templates override row (either column may be empty), or none. */
const override = fc.option(
  fc.record({ title_override: fc.option(title), body_override: fc.option(piece) }),
);

it('[AC-B2-02z#1] 默认标题「余额更正」；默认正文逐字为 D10-2092 的模板，{before} {after} 换成更正前后的可用余额', () => {
  expect(TEMPLATE).toBe(bodyOf('{before}', '{after}'));
  const decrease = { before_fen: 1000n, after_fen: 1n };
  expect(renderBalanceCorrectedMessage(decrease, null)).toEqual({
    code: 'BALANCE_CORRECTED',
    variant: 'default',
    category: 'service',
    title: '余额更正',
    body: '核对账目时发现你的余额显示与流水明细不一致，已按流水明细更正：可提现余额由 ¥10 调整为 ¥0.01。如有疑问，请联系客服。',
  });
  const increase = { before_fen: 990n, after_fen: 123_456n };
  expect(renderBalanceCorrectedMessage(increase, null)).toEqual({
    code: 'BALANCE_CORRECTED',
    variant: 'default',
    category: 'service',
    title: '余额更正',
    body: '核对账目时发现你的余额显示与流水明细不一致，已按流水明细更正：可提现余额由 ¥9.9 调整为 ¥1234.56。如有疑问，请联系客服。',
  });
}, 900_000);

// .each 标题不能改名，标题保留旧词；期望正文以块内断言为准（可提现余额，B2-02za / D10-2154）。
it.each(AMOUNT_VECTORS)(
  '[AC-B2-02z#2] %s：更正前 %s 分、更正后 %s 分 → 正文「…可用余额由 %s 调整为 %s。…」',
  (label, before, after, beforeText, afterText) => {
    const facts = { before_fen: before, after_fen: after };
    const message = renderBalanceCorrectedMessage(facts, null);
    expect(message, label).toEqual({
      code: CODE,
      variant: 'default',
      category: 'service',
      title: TITLE,
      body: TEMPLATE_WITHDRAWABLE.replace('{before}', beforeText).replace('{after}', afterText),
    });
    // '-' sits before '¥'; never a '+', never a thousands separator, never 「¥-」.
    expect(message?.body, label).not.toContain('+');
    expect(message?.body, label).not.toContain(',');
    expect(message?.body, label).not.toContain('¥-');
  },
  900_000,
);

it('[AC-B2-02z#2] 任意更正前后金额（调增、调减、正负、0）：默认正文按 BR-TEXT-10 App 写法格式化两个金额', () => {
  fc.assert(
    fc.property(changed, ([before, after]) => {
      const facts = { before_fen: before, after_fen: after };
      expect(renderBalanceCorrectedMessage(facts, null)).toEqual({
        code: CODE,
        variant: 'default',
        category: 'service',
        title: TITLE,
        body: TEMPLATE_WITHDRAWABLE.replace('{before}', appYuan(before)).replace(
          '{after}',
          appYuan(after),
        ),
      });
      return true;
    }),
    propParams(),
  );
}, 900_000);

it('[AC-B2-02z#3] 更正前后可用余额相等 → 不发（null），有覆盖行也一样', () => {
  const reworded = {
    title_override: '余额已更正',
    body_override: '余额由 {before} 改为 {after}',
  };
  for (const same of [0n, 1n, -1n, 990n, -150n, 2_000_000n]) {
    const facts = { before_fen: same, after_fen: same };
    expect(renderBalanceCorrectedMessage(facts, null)).toBeNull();
    expect(renderBalanceCorrectedMessage(facts, reworded)).toBeNull();
  }
  fc.assert(
    fc.property(fen, override, (same, row) => {
      const facts = { before_fen: same, after_fen: same };
      expect(renderBalanceCorrectedMessage(facts, row)).toBeNull();
      return true;
    }),
    propParams(),
  );
}, 900_000);

it('[AC-B2-02z#4] 覆盖行：标题与正文换成运营的措辞，正文里的 {before} {after} 照样替换（顺序可换、出现几次换几次）', () => {
  const first = {
    title_override: '余额已更正',
    body_override: '可用余额：{before} → {after}',
  };
  expect(renderBalanceCorrectedMessage({ before_fen: 500n, after_fen: -1234n }, first)).toEqual({
    code: CODE,
    variant: 'default',
    category: 'service',
    title: '余额已更正',
    body: '可用余额：¥5 → -¥12.34',
  });
  const second = {
    title_override: '余额更正通知',
    body_override: '现为 {after}（原 {before}）；再说一遍：{after}',
  };
  expect(renderBalanceCorrectedMessage({ before_fen: -150n, after_fen: 600n }, second)).toEqual({
    code: CODE,
    variant: 'default',
    category: 'service',
    title: '余额更正通知',
    body: '现为 ¥6（原 -¥1.5）；再说一遍：¥6',
  });
}, 900_000);

it('[AC-B2-02z#4] 覆盖正文里的 $&、$1、$$ 等字符照字面输出，不当替换模式', () => {
  const literal = {
    title_override: '余额 $& 更正',
    body_override: "$& 由 {before} $1 到 {after} $$ $` $'",
  };
  expect(renderBalanceCorrectedMessage({ before_fen: 1000n, after_fen: 1n }, literal)).toEqual({
    code: CODE,
    variant: 'default',
    category: 'service',
    title: '余额 $& 更正',
    body: "$& 由 ¥10 $1 到 ¥0.01 $$ $` $'",
  });
  fc.assert(
    fc.property(changed, title, piece, piece, piece, ([before, after], t, a, b, c) => {
      const facts = { before_fen: before, after_fen: after };
      const row = { title_override: t, body_override: `${a}{before}${b}{after}${c}` };
      expect(renderBalanceCorrectedMessage(facts, row)).toEqual({
        code: CODE,
        variant: 'default',
        category: 'service',
        title: t,
        body: `${a}${appYuan(before)}${b}${appYuan(after)}${c}`,
      });
      return true;
    }),
    propParams(),
  );
}, 900_000);

it('[AC-B2-02z#4] 只覆盖标题时正文用默认，只覆盖正文时标题用默认，两项都为空即全用默认', () => {
  const facts = { before_fen: 500n, after_fen: -1234n };
  const titleOnly = { title_override: '余额已更正', body_override: null };
  expect(renderBalanceCorrectedMessage(facts, titleOnly)).toEqual({
    code: CODE,
    variant: 'default',
    category: 'service',
    title: '余额已更正',
    body: TEMPLATE_WITHDRAWABLE.replace('{before}', '¥5').replace('{after}', '-¥12.34'),
  });
  const bodyOnly = { title_override: null, body_override: '可用余额 {before} → {after}' };
  expect(renderBalanceCorrectedMessage(facts, bodyOnly)).toEqual({
    code: CODE,
    variant: 'default',
    category: 'service',
    title: TITLE,
    body: '可用余额 ¥5 → -¥12.34',
  });
  const neither = { title_override: null, body_override: null };
  expect(renderBalanceCorrectedMessage(facts, neither)).toEqual({
    code: CODE,
    variant: 'default',
    category: 'service',
    title: TITLE,
    body: TEMPLATE_WITHDRAWABLE.replace('{before}', '¥5').replace('{after}', '-¥12.34'),
  });
}, 900_000);

it('[AC-B2-02z#5] 编码恒为 BALANCE_CORRECTED、变体 default、category 恒为 service（调增、调减、有无覆盖都一样）', () => {
  expect(BALANCE_CORRECTED_CODE).toBe('BALANCE_CORRECTED');
  fc.assert(
    fc.property(changed, override, ([before, after], row) => {
      const facts = { before_fen: before, after_fen: after };
      const message = renderBalanceCorrectedMessage(facts, row);
      expect(message).not.toBeNull();
      expect(message?.code).toBe('BALANCE_CORRECTED');
      expect(message?.variant).toBe('default');
      expect(message?.category).toBe('service');
      return true;
    }),
    propParams(),
  );
}, 900_000);
