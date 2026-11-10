// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  anchorsTo,
  API_BASE,
  APP_ID,
  bodyText,
  BROWSER_UA,
  cardShown,
  firstPageRequest,
  hrefs,
  IMAGE,
  installApi,
  JUMP_URL,
  LINK_ID,
  ok,
  OPEN_IN_APP_URL,
  openLanding,
  PAGE_PATH,
  resetLanding,
  settle,
  sharePage,
  tpwdRequests,
  imageSources,
} from './share-landing-kit.ts';

// Address shape: the share host's path carries the server-issued link_id (BR-ATTR-29 细则); the
// exact pattern is still null in contracts/bridge.schema.json share_page_paths, so these tests
// only use `/<link_id>`.

afterEach(resetLanding);

it('[AC-F1-11a-CARD#1] 落地页按地址里的 link_id 匿名调 getSharePage（GET、h5 公共头、不带 Authorization）', async () => {
  const api = installApi({ page: () => ok(sharePage()) });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  const request = await firstPageRequest(api);
  const url = new URL(request.url);
  expect(request.method).toBe('GET');
  expect(url.origin).toBe(API_BASE);
  expect(url.pathname).toBe(PAGE_PATH);
  expect(request.headers.get('X-App-Id')).toBe(APP_ID);
  expect(request.headers.get('X-Platform')).toBe('h5');
  expect(request.headers.get('Authorization')).toBeNull();
  await settle();
  // The token is only fetched on the copy button, never with the page (BR-ATTR-10 细则).
  expect(tpwdRequests(api)).toHaveLength(0);
});

it('[AC-F1-11a-CARD#2] 成功时显示商品卡：标题、商品图与券后价（BR-TEXT-10 金额格式）', async () => {
  const api = installApi({ page: () => ok(sharePage()) });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  expect(imageSources()).toContain(IMAGE);
  // final_price_fen 2990 → ¥29.9
  expect(bodyText()).toContain('¥29.9');
});

it('[AC-F1-11a-CARD#3] 【去购买】是指向 jump_url 原样地址的链接', async () => {
  const api = installApi({ page: () => ok(sharePage()) });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  const buy = anchorsTo(JUMP_URL);
  expect(buy.length, 'a[href=jump_url]').toBeGreaterThan(0);
  expect(buy.every((a) => (a.textContent ?? '').trim().length > 0)).toBe(true);
});

it('[AC-F1-11a-CARD#4] 页面上的链接只有服务端给的 jump_url 与 open_in_app_url，没有下载链接', async () => {
  const api = installApi({ page: () => ok(sharePage()) });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  await settle();
  const all = hrefs();
  expect(all.length).toBeGreaterThan(0);
  for (const href of all) expect([JUMP_URL, OPEN_IN_APP_URL]).toContain(href);
});

it('[AC-F1-11a-QUOTE#1] 报价降级（stale）时按 +08:00 显示取价时间 HH:mm（BR-PRICE-11）', async () => {
  const page = sharePage({ quoted_at: '2026-09-29T01:30:00Z' }, { stale: true, age_sec: 2160 });
  const api = installApi({ page: () => ok(page) });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  expect(bodyText()).toContain('09:30');
});

it('[AC-F1-11a-QUOTE#2] quoted_at 为 null 时不显示任何取价时间', async () => {
  const api = installApi({
    page: () => ok(sharePage({ quoted_at: null }, { stale: true, age_sec: 2160 })),
  });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  await settle();
  expect(bodyText()).not.toMatch(/\d{1,2}:\d{2}/);
});
