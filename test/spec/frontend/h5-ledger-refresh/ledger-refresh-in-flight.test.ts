// @vitest-environment jsdom
// F1-04d 测试第 2 轮（spec-test r1 S1）：刷新在途期间滚到底，不得拿旧游标翻页；
// 刷新成功后列表只有新的第一页，旧游标翻出的行不得混进来。
import { act, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
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

// 第一页：+10.01（游标 c1）；第二页：+2.26（游标 c2）；刷新后的第一页：+3.32（到底）；
// 任何多发的请求都回 +5.54，用来发现旧游标翻出的行。
const FIRST = /10\.01/;
const SECOND = /2\.26/;
const FRESH = /3\.32/;
const STALE = /5\.54/;

function cursors(requests: readonly Request[]): string[] {
  return requests.flatMap((request) => new URL(request.url).searchParams.getAll('cursor'));
}

it('[F1-04d-REFRESH#5] 已加载两页（游标 c1 / c2）时下拉刷新，刷新在途期间滚到底：不发 cursor=c2 的翻页，成功后只剩新的第一页', async () => {
  const fresh = Promise.withResolvers<Response>();
  const http = ledgerServer((_url, n) => {
    if (n === 1) return reply(list([invite], 'c1'));
    if (n === 2) return reply(list([posting({ amount_fen: 226 })], 'c2'));
    if (n === 3) return fresh.promise;
    return reply(list([posting({ amount_fen: 554 })]));
  });
  mount(http.api);
  await screen.findByText(inviteHint, { exact: false });
  const target = amount(/\+\s*[¥￥]\s*10\.01/);
  reachBottom(target);
  await waitFor(() => expect(count(SECOND)).toBe(1));
  expect(http.requests).toHaveLength(2);
  expectQuery(http.requests[1]!, 'c1');

  pullDown(target);
  await waitFor(() => expect(http.requests).toHaveLength(3));
  expectQuery(http.requests[2]!);
  await settle();
  // 刷新在途：两页都还在（第二页带着游标 c2，列表末尾仍可翻页）。
  expect(count(SECOND), '刷新在途时第二页的流水须保留').toBe(1);
  expect(count(FIRST)).toBe(1);
  expectBefore(inviteHint, SECOND);

  // 刷新在途期间滚到底：不得拿旧游标 c2 翻页，也不得发任何别的请求。
  reachBottom(amount(/\+\s*[¥￥]\s*2\.26/));
  await settle();
  expect(cursors(http.requests), '刷新在途时不得用旧游标翻页').not.toContain('c2');
  expect(http.requests).toHaveLength(3);

  await act(async () => {
    fresh.resolve(reply(list([posting({ amount_fen: 332 })])));
  });
  await waitFor(() => expect(count(FRESH)).toBe(1));
  await settle();
  // 成功后只有新的第一页：旧两页不在，旧游标翻出的行没有混进来，也没有补发 c2 翻页。
  expect(count(FIRST)).toBe(0);
  expect(count(SECOND)).toBe(0);
  expect(count(STALE), '旧游标翻出的行不得混进新列表').toBe(0);
  expect(cursors(http.requests)).toEqual(['c1']);
  expect(http.requests).toHaveLength(3);
  expect(alertText()).toBe('');
});
