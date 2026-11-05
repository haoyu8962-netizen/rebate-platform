// B2-12c render rules of BALANCE_ADJUSTED (claude-independent): BR-TEXT-19 站内信（只在调减时发送；
// 「你的余额调减 {amount}，原因：{adjust_reason}。如有疑问，请联系客服。」；{amount} 为调整金额绝对值，按
// BR-TEXT-10 格式化含 ¥；{adjust_reason} 取「ADMIN_ADJUST 原因码文案」名称；调增不另发）, title
// inbox.title.BALANCE_ADJUSTED「余额调整」(contracts/texts.default.json); 运营可改措辞，变量不得改
// (notify_templates override, as the other inbox renderers). Unit test: no database. Expected texts
// are written out from the rules, never from the code.
import { expect, it } from 'vitest';
import { renderBalanceAdjustedMessage } from '../../../../apps/api/src/modules/notification/application/balance-adjusted-message.ts';

const TAIL = '。如有疑问，请联系客服。';

const DECREASES: [bigint, string, string][] = [
  [120n, 'RECON_FIX', `你的余额调减 ¥1.2，原因：结算核对更正${TAIL}`],
  [10_000n, 'PAYOUT_RECOVERY', `你的余额调减 ¥100，原因：重复到账追回${TAIL}`],
  [5n, 'OTHER', `你的余额调减 ¥0.05，原因：人工调账${TAIL}`],
  [123_456n, 'RECON_FIX', `你的余额调减 ¥1234.56，原因：结算核对更正${TAIL}`],
  [1n, 'PAYOUT_RECOVERY', `你的余额调减 ¥0.01，原因：重复到账追回${TAIL}`],
];

it.each(DECREASES)(
  '[AC-B2-12c#35] 调减 %s 分（%s）→ 站内信 BALANCE_ADJUSTED「余额调整」：%s',
  (amount, reason, body) => {
    expect(
      renderBalanceAdjustedMessage(
        { direction: 'decrease', amount_fen: amount, reason_code: reason },
        null,
      ),
    ).toEqual({
      code: 'BALANCE_ADJUSTED',
      variant: 'default',
      category: 'service',
      title: '余额调整',
      body,
    });
  },
);

it.each(['RECON_FIX', 'PAYOUT_RECOVERY', 'OTHER'])(
  '[AC-B2-12c#36] 调增（%s）不发站内信：null',
  (reason) => {
    expect(
      renderBalanceAdjustedMessage(
        { direction: 'increase', amount_fen: 500n, reason_code: reason },
        null,
      ),
    ).toBeNull();
  },
);

it('[AC-B2-12c#37] 运营改过的标题与正文照用，正文里的 {amount}、{adjust_reason} 照样替换', () => {
  expect(
    renderBalanceAdjustedMessage(
      { direction: 'decrease', amount_fen: 120n, reason_code: 'RECON_FIX' },
      { title_override: '余额变动提醒', body_override: '{adjust_reason}：余额减少 {amount}' },
    ),
  ).toEqual({
    code: 'BALANCE_ADJUSTED',
    variant: 'default',
    category: 'service',
    title: '余额变动提醒',
    body: '结算核对更正：余额减少 ¥1.2',
  });
});
