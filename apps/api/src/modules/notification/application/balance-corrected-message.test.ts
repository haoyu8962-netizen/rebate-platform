// B2-02z unit tests of the pure BALANCE_CORRECTED renderer (no database).
import { expect, it } from 'vitest';
import {
  BALANCE_CORRECTED_CODE,
  renderBalanceCorrectedMessage,
} from './balance-corrected-message.ts';

const BODY = (before: string, after: string): string =>
  `核对账目时发现你的余额显示与流水明细不一致，已按流水明细更正：可提现余额由 ${before} 调整为 ${after}。如有疑问，请联系客服。`;

it('[AC-B2-02z#u1] default title and body, both amounts in the App format (negative with - before ¥, no +)', () => {
  expect(renderBalanceCorrectedMessage({ before_fen: 123_456n, after_fen: -150n }, null)).toEqual({
    code: BALANCE_CORRECTED_CODE,
    variant: 'default',
    category: 'service',
    title: '余额更正',
    body: BODY('¥1234.56', '-¥1.5'),
  });
  expect(renderBalanceCorrectedMessage({ before_fen: -1n, after_fen: 0n }, null)?.body).toBe(
    BODY('-¥0.01', '¥0'),
  );
});

it('[AC-B2-02z#u2] an unchanged available balance renders nothing, with or without an override', () => {
  const row = { title_override: 't', body_override: '{before}{after}' };
  expect(renderBalanceCorrectedMessage({ before_fen: 990n, after_fen: 990n }, null)).toBeNull();
  expect(renderBalanceCorrectedMessage({ before_fen: -5n, after_fen: -5n }, row)).toBeNull();
});

it('[AC-B2-02z#u3] override wording keeps $ patterns literal and replaces every variable; a null column falls back', () => {
  const row = { title_override: null, body_override: "$& {after} $1 {before} $$ {after} $'" };
  const message = renderBalanceCorrectedMessage({ before_fen: 1000n, after_fen: 990n }, row);
  expect(message?.title).toBe('余额更正');
  expect(message?.body).toBe("$& ¥9.9 $1 ¥10 $$ ¥9.9 $'");
  const titleOnly = { title_override: '余额已更正', body_override: null };
  expect(renderBalanceCorrectedMessage({ before_fen: 1n, after_fen: 2n }, titleOnly)).toMatchObject(
    {
      title: '余额已更正',
      body: BODY('¥0.01', '¥0.02'),
    },
  );
});
