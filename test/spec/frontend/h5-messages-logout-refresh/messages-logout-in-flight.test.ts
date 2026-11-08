// @vitest-environment jsdom
// F1-04e（FU-H5-MESSAGES-LOGOUT-QUEUED-REFRESH，照 F1-04d）：下拉刷新在途时退出登录，响应随后返回，
// 页面自己作废这次刷新：不写回缓存、不出提示。只挂消息页，退出登录照壳层对缓存与页面树做的两步
// （作废当前代并取消、清空全部查询，再撤下页面）；API 会话不作废，让响应照常回到页面，
// 只核页面这一层（壳层的 API 会话作废另有 F1-01s 的规则测试）。
import { act, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { list, message, messagesServer, reply } from '../h5-messages/messages-fixtures.ts';
import {
  alertText,
  cachedText,
  expectFirstPage,
  held,
  mountPage,
  pullDown,
  settle,
} from './logout-refresh-helpers.ts';

it('[F1-04e-LOGOUT#3] 下拉刷新在途时退出登录，刷新的响应随后返回：不写回缓存、不出提示、不再发请求', async () => {
  const old = message({ body: '退出前已加载的消息' });
  const fresh = message({ body: '退出后才返回的刷新结果' });
  const stale = message({ body: '退出后多发请求取到的消息' });
  const refreshed = held(reply(list([fresh], 'c9')));
  const http = messagesServer({
    list: (_url, n) => {
      if (n === 1) return reply(list([old], 'c1'));
      if (n === 2) return refreshed.promise;
      return reply(list([stale]));
    },
  });
  const page = mountPage(http.api!);
  await screen.findByText(old.body, { exact: false });
  await settle();

  pullDown(screen.getByText(old.body, { exact: false }));
  await waitFor(() => expect(http.listRequests()).toHaveLength(2));
  expectFirstPage(http.listRequests()[1]!);
  await settle();

  // 退出登录，随后刷新的响应才回来。
  page.logout();
  await settle();
  expect(cachedText(page.client), '退出登录时缓存已清空').not.toContain(old.body);
  await act(async () => {
    refreshed.resolve(reply(list([fresh], 'c9')));
  });
  await settle();

  const cached = cachedText(page.client);
  expect(cached, '退出登录后返回的刷新结果不得写回缓存').not.toContain(fresh.body);
  expect(cached).not.toContain(old.body);
  expect(cached).not.toContain(stale.body);
  expect(
    page.client
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.data !== undefined),
    '退出登录后缓存里不得有任何带数据的查询',
  ).toEqual([]);
  expect(alertText(), '退出登录后不出刷新提示').toBe('');
  expect(document.body.textContent).not.toContain(fresh.body);
  expect(http.listRequests(), '退出登录后不得再发列表请求').toHaveLength(2);
  expect(http.tokenCalls()).toBe(1);
});
