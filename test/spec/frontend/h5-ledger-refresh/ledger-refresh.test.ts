// @vitest-environment jsdom
// F1-04d（D10-990 / D10-992 ②）：下拉刷新不先截断已加载页。刷新成功后才回到第一页并显示新数据；
// 刷新失败时原来已加载的全部页原样保留并出现页面已有的失败提示；翻页在途时刷新排队、不并发。
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import dictionary from '../../../../contracts/texts.default.json' with { type: 'json' };
import { ledgerTexts } from '../../../../apps/h5/src/texts/ledger.ts';
import {
  invite,
  inviteHint,
  ledgerServer,
  list,
  posting,
  reply,
} from '../h5-ledger/ledger-fixtures.ts';
import { amount, expectQuery, mount, pullDown, reachBottom } from '../h5-ledger/ledger-helpers.ts';
import { alertText, count, expectBefore, settle } from './refresh-helpers.ts';

// 第一页：邀请奖励 +10.01（带 hint），有下一页；第二页：+2.26；刷新后的第一页：+3.32。
const FIRST = /10\.01/;
const SECOND = /2\.26/;
const FRESH = /3\.32/;
const FRESH_NEXT = /4\.43/;

/** Mount and load two pages (first page, then the second by its cursor). */
async function twoPages(
  later: (n: number) => Response | Promise<Response>,
): Promise<{ http: ReturnType<typeof ledgerServer>; target: HTMLElement }> {
  const http = ledgerServer((_url, n) => {
    if (n === 1) return reply(list([invite], 'old-cursor'));
    if (n === 2) return reply(list([posting({ amount_fen: 226 })]));
    return later(n);
  });
  mount(http.api);
  await screen.findByText(inviteHint, { exact: false });
  const target = amount(/\+\s*[¥￥]\s*10\.01/);
  reachBottom(target);
  await waitFor(() => expect(count(SECOND)).toBe(1));
  expect(http.requests).toHaveLength(2);
  expectQuery(http.requests[1]!, 'old-cursor');
  return { http, target };
}

it('[F1-04d-REFRESH#1] 已加载两页时下拉刷新：请求在途期间两页都还在，成功后只剩新的第一页', async () => {
  const pending = Promise.withResolvers<Response>();
  const { http, target } = await twoPages((n) =>
    n === 3 ? pending.promise : reply(list([posting({ amount_fen: 443 })])),
  );
  pullDown(target);
  await waitFor(() => expect(http.requests).toHaveLength(3));
  expectQuery(http.requests[2]!);
  await settle();
  // 刷新还没回来：已加载的两页不能先被截掉。
  expect(count(SECOND), '刷新在途时第二页的流水须保留').toBe(1);
  expect(count(FIRST)).toBe(1);
  expectBefore(inviteHint, SECOND);
  expect(count(FRESH)).toBe(0);

  await act(async () => {
    pending.resolve(reply(list([posting({ amount_fen: 332 })], 'new-cursor')));
  });
  await waitFor(() => expect(count(FRESH)).toBe(1));
  await settle();
  // 成功后回到第一页：旧的两页都不在，只发了一次首页请求，没有提示。
  expect(count(inviteHint)).toBe(0);
  expect(count(FIRST)).toBe(0);
  expect(count(SECOND)).toBe(0);
  expect(count(FRESH_NEXT)).toBe(0);
  expect(http.requests).toHaveLength(3);
  expect(alertText()).toBe('');
  // 新的第一页的游标接着翻页。
  reachBottom(amount(/\+\s*[¥￥]\s*3\.32/));
  await waitFor(() => expect(count(FRESH_NEXT)).toBe(1));
  expect(http.requests).toHaveLength(4);
  expectQuery(http.requests[3]!, 'new-cursor');
});

