// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const H5 = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/h5');
const ENTRY = '../../../../apps/h5/src/entries/auth-callback';
const ENTRY_MODULES = import.meta.glob([
  '../../../../apps/h5/src/entries/auth-callback/main.ts',
  '../../../../apps/h5/src/entries/auth-callback/main.tsx',
]);
const PATH = '/auth/taobao/callback';
const PROMPT = '请回到凑狸 App 继续';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
});

async function openEntry(): Promise<void> {
  const index = join(H5, 'src/entries/auth-callback/index.html');
  expect(existsSync(index), 'auth-callback/index.html').toBe(true);
  const page = new DOMParser().parseFromString(readFileSync(index, 'utf8'), 'text/html');
  const scripts = page.querySelectorAll('script');
  expect(scripts).toHaveLength(1);
  const script = scripts[0]!;
  expect(script.type).toBe('module');
  const source = script.getAttribute('src')?.replace(/^\.?\//, '');
  const load = ENTRY_MODULES[`${ENTRY}/${source}`];
  expect(load, 'index.html 引用 auth-callback 的 main 模块').toBeDefined();

  document.body.innerHTML = page.body.innerHTML;
  vi.resetModules();
  await load!();
}

function observeBrowser(search: string) {
  history.replaceState(null, '', `${PATH}${search}`);
  const addressBar = window.location;
  const replaceState = vi.spyOn(history, 'replaceState');
  // 模拟浏览器没有离开页面，地址栏仍由真正的 history.replaceState 更新。
  const replace = vi.fn();
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

  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const xhr = vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {});
  const forbidden = {
    fetch,
    xhr,
    localStorage: vi.spyOn(window, 'localStorage', 'get'),
    sessionStorage: vi.spyOn(window, 'sessionStorage', 'get'),
    cookieRead: vi.spyOn(document, 'cookie', 'get'),
    cookieWrite: vi.spyOn(document, 'cookie', 'set'),
  };
  const logs = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(globalThis.console, level).mockImplementation(() => {}),
  );

  return { addressBar, replaceState, replace, forbidden, logs };
}

it('[AC-F1-11d#7] Vite 将 auth-callback 注册为独立 H5 入口', () => {
  const config = readFileSync(join(H5, 'vite.config.ts'), 'utf8');
  const entries = config.match(/\bENTRIES\s*=\s*\[([^\]]*)\]/)?.[1] ?? '';
  expect(entries).toMatch(/['"]auth-callback['"]/);
});

it.each([
  [
    '?code=FixtureCode&state=FixtureState',
    'couli://auth/taobao?code=FixtureCode&state=FixtureState',
  ],
  [
    '?error=denied&error_description=FixtureDetail&state=FixtureState',
    'couli://auth/taobao?state=FixtureState&error=1',
  ],
  ['?code=Fixture%2FCode&state=FixtureState', null],
])('[AC-F1-11d#8] 先清除查询串并只显示回 App 提示（%s）', async (search, target) => {
  const { addressBar, replaceState, replace, forbidden, logs } = observeBrowser(search);
  await openEntry();

  expect(replaceState).toHaveBeenCalledTimes(1);
  expect(addressBar.pathname).toBe(PATH);
  expect(addressBar.search).toBe('');
  expect(replace.mock.calls).toEqual(target === null ? [] : [[target]]);
  if (target !== null) expect(replaceState).toHaveBeenCalledBefore(replace);

  expect(document.body.textContent?.trim()).toBe(PROMPT);
  expect(JSON.stringify(history.state) ?? '').not.toMatch(/Fixture(?:Code|State|Detail|\/Code)/);
  for (const [name, call] of Object.entries(forbidden)) expect(call, name).not.toHaveBeenCalled();
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});
