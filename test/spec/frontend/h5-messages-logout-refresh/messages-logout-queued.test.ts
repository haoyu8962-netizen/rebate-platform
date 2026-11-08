// @vitest-environment jsdom
// F1-04e（FU-H5-MESSAGES-LOGOUT-QUEUED-REFRESH，照 F1-04d）：真实壳层 + 真实消息页；原生边界与 HTTP 是假的。
// 翻页在途时的下拉刷新会排队，翻页回来后才执行。若其间退出登录，排队的刷新作废：
// 不再向原生取令牌、不发 /v1/messages 请求、缓存里不留旧账号的消息。仍登录时排队照常（对照）。
import { act, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { list, message, reply } from '../h5-messages/messages-fixtures.ts';
import {
  deferred,
  mountShell,
  switchBridge,
  switchServer,
} from '../h5-account-switch/switch-helpers.ts';
import {
  alertText,
  cachedText,
  count,
  cursorOf,
  expectFirstPage,
  listRequests,
  pullDown,
  reachBottom,
  settle,
  stubObserver,
} from './logout-refresh-helpers.ts';

/** 只认 GET /v1/messages；n 为第几次列表请求（从 1 起）。 */
function messagesOnly(handler: (n: number) => Response | Promise<Response>) {
  let lists = 0;
  return (request: Request): Response | Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/v1/messages') {
      return reply(null, 30701, 404);
    }
    lists += 1;
    return handler(lists);
  };
}

it('[F1-04e-LOGOUT#1] 翻页在途时下拉刷新排队，随后退出登录、翻页返回：排队的刷新作废，不取令牌、不发请求、缓存里没有旧账号的消息', async () => {
  const first = message({ body: '退出前第一页的消息' });
  const second = message({ body: '退出前翻页取到的消息' });
  const stale = message({ body: '退出后多发请求取到的消息' });
  const more = deferred(reply(list([second])));
  const native = switchBridge();
  const http = switchServer(
    messagesOnly((n) => {
      if (n === 1) return reply(list([first], 'c1'));
      if (n === 2) return more.promise;
      return reply(list([stale]));
    }),
  );
  stubObserver();
  const view = await mountShell('/messages');
  await screen.findByText(first.body, { exact: false });
  await settle();
  expect(native.tokenCalls()).toBe(1);

  // 翻页请求挂起；期间下拉刷新只排队，不发请求。
  reachBottom();
  await waitFor(() => expect(listRequests(http.requests)).toHaveLength(2));
  expect(cursorOf(listRequests(http.requests)[1]!)).toEqual(['c1']);
  pullDown(screen.getByText(first.body, { exact: false }));
  await settle();
  expect(listRequests(http.requests), '翻页在途时下拉刷新只排队').toHaveLength(2);

  // 退出登录，随后翻页的响应才回来。
  await native.change(false);
  await settle();
  await act(async () => {
    more.resolve(reply(list([second])));
  });
  await settle();

  expect(native.tokenCalls(), '退出登录后排队的刷新不得再向原生取令牌').toBe(1);
  expect(listRequests(http.requests), '退出登录后排队的刷新不得发列表请求').toHaveLength(2);
  expect(http.requests, '退出登录后不得发任何请求').toHaveLength(2);
  const cached = cachedText(view.client);
  for (const body of [first.body, second.body, stale.body]) {
    expect(cached, `退出登录后缓存里不得有旧账号的消息：${body}`).not.toContain(body);
  }
  for (const body of [first.body, second.body, stale.body]) {
    expect(view.container.textContent).not.toContain(body);
  }
});

it('[F1-04e-LOGOUT#2] 仍登录时翻页在途的下拉刷新照常排队：翻页回来后只发一次第一页请求并替换列表；之后同一页再次排队并退出登录，排队的刷新作废', async () => {
  const first = message({ body: '第一页的消息' });
  const second = message({ body: '翻页取到的消息' });
  const fresh = message({ body: '排队刷新取到的新第一页消息' });
  const third = message({ body: '退出前再次翻页取到的消息' });
  const stale = message({ body: '退出后多发请求取到的消息' });
  const more = deferred(reply(list([second])));
  const refreshed = deferred(reply(list([fresh], 'c2')));
  const moreAgain = deferred(reply(list([third])));
  const native = switchBridge();
  const http = switchServer(
    messagesOnly((n) => {
      if (n === 1) return reply(list([first], 'c1'));
      if (n === 2) return more.promise;
      if (n === 3) return refreshed.promise;
      if (n === 4) return moreAgain.promise;
      return reply(list([stale]));
    }),
  );
  stubObserver();
  const view = await mountShell('/messages');
  await screen.findByText(first.body, { exact: false });
  await settle();

  // 对照：仍登录。翻页在途时两次下拉都只排队。
  reachBottom();
  await waitFor(() => expect(listRequests(http.requests)).toHaveLength(2));
  pullDown(screen.getByText(first.body, { exact: false }));
  pullDown(screen.getByText(first.body, { exact: false }));
  await settle();
  expect(listRequests(http.requests)).toHaveLength(2);

  // 翻页回来后才发排队的刷新，只取第一页一次；刷新在途时已加载的两页都还在。
  await act(async () => {
    more.resolve(reply(list([second])));
  });
  await waitFor(() => expect(listRequests(http.requests)).toHaveLength(3));
  expectFirstPage(listRequests(http.requests)[2]!);
  await settle();
  expect(listRequests(http.requests), '排队的刷新只发一次').toHaveLength(3);
  expect(count(first.body)).toBe(1);
  expect(count(second.body)).toBe(1);

  // 刷新成功：以新的第一页替换列表，不出提示，仍用同一个令牌。
  await act(async () => {
    refreshed.resolve(reply(list([fresh], 'c2')));
  });
  await screen.findByText(fresh.body, { exact: false });
  await settle();
  expect(count(first.body)).toBe(0);
  expect(count(second.body)).toBe(0);
  expect(listRequests(http.requests)).toHaveLength(3);
  expect(alertText()).toBe('');
  expect(native.tokenCalls()).toBe(1);

  // 同一页再次：翻页（游标 c2）在途时下拉刷新排队，随后退出登录，翻页的响应才回来。
  reachBottom();
  await waitFor(() => expect(listRequests(http.requests)).toHaveLength(4));
  expect(cursorOf(listRequests(http.requests)[3]!)).toEqual(['c2']);
  pullDown(screen.getByText(fresh.body, { exact: false }));
  await settle();
  expect(listRequests(http.requests)).toHaveLength(4);
  await native.change(false);
  await settle();
  await act(async () => {
    moreAgain.resolve(reply(list([third])));
  });
  await settle();

  expect(native.tokenCalls(), '退出登录后排队的刷新不得再向原生取令牌').toBe(1);
  expect(listRequests(http.requests), '退出登录后排队的刷新不得发列表请求').toHaveLength(4);
  expect(http.requests).toHaveLength(4);
  const cached = cachedText(view.client);
  for (const body of [first.body, second.body, fresh.body, third.body, stale.body]) {
    expect(cached, `退出登录后缓存里不得有旧账号的消息：${body}`).not.toContain(body);
  }
});