it('[F1-04d-REFRESH#2] 已加载两页时下拉刷新失败：两页原有流水原样保留并出现刷新失败提示，重试成功后回到第一页', async () => {
  const { http, target } = await twoPages((n) =>
    n === 3 ? reply(null, 50001, 500) : reply(list([posting({ amount_fen: 332 })])),
  );
  pullDown(target);
  await waitFor(() => expect(http.requests).toHaveLength(3));
  expectQuery(http.requests[2]!);
  await waitFor(() => expect(alertText()).toContain(ledgerTexts.refreshFailed));
  await settle();
  // 失败：不截断、不清空，两页的流水都在且顺序不变；不自动重放。
  expect(count(SECOND), '刷新失败后第二页的流水须保留').toBe(1);
  expect(count(FIRST)).toBe(1);
  expect(count(inviteHint)).toBe(1);
  expectBefore(inviteHint, SECOND);
  expect(count(FRESH)).toBe(0);
  expect(alertText()).toContain(ledgerTexts.refreshFailed);
  expect(http.requests).toHaveLength(3);

  // 提示里的重试：再取第一页一次，成功后才替换为新的第一页，提示消失。
  const retry = screen.queryAllByRole('button', { name: ledgerTexts.retry });
  expect(retry).toHaveLength(1);
  await act(async () => {
    fireEvent.click(retry[0]!);
  });
  await waitFor(() => expect(count(FRESH)).toBe(1));
  await settle();
  expect(http.requests).toHaveLength(4);
  expectQuery(http.requests[3]!);
  expect(count(FIRST)).toBe(0);
  expect(count(SECOND)).toBe(0);
  expect(alertText()).toBe('');
});

it('[F1-04d-REFRESH#3] 已加载两页时下拉刷新回 10405：两页保留，沿用 error.10405 提示，不自动重放', async () => {
  const { http, target } = await twoPages(() => reply(null, 10405, 403));
  pullDown(target);
  await waitFor(() => expect(http.requests).toHaveLength(3));
  await waitFor(() => expect(alertText()).toContain(dictionary.texts['error.10405']));
  await settle();
  expect(count(SECOND), '刷新失败后第二页的流水须保留').toBe(1);
  expect(count(FIRST)).toBe(1);
  expectBefore(inviteHint, SECOND);
  expect(http.requests).toHaveLength(3);
});

it('[F1-04d-REFRESH#4] 翻页在途时下拉刷新排队：不并发，翻页回来后只刷新一次，刷新在途期间两页都在，成功后回到第一页', async () => {
  const more = Promise.withResolvers<Response>();
  const fresh = Promise.withResolvers<Response>();
  const http = ledgerServer((_url, n) => {
    if (n === 1) return reply(list([invite], 'old-cursor'));
    if (n === 2) return more.promise;
    if (n === 3) return fresh.promise;
    return reply(list([posting({ amount_fen: 443 })]));
  });
  mount(http.api);
  await screen.findByText(inviteHint, { exact: false });
  const target = amount(/\+\s*[¥￥]\s*10\.01/);
  reachBottom(target);
  await waitFor(() => expect(http.requests).toHaveLength(2));
  expectQuery(http.requests[1]!, 'old-cursor');
  // 翻页在途：两次下拉都不发请求。
  pullDown(target);
  pullDown(target);
  await settle();
  expect(http.requests).toHaveLength(2);

  await act(async () => {
    more.resolve(reply(list([posting({ amount_fen: 226 })])));
  });
  // 翻页回来后才发刷新，且只取第一页。
  await waitFor(() => expect(http.requests).toHaveLength(3));
  expectQuery(http.requests[2]!);
  await settle();
  expect(count(SECOND), '排队的刷新在途时刚翻出的第二页须保留').toBe(1);
  expect(count(FIRST)).toBe(1);
  expectBefore(inviteHint, SECOND);

  await act(async () => {
    fresh.resolve(reply(list([posting({ amount_fen: 332 })])));
  });
  await waitFor(() => expect(count(FRESH)).toBe(1));
  await settle();
  expect(count(FIRST)).toBe(0);
  expect(count(SECOND)).toBe(0);
  expect(http.requests).toHaveLength(3);
  expect(alertText()).toBe('');
});
