import { readFileSync } from 'node:fs';
import { queryAllByRole } from '@testing-library/dom';
import { expect, vi, type Mock } from 'vitest';
import { shellTexts } from '../../../../apps/h5/src/texts/shell.ts';

// Kept in a constant so Vite's jsdom client transform does not turn the repo path into an asset URL.
const moduleUrl = import.meta.url;
const ROOT = new URL('../../../../', moduleUrl);

/** Build-time values the landing reads (apps/h5 reads VITE_* only from import.meta.env). */
export const API_BASE = 'https://api.example.test';
export const APP_ID = 'fixture_brand';
const MEDIA_ORIGIN = 'https://img.example.test';

export const LINK_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a70';
export const PAGE_PATH = `/v1/share-pages/${LINK_ID}`;
export const TPWD_PATH = `/v1/share-pages/${LINK_ID}/tpwd`;
export const JUMP_URL = 'https://s.click.example.test/t?e=share01';
export const OPEN_IN_APP_URL = `https://go.example.test/r/LinkLanding?link_id=${LINK_ID}`;
export const SHARE_TICKET = 'fixture-ticket-01';
export const SHARE_TPWD = 'fixture-tpwd-7Kq9';
export const TITLE = 'fixture-title-noise-cancelling-earbuds';
export const IMAGE = `${MEDIA_ORIGIN}/p/7Kq9LmN3pQ.jpg`;

export const BROWSER_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
export const WECHAT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x1800323c) NetType/WIFI Language/zh_CN';

/** contracts/openapi.yaml SharedProductCard (independent copy for fixtures). */
export interface CardFixture {
  product_key: string | null;
  item_ref: string | null;
  platform: string;
  shop_type: string | null;
  title: string | null;
  image: string | null;
  shop_name: string | null;
  price_fen: number | null;
  coupon_fen: number | null;
  final_price_fen: number | null;
  benefit_tags: string[];
  is_presale: boolean;
  link_id: string;
  stale: boolean;
  age_sec: number | null;
  source: 'taobao_union' | 'jd_union' | 'pdd_union';
  disclaimer_keys: string[];
  ad_label: string | null;
  availability: string;
}

/** contracts/openapi.yaml SharePageData. */
export interface SharePageFixture {
  product_card: CardFixture;
  quoted_at: string | null;
  jump_url: string;
  tpwd_ticket: string | null;
  open_in_app_url: string | null;
}

export function sharePage(
  page: Partial<Omit<SharePageFixture, 'product_card'>> = {},
  card: Partial<CardFixture> = {},
): SharePageFixture {
  return {
    product_card: {
      product_key: 'tb:7Kq9LmN3pQ',
      item_ref: 'v1.dGJfN0txOUxtTjNwUQ.c2ln',
      platform: 'taobao',
      shop_type: 'tmall',
      title: TITLE,
      image: IMAGE,
      shop_name: 'fixture-shop',
      price_fen: 3990,
      coupon_fen: 1000,
      final_price_fen: 2990,
      benefit_tags: [],
      is_presale: false,
      link_id: LINK_ID,
      stale: false,
      age_sec: 30,
      source: 'taobao_union',
      disclaimer_keys: ['price_basis'],
      ad_label: null,
      availability: 'ok',
      ...card,
    },
    quoted_at: '2026-11-10T01:30:00Z',
    jump_url: JUMP_URL,
    tpwd_ticket: SHARE_TICKET,
    open_in_app_url: OPEN_IN_APP_URL,
    ...page,
  };
}

export interface Reply {
  status: number;
  body: unknown;
}

/** 'offline' makes the fake fetch reject the way a browser does when the network is down. */
export type Answer = Reply | 'offline';

export function ok(data: unknown): Reply {
  return { status: 200, body: { code: 0, msg: '', data, trace_id: 'fixture-trace' } };
}

export function failure(status: number, code: number, data?: unknown): Reply {
  const body: Record<string, unknown> = { code, msg: 'fixture-msg', trace_id: 'fixture-trace' };
  if (data !== undefined) body['data'] = data;
  return { status, body };
}

export interface ApiScript {
  page: () => Answer;
  tpwd?: () => Answer;
}

