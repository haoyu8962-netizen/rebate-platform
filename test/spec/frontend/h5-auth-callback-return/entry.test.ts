// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished, vi } from 'vitest';

const ENTRY = '../../../../apps/h5/src/entries/auth-callback';
const ENTRY_MODULES = import.meta.glob([
  '../../../../apps/h5/src/entries/auth-callback/main.ts',
  '../../../../apps/h5/src/entries/auth-callback/main.tsx',
]);
const PATH = '/auth/taobao/callback';
const PROMPT = '请回到凑狸 App 继续';
const RETURN_LABEL = '返回凑狸';
const EXTRA_QUERY =
  '&redirect_uri=https%3A%2F%2Fexample.test&access_token=FixtureToken&error_description=FixtureDetail';

async function openEntry(): Promise<void> {
  const index = resolve(dirname(fileURLToPath(import.meta.url)), join(ENTRY, 'index.html'));
  const page = new DOMParser().parseFromString(readFileSync(index, 'utf8'), 'text/html');
  const script = page.querySelector('script[type="module"]');
  const source = script?.getAttribute('src')?.replace(/^\.?\//, '');
  const load = ENTRY_MODULES[`${ENTRY}/${source}`];
  expect(load, 'index.html 引用 auth-callback 入口模块').toBeDefined();

  document.head.innerHTML = page.head.innerHTML;
  document.body.innerHTML = page.body.innerHTML;
  vi.resetModules();
  await load!();
}

function observeBrowser() {
  const originalHead = Array.from(document.head.childNodes);
  const originalBody = Array.from(document.body.childNodes);
  const addressBar = window.location;
  const originalUrl = addressBar.href;
  const originalState: unknown = history.state;
  const replaceState = vi.spyOn(history, 'replaceState');
  // 模拟自动打开 App 被浏览器拦截，保留当前页面供用户操作。
  const replace = vi.fn<(target: string) => void>();
  vi.stubGlobal('location', {
    get search() {
      return addressBar.search;
    },
    get pathname() {
      return addressBar.pathname;
    },
    get href() {
      return addressBar.href;
    },
    origin: addressBar.origin,
    hash: addressBar.hash,
    replace,
  });

  onTestFinished(() => {
    replaceState.mockRestore();
    vi.unstubAllGlobals();
    document.head.replaceChildren(...originalHead);
    document.body.replaceChildren(...originalBody);
    history.replaceState(originalState, '', originalUrl);
  });

  async function openCallback(search: string): Promise<void> {
    history.replaceState(null, '', `${PATH}${search}`);
    replaceState.mockClear();
    replace.mockClear();
    await openEntry();
  }

  return { addressBar, openCallback, replaceState, replace };
}

it.each([
  {
    label: '授权成功回调',
    invalidSearches: [
      '?state=State_9-a',
      '?code=Code-0_b',
      '?code=Code%2F0_b&state=State_9-a',
      `?code=${'C'.repeat(257)}&state=State_9-a`,
      '?code=%2541&state=State_9-a',
    ],
    search: `?state=State_9-a&code=Code%2D0_b${EXTRA_QUERY}`,
    target: 'couli://auth/taobao?code=Code-0_b&state=State_9-a',
  },
  {
    label: '授权出错回调',
    invalidSearches: [
      '?error=denied',
      '?error=denied&state=State%2F9-a',
      `?error=denied&state=${'S'.repeat(257)}`,
      '?error=denied&state=%2541',
    ],
    search: `?code=IgnoredCode&error=denied%26code%3Dleak&state=State_9-a${EXTRA_QUERY}`,
    target: 'couli://auth/taobao?state=State_9-a&error=1',
  },
])('[AC-F1-11da#1] $label 仅在生成深链时显示可点的返回链接', async (scenario) => {
  const { addressBar, openCallback, replaceState, replace } = observeBrowser();

  for (const search of scenario.invalidSearches) {
    await openCallback(search);

    expect(document.body.querySelectorAll('a'), search).toHaveLength(0);
    expect(document.body.textContent?.trim(), search).toBe(PROMPT);
    expect(replace, search).not.toHaveBeenCalled();
  }

  await openCallback(scenario.search);

  expect(replaceState).toHaveBeenCalledTimes(1);
  expect(addressBar.pathname).toBe(PATH);
  expect(addressBar.search).toBe('');
  expect(replace.mock.calls).toEqual([[scenario.target]]);
  expect(replaceState).toHaveBeenCalledBefore(replace);

  const links = document.body.querySelectorAll('a');
  expect(links).toHaveLength(1);
  const link = links[0]!;
  expect(link.textContent?.trim()).toBe(RETURN_LABEL);
  expect(link.getAttribute('href')).toBe(scenario.target);
  expect(link.getAttribute('href')).toBe(replace.mock.calls[0]?.[0]);
  expect(link.target.toLowerCase()).not.toBe('_blank');
  expect(link.closest('[hidden], [inert]')).toBeNull();
  const style = window.getComputedStyle(link);
  expect(style.visibility).not.toMatch(/^(hidden|collapse)$/);
  expect(style.pointerEvents).not.toBe('none');
  for (let element: HTMLElement | null = link; element; element = element.parentElement) {
    expect(window.getComputedStyle(element).display).not.toBe('none');
  }

  const bodyWithoutLink = document.body.cloneNode(true) as HTMLElement;
  bodyWithoutLink.querySelector('a')?.remove();
  expect(bodyWithoutLink.textContent?.trim()).toBe(PROMPT);
});
