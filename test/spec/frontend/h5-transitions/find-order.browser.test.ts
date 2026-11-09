/// <reference types="@vitest/browser-playwright" />
// DSX-48d on the find-order page in a real Chromium with the shipped H5 styles (手感方案 ⑦,
// 编排 D10-1032; 规划/03 §10.6 items 1–3, 8: "加载到内容、Tab 内内容替换都要过渡", "内容替换用 normal",
// "只动 opacity 与 transform"):
// - CONTENT: when the configuration arrives and the form replaces the skeleton, the new content
//   (an element holding the order-number field) fades in: opacity only, --motion-duration-normal,
//   easing --motion-easing-enter or --motion-easing-standard.
// - TABS: switching tabs fades the newly shown panel in (the panel, its content, or a wrapper of
//   it that does not hold the tab list): opacity only — no movement, so nothing shakes —,
//   --motion-duration-normal, easing standard or enter. Both directions.
// - REDUCED: with prefers-reduced-motion: reduce both still only fade, taking
//   --motion-reduced-fade.
// The page runs on the frozen h5-find-order fixtures (in-memory bridge and API). Motion is
// recorded through document.getAnimations() (motion-kit.ts); endless animations (the skeleton
// shimmer) are left out.
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { FindOrderPage } from '../../../../apps/h5/src/entries/app/pages/find-order/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import { config, fixture, ORDER_NO } from '../h5-find-order/find-order-fixtures.ts';
import { SKELETON_BLOCK } from './contract.ts';
import {
  VIEWPORT,
  WAIT,
  cleanupAll,
  emulate,
  expectFadeIn,
  record,
  reduceMotion,
  samplesOf,
  settled,
  show,
  tokens,
  type Recorder,
  type Sample,
} from './motion-kit.ts';

const APPLY = '申请找回';
const RECORDS = '找回记录';

let client: ReturnType<typeof createQueryClient> | undefined;
let originalViewport: { width: number; height: number };

beforeEach(async () => {
  originalViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(VIEWPORT.width, VIEWPORT.height);
});

afterEach(async () => {
  cleanupAll();
  client?.clear();
  client = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await emulate([]);
  await page.viewport(originalViewport.width, originalViewport.height);
});

function mount(f: ReturnType<typeof fixture>): HTMLElement {
  client = createQueryClient();
  return show(
    createQueryProvider(
      createElement(
        ApiProvider,
        { api: f.api },
        createElement(
          MemoryRouter,
          { initialEntries: ['/find-order'] },
          createElement(FindOrderPage, { bridge: f.bridge }),
        ),
      ),
      client,
    ),
  );
}

interface Loaded {
  recorder: Recorder;
  container: HTMLElement;
  field: Element;
}

/**
 * Mounts with the configuration held back, waits for the skeleton, then releases the
 * configuration while recording (mark "content") until the form shows and the motion settled.
 */
async function loadForm(): Promise<Loaded> {
  const pending = Promise.withResolvers<{ values: typeof config }>();
  const container = mount(fixture({ loadConfig: () => pending.promise }));
  const skeleton = container.querySelector<HTMLElement>(SKELETON_BLOCK);
  expect(skeleton, 'the form skeleton while the configuration loads').not.toBeNull();
  await expect.element(page.elementLocator(skeleton!), WAIT).toBeVisible();
  const recorder = record();
  recorder.mark('content');
  pending.resolve({ values: config });
  const field = page.getByLabelText(/^订单号/);
  await expect.element(field, WAIT).toBeVisible();
  await settled(recorder);
  return { recorder, container, field: field.element() };
}

/** Motion of the new content: elements of the page that hold the order-number field. */
function contentMotion(loaded: Loaded): Sample[] {
  return samplesOf(
    loaded.recorder,
    'content',
    (target) =>
      target !== loaded.container &&
      loaded.container.contains(target) &&
      target.contains(loaded.field),
  );
}

/** Clicks the tab (recording under `mark`) and returns its panel once shown. */
async function switchTo(recorder: Recorder, mark: string, name: string): Promise<Element> {
  recorder.mark(mark);
  await page.getByRole('tab', { name, exact: true }).click();
  const panel = page.getByRole('tabpanel', { name, exact: true });
  await expect.element(panel, WAIT).toBeVisible();
  return panel.element();
}

/** Motion of the panel, its content, or a wrapper of it that does not hold the tab list. */
function panelMotion(
  recorder: Recorder,
  mark: string,
  container: HTMLElement,
  panel: Element,
): Sample[] {
  const tablist = page.getByRole('tablist').element();
  return samplesOf(
    recorder,
    mark,
    (target) =>
      target === panel ||
      panel.contains(target) ||
      (target.contains(panel) &&
        !target.contains(tablist) &&
        target !== container &&
        container.contains(target)),
  );
}

/** Both tab switches: to the records (after the list loaded) and back to the form. */
async function switchBothWays(loaded: Loaded): Promise<{ records: Sample[]; apply: Sample[] }> {
  const { recorder, container } = loaded;
  const recordsPanel = await switchTo(recorder, 'records', RECORDS);
  await expect.element(page.getByText(new RegExp(ORDER_NO)), WAIT).toBeVisible();
  await settled(recorder);
  const records = panelMotion(recorder, 'records', container, recordsPanel);
  const applyPanel = await switchTo(recorder, 'apply', APPLY);
  await settled(recorder);
  const apply = panelMotion(recorder, 'apply', container, applyPanel);
  return { records, apply };
}

it(
  '[AC-DSX-48d-CONTENT#1] 找回页配置到达、骨架换成表单时新内容淡入：只动 opacity（不位移），时长取 --motion-duration-normal、缓动取 --motion-easing-enter 或 --motion-easing-standard',
  { timeout: 30_000 },
  async () => {
    const motion = tokens();
    const loaded = await loadForm();
    expectFadeIn(contentMotion(loaded), 'form content', motion.normal, [
      motion.enter,
      motion.standard,
    ]);
  },
);

it(
  '[AC-DSX-48d-TABS#1] 找回页切换页签（到找回记录、再回到申请找回）：新显示的面板淡入，只动 opacity 不位移，时长取 --motion-duration-normal、缓动取 --motion-easing-standard 或 --motion-easing-enter',
  { timeout: 30_000 },
  async () => {
    const motion = tokens();
    const loaded = await loadForm();
    const { records, apply } = await switchBothWays(loaded);
    const easings = [motion.standard, motion.enter];
    expectFadeIn(records, 'records panel', motion.normal, easings);
    expectFadeIn(apply, 'apply panel', motion.normal, easings);
  },
);

it(
  '[AC-DSX-48d-REDUCED#2] 减弱动态：找回页骨架换内容与页签切换仍只淡入（无位移），时长取 --motion-reduced-fade',
  { timeout: 30_000 },
  async () => {
    const motion = tokens();
    await reduceMotion();
    const loaded = await loadForm();
    expectFadeIn(contentMotion(loaded), 'form content (reduced)', motion.reducedFade, null);
    const { records, apply } = await switchBothWays(loaded);
    expectFadeIn(records, 'records panel (reduced)', motion.reducedFade, null);
    expectFadeIn(apply, 'apply panel (reduced)', motion.reducedFade, null);
  },
);
