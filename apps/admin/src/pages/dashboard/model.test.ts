import { expect, it } from 'vitest';
import { beijingDateTime, beijingYesterday, formatCount, isConsoleRoute, toView } from './model.ts';

const answer = () => ({
  todo: [
    { key: 'withdraw_review_pending', count: 1200, route: '/withdrawals?status=pending' },
    {
      key: 'claim_review_pending',
      count: 3,
      route: '/orders/claims',
      oldest_at: null,
      breakdown: [
        { key: 'manual_review', count: 3 },
        { key: 'later', count: 0 },
      ],
    },
    { key: 'not_yet_known', count: 1, route: '/x' },
    { key: 'recon_diff_open', count: 1, route: 'https://example.com/recon' },
  ],
  yesterday: {
    date: '2026-10-11',
    links: 1,
    orders: 2,
    est_rebate_fen: 100,
    new_users: 3,
    as_of: '2026-10-11T22:00:00Z',
  },
});

it('[F1-14a] formats counts, Beijing times and rejects routes leaving the console', () => {
  expect(formatCount(1234567)).toBe('1,234,567');
  expect(formatCount(0)).toBe('0');
  expect(beijingDateTime('2026-09-30T16:07:00Z')).toBe('2026-10-01 00:07');
  expect(beijingDateTime('not a date')).toBe('not a date');
  expect(isConsoleRoute('/risk/appeals?status=pending')).toBe(true);
  for (const route of ['//evil.example', 'https://evil.example', 'relative', '/a\\b', 1])
    expect(isConsoleRoute(route)).toBe(false);
});

it('[F1-14a] keeps known cards in order, ignores unknown keys and unsafe routes, formats money', () => {
  const view = toView(answer());
  const { todo: cards } = view;
  expect(cards.map((card) => card.key)).toEqual([
    'withdraw_review_pending',
    'claim_review_pending',
  ]);
  expect(cards[0]!.detail).toBeUndefined();
  expect(cards[1]!.detail).toBe('人工审核中 3');
  expect(view.yesterday?.rebate).toBe('¥1.00');
  expect(view.yesterday?.day).toBe('10-11');
  expect(view.yesterday?.asOf).toBe('2026-10-12 06:00');
  expect(view.status).toBeUndefined();
});

it('[F1-14a] rejects malformed answers and non-integer amounts', () => {
  expect(() => toView(null)).toThrow();
  expect(() => toView({ todo: [] })).toThrow();
  expect(() => toView({ todo: [], yesterday: 'none' })).toThrow();
  expect(() => toView({ ...answer(), yesterday: { date: '2026-10-11' } })).toThrow();
  const fractional = answer();
  fractional.yesterday.est_rebate_fen = 1.5;
  expect(() => toView(fractional)).toThrow();
  expect(() => toView({ ...answer(), status: { payout_queue_paused: 'no' } })).toThrow();
});

it('[CT-24zzk] a null yesterday (no aggregate row yet) is a valid answer with no overview', () => {
  const { todo: cards, yesterday } = toView({ ...answer(), yesterday: null });
  expect(yesterday).toBeNull();
  expect(cards).toHaveLength(2);
});

it('[CT-24zzk] yesterday is the +08:00 accounting day before the instant', () => {
  // 2026-10-12 00:30 in Beijing, still 10-11 in UTC.
  expect(beijingYesterday(Date.parse('2026-10-11T16:30:00Z'))).toBe('2026-10-11');
  expect(beijingYesterday(Date.parse('2026-10-11T15:59:59Z'))).toBe('2026-10-10');
  expect(beijingYesterday(Date.parse('2026-03-01T00:00:00Z'))).toBe('2026-02-28');
});
