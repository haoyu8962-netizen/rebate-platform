// @vitest-environment jsdom
import { fireEvent } from '@testing-library/dom';
import { afterEach, expect, it, vi } from 'vitest';
import {
  anchorsTo,
  bodyText,
  BROWSER_UA,
  buttons,
  failure,
  firstPageRequest,
  hrefs,
  installApi,
  JUMP_URL,
  LINK_ID,
  ok,
  openLanding,
  PAGE_PATH,
  pageRequests,
  placeholderText,
  resetLanding,
  settle,
  sharePage,
  text,
  TITLE,
  type Answer,
} from './share-landing-kit.ts';

afterEach(resetLanding);

const SHARER_AUTH_INVALID = { reason: 'sharer_auth_invalid' } as const;

/** Opens the page with one scripted answer and waits until it is no longer loading. */
async function openWith(answer: Answer) {
  const api = installApi({ page: () => answer });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await firstPageRequest(api);
  await settle();
  await vi.waitFor(() => {
    expect(bodyText()).not.toContain(text('state.loading'));
  });
  return api;
}

/** What every terminal empty state of the share page has in common. */
function expectTerminalEmptyState() {
  const shown = bodyText().trim();
  expect(shown.length, 'empty state message').toBeGreaterThan(0);
  expect(shown).not.toContain(placeholderText());
  expect(shown).not.toContain(TITLE);
  // No buying, no replay, no authorization and no download from here (BR-ATTR-05 细则).
  expect(hrefs()).toEqual([]);
  expect(buttons(text('state.retry'))).toHaveLength(0);
  expect(buttons(text('share_page.copy_tpwd'))).toHaveLength(0);
}

it('[AC-F1-11a-STATE#1] 30144（链接不存在 / 非分享 link）显示失效空态，不重试、不给购买入口', async () => {
  const api = await openWith(failure(404, 30144));
  expectTerminalEmptyState();
  expect(pageRequests(api)).toHaveLength(1);
});

it.each([
  [30102, 'error.30102'],
  [30111, 'error.30111'],
] as const)(
  '[AC-F1-11a-STATE#2] %s + reason=sharer_auth_invalid 显示分享失效空态，不引导打开者授权',
  async (code, authKey) => {
    const api = await openWith(failure(422, code, SHARER_AUTH_INVALID));
    expectTerminalEmptyState();
    // The opener's own authorization prompt is not shown: the sharer's is what lapsed.
    expect(bodyText()).not.toContain(text(authKey));
    expect(pageRequests(api)).toHaveLength(1);
  },
);

it('[AC-F1-11a-STATE#3] 淘宝与拼多多的分享者授权失效显示同一句空态文案（error-codes 30102 / 30111 action）', async () => {
  await openWith(failure(422, 30102, SHARER_AUTH_INVALID));
  const taobao = bodyText().trim();
  resetLanding();
  await openWith(failure(422, 30111, SHARER_AUTH_INVALID));
  const pdd = bodyText().trim();
  expect(taobao.length).toBeGreaterThan(0);
  expect(pdd).toBe(taobao);
});

it('[AC-F1-11a-STATE#4] 网络失败显示【重试】，点重试重新取同一 link_id 并显示商品卡', async () => {
  let online = false;
  const api = installApi({ page: () => (online ? ok(sharePage()) : 'offline') });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await firstPageRequest(api);
  await vi.waitFor(
    () => {
      expect(buttons(text('state.retry'))).toHaveLength(1);
    },
    { timeout: 3000 },
  );
  expect(bodyText()).not.toContain(TITLE);
  const failed = pageRequests(api).length;
  online = true;
  fireEvent.click(buttons(text('state.retry'))[0]!);
  await vi.waitFor(
    () => {
      expect(bodyText()).toContain(TITLE);
    },
    { timeout: 3000 },
  );
  expect(pageRequests(api).length).toBeGreaterThan(failed);
  expect(api.requests.every((request) => new URL(request.url).pathname === PAGE_PATH)).toBe(true);
  expect(anchorsTo(JUMP_URL).length).toBeGreaterThan(0);
  expect(buttons(text('state.retry'))).toHaveLength(0);
});

it('[AC-F1-11a-STATE#5] 地址里没有 link_id 时直接显示失效空态，不发请求', async () => {
  const api = installApi({ page: () => ok(sharePage()) });
  await openLanding('/', BROWSER_UA);
  await settle();
  expect(api.requests).toHaveLength(0);
  expectTerminalEmptyState();
});