export interface FakeApi {
  fetch: Mock<typeof globalThis.fetch>;
  /** Clones of every request the page sent, in order. */
  requests: Request[];
}

function route(request: Request, script: ApiScript): Answer {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === PAGE_PATH) return script.page();
  if (request.method === 'POST' && path === TPWD_PATH && script.tpwd !== undefined) {
    return script.tpwd();
  }
  return failure(400, 20001);
}

/** In-memory HTTP boundary on globalThis.fetch: no network, no listening socket. */
export function installApi(script: ApiScript): FakeApi {
  const requests: Request[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    const answer = route(request, script);
    if (answer === 'offline') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, requests };
}

export function pageRequests(api: FakeApi): Request[] {
  return api.requests.filter(
    (request) => request.method === 'GET' && new URL(request.url).pathname === PAGE_PATH,
  );
}

export function tpwdRequests(api: FakeApi): Request[] {
  return api.requests.filter((request) => new URL(request.url).pathname === TPWD_PATH);
}

function setUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    get: () => userAgent,
  });
}

/** navigator.clipboard.writeText (jsdom has no Clipboard API). */
export function stubClipboard(
  write: (value: string) => Promise<void>,
): Mock<(value: string) => Promise<void>> {
  const writeText = vi.fn(write);
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

/**
 * Boots the real landing entry (apps/h5/src/entries/landing/main.tsx) outside the App: no bridge,
 * the given user agent, address `path` on the share host.
 */
export async function openLanding(path: string, userAgent: string): Promise<void> {
  vi.resetModules();
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  vi.stubEnv('VITE_API_BASE_URL', API_BASE);
  vi.stubEnv('VITE_APP_ID', APP_ID);
  vi.stubEnv('VITE_MEDIA_ORIGINS', MEDIA_ORIGIN);
  setUserAgent(userAgent);
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(null, '', path);
  await import('../../../../apps/h5/src/entries/landing/main.tsx');
}

export function resetLanding(): void {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window.navigator, 'userAgent');
  Reflect.deleteProperty(window.navigator, 'clipboard');
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
}

/** Waits until the page has asked for the share page and returns that request. */
export async function firstPageRequest(api: FakeApi): Promise<Request> {
  await vi.waitFor(
    () => {
      expect(pageRequests(api).length, `GET ${PAGE_PATH} sent by the landing`).toBeGreaterThan(0);
    },
    { timeout: 2000 },
  );
  return pageRequests(api)[0]!;
}

/** Waits until the product card is on the page (its title is shown). */
export async function cardShown(api: FakeApi): Promise<void> {
  await firstPageRequest(api);
  await vi.waitFor(
    () => {
      expect(bodyText(), 'product card title').toContain(TITLE);
    },
    { timeout: 2000 },
  );
}

/** Lets pending responses and renders finish before asserting what is absent. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200));
}

export function bodyText(): string {
  return document.body.textContent ?? '';
}

export function hrefs(): string[] {
  return [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');
}

export function anchorsTo(url: string): HTMLAnchorElement[] {
  return [...document.querySelectorAll('a')].filter((a) => a.getAttribute('href') === url);
}

export function buttons(name: string): HTMLElement[] {
  return queryAllByRole(document.body, 'button', { name });
}

export function links(name: string): HTMLElement[] {
  return queryAllByRole(document.body, 'link', { name });
}

export function imageSources(): string[] {
  return [...document.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '');
}

interface Dictionary {
  texts: Record<string, string>;
}

const DICTIONARY = JSON.parse(
  readFileSync(new URL('contracts/texts.default.json', ROOT), 'utf8'),
) as Dictionary;

/** Contract dictionary text (contracts/texts.default.json), read independently of apps/h5. */
export function text(key: string): string {
  const value = DICTIONARY.texts[key];
  expect(value, `dictionary key ${key}`).toBeTypeOf('string');
  return value!;
}

/** The landing's placeholder text before F1-11 ("page pending"), which a real state replaces. */
export function placeholderText(): string {
  const value = shellTexts['h5.shell.page_pending'];
  expect(value, 'h5.shell.page_pending').toBeTypeOf('string');
  return value!;
}
