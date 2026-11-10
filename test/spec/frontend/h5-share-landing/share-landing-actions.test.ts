// @vitest-environment jsdom
import { fireEvent } from '@testing-library/dom';
import { afterEach, expect, it, vi } from 'vitest';
import {
  APP_ID,
  bodyText,
  BROWSER_UA,
  buttons,
  cardShown,
  hrefs,
  installApi,
  JUMP_URL,
  LINK_ID,
  links,
  ok,
  OPEN_IN_APP_URL,
  openLanding,
  resetLanding,
  settle,
  SHARE_TICKET,
  SHARE_TPWD,
  sharePage,
  stubClipboard,
  text,
  TPWD_PATH,
  tpwdRequests,
  WECHAT_UA,
} from './share-landing-kit.ts';

afterEach(resetLanding);

it('[AC-F1-11a-TPWD#1] 有 tpwd_ticket 时显示【复制淘口令】，点击前页面不含口令也不取口令', async () => {
  const api = installApi({ page: () => ok(sharePage()), tpwd: () => ok({ tpwd: SHARE_TPWD }) });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  await settle();
  expect(buttons(text('share_page.copy_tpwd'))).toHaveLength(1);
  expect(bodyText()).not.toContain(SHARE_TPWD);
  expect(tpwdRequests(api)).toHaveLength(0);
});

it('[AC-F1-11a-TPWD#2] 点【复制淘口令】凭票据调 tpwd 接口，口令写入剪贴板并提示已复制', async () => {
  const api = installApi({ page: () => ok(sharePage()), tpwd: () => ok({ tpwd: SHARE_TPWD }) });
  const writeText = stubClipboard(async () => undefined);
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  await vi.waitFor(() => {
    expect(buttons(text('share_page.copy_tpwd'))).toHaveLength(1);
  });
  fireEvent.click(buttons(text('share_page.copy_tpwd'))[0]!);
  await vi.waitFor(() => {
    expect(writeText).toHaveBeenCalledWith(SHARE_TPWD);
  });
  const sent = tpwdRequests(api);
  expect(sent).toHaveLength(1);
  const request = sent[0]!;
  expect(request.method).toBe('POST');
  expect(new URL(request.url).pathname).toBe(TPWD_PATH);
  expect(request.headers.get('X-App-Id')).toBe(APP_ID);
  expect(request.headers.get('X-Platform')).toBe('h5');
  expect(request.headers.get('Authorization')).toBeNull();
  expect(await request.json()).toEqual({ ticket: SHARE_TICKET });
  await vi.waitFor(() => {
    expect(bodyText()).toContain(text('share_page.copy_tpwd.done'));
  });
});

it('[AC-F1-11a-TPWD#3] 剪贴板写入失败时把口令显示在页面上供手动复制，不提示已复制', async () => {
  const api = installApi({ page: () => ok(sharePage()), tpwd: () => ok({ tpwd: SHARE_TPWD }) });
  const writeText = stubClipboard(async () => {
    throw new DOMException('fixture clipboard denied', 'NotAllowedError');
  });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  await vi.waitFor(() => {
    expect(buttons(text('share_page.copy_tpwd'))).toHaveLength(1);
  });
  fireEvent.click(buttons(text('share_page.copy_tpwd'))[0]!);
  await vi.waitFor(() => {
    expect(tpwdRequests(api)).toHaveLength(1);
  });
  await vi.waitFor(() => {
    expect(bodyText()).toContain(SHARE_TPWD);
  });
  expect(writeText.mock.calls.every(([value]) => value === SHARE_TPWD)).toBe(true);
  expect(bodyText()).not.toContain(text('share_page.copy_tpwd.done'));
});

it('[AC-F1-11a-TPWD#4] tpwd_ticket 为 null 时不显示【复制淘口令】，也不调 tpwd 接口', async () => {
  const api = installApi({
    page: () => ok(sharePage({ tpwd_ticket: null })),
    tpwd: () => ok({ tpwd: SHARE_TPWD }),
  });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  await settle();
  expect(buttons(text('share_page.copy_tpwd'))).toHaveLength(0);
  expect(tpwdRequests(api)).toHaveLength(0);
});

it('[AC-F1-11a-APP#1] 浏览器内 open_in_app_url 非 null 时显示【在 App 中打开】，链接即该地址', async () => {
  const api = installApi({ page: () => ok(sharePage()) });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  await vi.waitFor(() => {
    expect(links(text('share_page.open_in_app'))).toHaveLength(1);
  });
  expect(links(text('share_page.open_in_app'))[0]!.getAttribute('href')).toBe(OPEN_IN_APP_URL);
  expect(bodyText()).not.toContain(text('share_page.open_in_browser_hint'));
});

it('[AC-F1-11a-APP#2] open_in_app_url 为 null 时不显示【在 App 中打开】', async () => {
  const api = installApi({ page: () => ok(sharePage({ open_in_app_url: null })) });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  await settle();
  expect(links(text('share_page.open_in_app'))).toHaveLength(0);
  expect(buttons(text('share_page.open_in_app'))).toHaveLength(0);
  expect(bodyText()).not.toContain(text('share_page.open_in_app'));
  for (const href of hrefs()) expect(href).toBe(JUMP_URL);
});

it('[AC-F1-11a-WECHAT#1] 微信内显示「在浏览器打开」引导，代替【在 App 中打开】与【复制淘口令】（BR-TEXT-14）', async () => {
  // Even if a response carried both, inside WeChat the page shows neither (BR-ATTR-05 细则).
  const api = installApi({ page: () => ok(sharePage()), tpwd: () => ok({ tpwd: SHARE_TPWD }) });
  await openLanding(`/${LINK_ID}`, WECHAT_UA);
  await cardShown(api);
  await vi.waitFor(() => {
    expect(bodyText()).toContain(text('share_page.open_in_browser_hint'));
  });
  await settle();
  expect(buttons(text('share_page.copy_tpwd'))).toHaveLength(0);
  expect(links(text('share_page.open_in_app'))).toHaveLength(0);
  expect(hrefs()).not.toContain(OPEN_IN_APP_URL);
  expect(tpwdRequests(api)).toHaveLength(0);
});

it('[AC-F1-11a-WECHAT#2] 微信外不显示「在浏览器打开」引导', async () => {
  const api = installApi({ page: () => ok(sharePage({ tpwd_ticket: null })) });
  await openLanding(`/${LINK_ID}`, BROWSER_UA);
  await cardShown(api);
  await settle();
  expect(bodyText()).not.toContain(text('share_page.open_in_browser_hint'));
});
