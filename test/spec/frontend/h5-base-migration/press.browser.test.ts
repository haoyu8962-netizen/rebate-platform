/// <reference types="@vitest/browser-playwright" />
// DSX-47 (规划/05 §3.11.3, 编排 D10-837 ②): after the migration the controls on real H5 pages look
// different while pressed. Spot check of four representatives — a whole card (notice list), a list
// row (other rules on the rules page), a segmented option (earnings period) and a text button
// (notice list "load more") — judged as in DSX-46 (test/spec/frontend/h5-base-press): `:active` is
// forced through the Chrome DevTools Protocol and screenshot pixels inside the control's box are
// compared with the rest state (two rest screenshots must agree). The control is found from its
// visible text, going up to the nearest button / radio / tab, so the check does not depend on how
// the page builds it.
import { createElement, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import { EarningsPage } from '../../../../apps/h5/src/entries/app/pages/earnings/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { NoticePage } from '../../../../apps/h5/src/entries/app/pages/notices/index.ts';
import { RulesPage } from '../../../../apps/h5/src/entries/app/pages/rules/index.ts';
import { ApiProvider, type ApiProviderProps } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { createApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import { noticesTexts } from '../../../../apps/h5/src/texts/notices.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import { copy, earningsServer, NOW, platformNames } from '../h5-earnings/earnings-fixtures.ts';

const WAIT = { timeout: 5_000 } as const;
const TEST = { timeout: 30_000 } as const;
const PROBE_ATTRIBUTE = 'data-dsx47-probe';
/** What counts as the control around a label (native or ARIA). */
const CONTROL = 'button, [role="button"], [role="radio"], [role="tab"], a[href]';

let root: Root | undefined;
let client: ReturnType<typeof createQueryClient> | undefined;
let viewport: { width: number; height: number };
let probeCount = 0;

beforeEach(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  await page.viewport(390, 844);
});

afterEach(async () => {
  root?.unmount();
  root = undefined;
  client?.clear();
  client = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await page.viewport(viewport.width, viewport.height);
});

// --- fake HTTP boundary ------------------------------------------------------------------------

type Article = components['schemas']['Article'];
type NoticeSummary = components['schemas']['NoticeArticleSummary'];
type ArticleList = components['schemas']['ArticleListData'];

function doc(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
}

function reply(data: unknown, code = 0, status = 200): Response {
  return new Response(JSON.stringify({ code, msg: '', data, trace_id: 'dsx47-fixture' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Real H5 API client over a fake fetch: no network, no socket. */
function fakeApi(handler: (url: URL) => Response) {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(new URL(request.url));
  };
  return createApiClient({
    baseUrl: 'https://api.example.invalid',
    headers: () => ({ 'X-App-Id': 'fixture_brand', 'X-Platform': 'h5', 'X-App-Version': '1.0.0' }),
    fetch,
  });
}

const NOTICE: NoticeSummary = {
  article_id: 'dsx47-maintenance',
  category: 'notice',
  title: '订单同步维护通知',
  version: 1,
  published_at: '2026-10-08T02:00:00Z',
  notice: {
    item_id: 'dsx47-maintenance',
    content_version: 1,
    text: '维护期间订单可能延迟显示。',
    target: null,
    closable: true,
    start_at: '2026-10-08T02:00:00Z',
    end_at: null,
  },
};

/** One notice and a next cursor, so the list shows a card and the "load more" button. */
function noticeApi() {
  const list: ArticleList = { items: [NOTICE], next_cursor: 'dsx47-next' };
  return fakeApi((url) =>
    url.pathname === '/v1/articles' ? reply(list) : reply(null, 30701, 404),
  );
}

const RULES: Article[] = [
  {
    article_id: 'dsx47-rebate',
    category: 'rule',
    title: '返利规则',
    version: 1,
    published_at: '2026-10-01T02:00:00Z',
    body: doc('返利在订单结算后入账。'),
  },
  {
    article_id: 'dsx47-withdrawal',
    category: 'rule',
    title: '提现规则',
    version: 1,
    published_at: '2026-10-02T02:00:00Z',
    body: doc('提现规则正文。'),
  },
];

/** Two short rules: the first is shown, the second is a row under "other rules". */
function rulesApi() {
  const list: ArticleList = {
    items: RULES.map(({ article_id, category, title, version, published_at }) => ({
      article_id,
      category: category as 'rule',
      title,
      version,
      published_at,
    })),
    next_cursor: null,
  };
  return fakeApi((url) => {
    if (url.pathname === '/v1/articles') return reply(list);
    const article = RULES.find((item) => url.pathname === `/v1/articles/${item.article_id}`);
    return article === undefined ? reply(null, 30701, 404) : reply(article);
  });
}

// --- mounting ----------------------------------------------------------------------------------

function mount(tree: ReactElement): void {
  const container = document.createElement('div');
  document.body.append(container);
  let failure: unknown;
  root = createRoot(container, {
    onUncaughtError: (error) => {
      failure = error;
    },
  });
  client = createQueryClient();
  const queries = client;
  flushSync(() => root?.render(createQueryProvider(tree, queries)));
  if (failure !== undefined) throw failure;
}

function routed(
  api: ApiProviderProps['api'],
  path: string,
  pageElement: ReactElement,
): ReactElement {
  return createElement(
    ApiProvider,
    { api },
    createElement(MemoryRouter, { initialEntries: [path] }, pageElement),
  );
}

/** The one control (button / radio / tab / link) that holds a visible element with `text`. */
async function controlWithText(text: string): Promise<HTMLElement> {
  const labels = page.getByText(text, { exact: true });
  await expect.element(labels.first(), WAIT).toBeVisible();
  const hosts = new Set<HTMLElement>();
  for (const label of labels.elements()) {
    const host = label.closest<HTMLElement>(CONTROL);
    if (host !== null) hosts.add(host);
  }
  expect(hosts.size, `exactly one control shows「${text}」`).toBe(1);
  return [...hosts][0]!;
}

// --- pressed look, judged on screenshot pixels (as in DSX-46) ----------------------------------

interface CdpNode {
  nodeId: number;
  attributes?: string[];
  children?: CdpNode[];
  contentDocument?: CdpNode;
  shadowRoots?: CdpNode[];
}

function findNode(node: CdpNode, marker: string): number | undefined {
  const attributes = node.attributes ?? [];
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    if (attributes[i] === PROBE_ATTRIBUTE && attributes[i + 1] === marker) return node.nodeId;
  }
  const next = [
    ...(node.children ?? []),
    ...(node.contentDocument === undefined ? [] : [node.contentDocument]),
    ...(node.shadowRoots ?? []),
  ];
  for (const child of next) {
    const found = findNode(child, marker);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Forces CSS pseudo-classes on `element`, reads `read()`, releases them. */
async function whileForced<T>(
  element: HTMLElement,
  states: string[],
  read: () => T | Promise<T>,
): Promise<T> {
  probeCount += 1;
  const marker = `probe-${probeCount}`;
  element.setAttribute(PROBE_ATTRIBUTE, marker);
  const session = cdp();
  await session.send('DOM.enable');
  await session.send('CSS.enable');
  // A fresh document walk each time: node ids from an earlier walk are no longer valid.
  const walk = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const nodeId = findNode(walk.root, marker) ?? 0;
  expect(nodeId, 'CDP finds the element under test').toBeGreaterThan(0);
  await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: states });
  try {
    return await read();
  } finally {
    await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    element.removeAttribute(PROBE_ATTRIBUTE);
  }
}

/** A pixel counts as different when one RGBA channel differs by more than this (0–255). */
const PIXEL_TOLERANCE = 8;

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

function nextFrames(): Promise<void> {
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** Finite animations and transitions run to their end, endless ones cancelled, two frames. */
async function settled(): Promise<void> {
  for (const animation of document.getAnimations()) {
    try {
      if (animation.effect?.getComputedTiming().iterations === Infinity) animation.cancel();
      else animation.finish();
    } catch {
      animation.cancel();
    }
  }
  await nextFrames();
}

/** Screenshot of the test page (<body>), CSS pixels, animations stopped, caret hidden. */
async function capture(): Promise<ImageData> {
  const png = await page.screenshot({
    save: false,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
  const image = new Image();
  image.src = `data:image/png;base64,${png}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  expect(context, 'Chromium has a 2D canvas context').not.toBeNull();
  context!.drawImage(image, 0, 0);
  return context!.getImageData(0, 0, canvas.width, canvas.height);
}

/** The element's box in the pixels of capture() (relative to <body>), rounded outwards. */
function regionOf(element: Element): Region {
  const box = element.getBoundingClientRect();
  const origin = document.body.getBoundingClientRect();
  const left = Math.floor(box.left - origin.left);
  const top = Math.floor(box.top - origin.top);
  const right = Math.ceil(box.right - origin.left);
  const bottom = Math.ceil(box.bottom - origin.top);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Differing pixels inside the region; a pixel only one of the images has counts as differing. */
function changedPixels(actual: ImageData, reference: ImageData, region: Region): number {
  let changed = 0;
  for (let y = Math.max(0, region.y); y < region.y + region.height; y += 1) {
    for (let x = Math.max(0, region.x); x < region.x + region.width; x += 1) {
      const inActual = x < actual.width && y < actual.height;
      const inReference = x < reference.width && y < reference.height;
      if (!inActual && !inReference) continue;
      if (inActual !== inReference) {
        changed += 1;
        continue;
      }
      const a = (y * actual.width + x) * 4;
      const b = (y * reference.width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        if (Math.abs(actual.data[a + channel]! - reference.data[b + channel]!) > PIXEL_TOLERANCE) {
          changed += 1;
          break;
        }
      }
    }
  }
  return changed;
}

/** Rest vs forced `:active` inside the control's rest box; two rest screenshots must agree. */
async function expectPressedLook(control: HTMLElement, name: string): Promise<void> {
  await document.fonts.ready;
  await settled();
  const region = regionOf(control);
  expect(region.width * region.height, `${name}: the control has a box with area`).toBeGreaterThan(
    0,
  );
  const rest = await capture();
  const again = await capture();
  const pressed = await whileForced(control, ['active'], async () => {
    await settled();
    return capture();
  });
  expect(changedPixels(again, rest, region), `${name}: two rest screenshots agree`).toBe(0);
  expect(changedPixels(pressed, rest, region), `${name}: pressed pixels differ`).toBeGreaterThan(0);
}

// --- the four representatives ------------------------------------------------------------------

it('[AC-DSX-47-PRESS#1] 公告列表的整卡按下时，卡片区域的像素与常态不同', TEST, async () => {
  mount(routed(noticeApi(), '/notice', createElement(NoticePage)));
  const card = await controlWithText(NOTICE.title);
  await expect.element(page.getByText(NOTICE.notice.text, { exact: true }), WAIT).toBeVisible();
  await expectPressedLook(card, 'notice card');
});

it('[AC-DSX-47-PRESS#2] 规则页「其他规则」列表行按下时，行区域的像素与常态不同', TEST, async () => {
  mount(createElement(RulesPage, { api: rulesApi() }));
  await expect
    .element(page.getByText('返利在订单结算后入账。', { exact: true }), WAIT)
    .toBeVisible();
  const row = await controlWithText(RULES[1]!.title);
  await expectPressedLook(row, 'other-rule row');
});

it('[AC-DSX-47-PRESS#3] 收益页期间分段的选项按下时，选项区域的像素与常态不同', TEST, async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  const http = earningsServer();
  mount(routed(http.api, '/earnings', createElement(EarningsPage, {})));
  // Figures and platform pills settled, so nothing above the switch moves while measuring.
  await expect.element(page.getByText(copy.self, { exact: true }).first(), WAIT).toBeVisible();
  await expect
    .element(page.getByText(platformNames.taobao, { exact: true }).first(), WAIT)
    .toBeVisible();
  const option = await controlWithText(copy.period.last_month);
  await expectPressedLook(option, 'period option');
});

it(
  '[AC-DSX-47-PRESS#4] 公告列表「加载更多」文字按钮按下时，按钮区域的像素与常态不同',
  TEST,
  async () => {
    mount(routed(noticeApi(), '/notice', createElement(NoticePage)));
    await controlWithText(NOTICE.title);
    const more = await controlWithText(noticesTexts.loadMore);
    await expectPressedLook(more, 'load more');
  },
);
