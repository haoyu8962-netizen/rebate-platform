/// <reference types="@vitest/browser-playwright" />
// DSX-46: every clickable base component looks different while pressed (`:active`), shows the
// shared focus ring on `:focus-visible`, and never shows the WebView tap highlight. The pseudo
// states are forced through the Chrome DevTools Protocol (CSS.forcePseudoState) so the check does
// not depend on pointer timing. "Looks different" is judged on screenshot pixels inside the
// component's box (as test/spec/frontend/visual-baseline/compare.ts does), so a style change on
// something that is not painted (a pseudo element without `content`, a hidden or zero-size child)
// does not count; PRESS#1 first checks that judgement on hand-made probes.
import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cdp, page, type Locator } from 'vitest/browser';
import '../../../../apps/h5/src/shared/styles/index.css';
import {
  baseExport,
  type ButtonProps,
  type CardProps,
  type ChipProps,
  type ListRowProps,
  type SegmentedProps,
} from './base-api.ts';

const WAIT = { timeout: 5_000 } as const;
const TEST = { timeout: 30_000 } as const;
const PROBE_ATTRIBUTE = 'data-dsx46-probe';

let root: Root | undefined;
let originalViewport: { width: number; height: number };
let probeCount = 0;
let renderFailure: unknown;

beforeEach(async () => {
  originalViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(375, 812);
});

afterEach(async () => {
  unmount();
  await page.viewport(originalViewport.width, originalViewport.height);
});

function unmount(): void {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
}

/** Renders into one shared root; rethrows a render error (e.g. NotImplemented) in the test. */
function show(component: ReactNode): void {
  if (root === undefined) {
    const container = document.createElement('main');
    container.style.fontFamily = 'var(--font-family-system)';
    container.style.padding = '16px';
    document.body.append(container);
    root = createRoot(container, {
      onUncaughtError: (error) => {
        renderFailure = error;
      },
    });
  }
  renderFailure = undefined;
  flushSync(() => root?.render(component));
  const failure = renderFailure;
  renderFailure = undefined;
  if (failure !== undefined) throw failure;
}

async function visible(locator: Locator): Promise<HTMLElement> {
  await expect.element(locator, WAIT).toBeVisible();
  const element = locator.element();
  expect(element).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
}

function tokenColor(token: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

function tokenLength(token: string): string {
  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.width = `var(${token})`;
  document.body.append(probe);
  const width = getComputedStyle(probe).width;
  probe.remove();
  return width;
}

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

/** Forces CSS pseudo-classes on `element`, reads `read()` with transitions finished, releases. */
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
    // Finish pressed / focus transitions so the end state is read, not the first frame.
    for (const animation of element.getAnimations({ subtree: true })) {
      if (animation.effect?.getTiming().iterations !== Infinity) animation.finish();
    }
    return await read();
  } finally {
    await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    element.removeAttribute(PROBE_ATTRIBUTE);
  }
}

// ---------------------------------------------------------------------------------------------
// Pressed look, judged on screenshot pixels: only what is painted can differ.

/** A pixel counts as different when one RGBA channel differs by more than this (0–255). */
const PIXEL_TOLERANCE = 8;

/** A box in screenshot pixels (CSS pixels, origin at the top left corner of the screenshot). */
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

interface PressedChange {
  /** Differing pixels between two rest screenshots (must be 0, or the judgement is unreliable). */
  steady: number;
  /** Differing pixels between the rest and the pressed (`:active`) screenshot. */
  pressed: number;
}

/** Rest vs forced `:active`, compared only inside the element's rest box. */
async function pressedChange(element: HTMLElement): Promise<PressedChange> {
  await settled();
  const region = regionOf(element);
  expect(region.width * region.height, 'the element has a box with area').toBeGreaterThan(0);
  const rest = await capture();
  const again = await capture();
  const pressed = await whileForced(element, ['active'], async () => {
    await settled();
    return capture();
  });
  return {
    steady: changedPixels(again, rest, region),
    pressed: changedPixels(pressed, rest, region),
  };
}

/**
 * Hand-made probes for the judgement itself: a style change on something that is not painted
 * must not count, a painted one must. Colours are literal on purpose (test-only elements).
 */
const PROBE_STYLE_ID = 'dsx46-press-probes';
const PROBE_CSS = `
.dsx46-probe { position: relative; display: block; box-sizing: border-box; width: 160px;
  height: 48px; padding: 12px; background-color: rgb(255, 255, 255); color: rgb(0, 0, 0); }
.dsx46-probe .layer { position: absolute; inset: 0; }
.dsx46-no-content:active::before { position: absolute; inset: 0; background-color: rgb(0, 0, 0); }
.dsx46-zero-pseudo::after { content: ''; position: absolute; left: 0; top: 0; width: 0;
  height: 0; overflow: hidden; }
.dsx46-zero-pseudo:active::after { background-color: rgb(0, 0, 0); }
.dsx46-display-none .layer { display: none; }
.dsx46-display-none:active .layer { background-color: rgb(0, 0, 0); }
.dsx46-visibility-hidden .layer { visibility: hidden; }
.dsx46-visibility-hidden:active .layer { background-color: rgb(0, 0, 0); }
.dsx46-zero-size .layer { inset: auto; left: 0; top: 0; width: 0; height: 0; overflow: hidden; }
.dsx46-zero-size:active .layer { background-color: rgb(0, 0, 0); }
.dsx46-clear-ancestor .layer { opacity: 0; }
.dsx46-clear-ancestor .layer > span { position: absolute; inset: 0; }
.dsx46-clear-ancestor:active .layer > span { background-color: rgb(0, 0, 0); }
.dsx46-painted-pseudo:active::before { content: ''; position: absolute; inset: 0;
  background-color: rgb(0, 0, 0); }
.dsx46-painted-background:active { background-color: rgb(0, 0, 0); }
`;

interface Probe {
  name: string;
  className: string;
  /** Whether pressing it changes painted pixels. */
  visible: boolean;
}

const PROBES: readonly Probe[] = [
  { name: '::before without content', className: 'dsx46-no-content', visible: false },
  { name: 'zero-size ::after', className: 'dsx46-zero-pseudo', visible: false },
  { name: 'display:none child', className: 'dsx46-display-none', visible: false },
  { name: 'visibility:hidden child', className: 'dsx46-visibility-hidden', visible: false },
  { name: 'zero-size child', className: 'dsx46-zero-size', visible: false },
  { name: 'child under opacity:0 ancestor', className: 'dsx46-clear-ancestor', visible: false },
  { name: '::before with content', className: 'dsx46-painted-pseudo', visible: true },
  { name: 'own background', className: 'dsx46-painted-background', visible: true },
];

/** Unpainted changes must not count as a pressed look; painted ones must. */
async function checkJudgement(): Promise<void> {
  const style = document.createElement('style');
  style.id = PROBE_STYLE_ID;
  style.textContent = PROBE_CSS;
  document.head.append(style);
  try {
    for (const probe of PROBES) {
      const element = document.createElement('div');
      element.className = `dsx46-probe ${probe.className}`;
      const layer = document.createElement('div');
      layer.className = 'layer';
      layer.append(document.createElement('span'));
      element.append('Probe', layer);
      document.body.append(element);
      const change = await pressedChange(element);
      element.remove();
      expect(change.steady, `probe ${probe.name}: two rest screenshots agree`).toBe(0);
      if (probe.visible) {
        expect(change.pressed, `probe ${probe.name}: counts as pressed`).toBeGreaterThan(0);
      } else {
        expect(change.pressed, `probe ${probe.name}: does not count`).toBe(0);
      }
    }
  } finally {
    style.remove();
  }
}

interface ClickableCase {
  name: string;
  render: () => ReactNode;
  host: () => Locator;
}

function clickableCases(): ClickableCase[] {
  const Button = baseExport<ButtonProps>('Button');
  const Chip = baseExport<ChipProps>('Chip');
  const Segmented = baseExport<SegmentedProps>('Segmented');
  const Card = baseExport<CardProps>('Card');
  const ListRow = baseExport<ListRowProps>('ListRow');
  const noop = (): void => {};
  return [
    {
      name: 'Button primary',
      render: () =>
        createElement(Button, { variant: 'primary', onClick: noop, children: '提交订单' }),
      host: () => page.getByRole('button', { name: '提交订单', exact: true }),
    },
    {
      name: 'Button secondary',
      render: () =>
        createElement(Button, { variant: 'secondary', onClick: noop, children: '取消' }),
      host: () => page.getByRole('button', { name: '取消', exact: true }),
    },
    {
      name: 'Button text',
      render: () => createElement(Button, { variant: 'text', onClick: noop, children: '查看规则' }),
      host: () => page.getByRole('button', { name: '查看规则', exact: true }),
    },
    {
      name: 'Button icon',
      render: () =>
        createElement(Button, {
          variant: 'icon',
          'aria-label': '关闭',
          onClick: noop,
          children: createElement(
            'svg',
            { viewBox: '0 0 24 24', width: 24, height: 24, 'aria-hidden': true },
            createElement('path', {
              d: 'M6 6l12 12M18 6L6 18',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
            }),
          ),
        }),
      host: () => page.getByRole('button', { name: '关闭', exact: true }),
    },
    {
      name: 'Chip unselected',
      render: () =>
        createElement(Chip, { selected: false, onSelectedChange: noop, children: '待返现' }),
      host: () => page.getByRole('button', { name: '待返现', exact: true }),
    },
    {
      name: 'Chip selected',
      render: () =>
        createElement(Chip, { selected: true, onSelectedChange: noop, children: '已返现' }),
      host: () => page.getByRole('button', { name: '已返现', exact: true }),
    },
    {
      name: 'Segmented option',
      render: () =>
        createElement(Segmented, {
          'aria-label': '订单状态',
          options: [
            { value: 'all', label: '全部' },
            { value: 'pending', label: '待返现' },
          ],
          value: 'all',
          onChange: noop,
        }),
      host: () => page.getByRole('radio', { name: '待返现', exact: true }),
    },
    {
      name: 'Card clickable',
      render: () =>
        createElement(Card, {
          onClick: noop,
          children: createElement(
            'div',
            null,
            createElement('span', null, '订单 A123'),
            createElement('span', null, '已返现 ¥3.20'),
          ),
        }),
      host: () => page.getByRole('button', { name: '订单 A123' }),
    },
    {
      name: 'ListRow clickable',
      render: () =>
        createElement(ListRow, {
          title: '收款账户',
          subtitle: '支付宝 138****0000',
          trailing: createElement(
            'svg',
            { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': true },
            createElement('path', {
              d: 'M9 6l6 6-6 6',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2,
            }),
          ),
          onClick: noop,
        }),
      host: () => page.getByRole('button', { name: '收款账户' }),
    },
  ];
}

it(
  '[AC-DSX-46-PRESS#1] 每个可点基础件按下（:active）时背景、透明度或缩放与常态不同，且无 WebView 点按高亮',
  TEST,
  async () => {
    await checkJudgement();
    for (const item of clickableCases()) {
      show(item.render());
      const host = await visible(item.host());
      const change = await pressedChange(host);
      expect(change.steady, `${item.name}: two rest screenshots agree`).toBe(0);
      expect(change.pressed, `${item.name}: pressed pixels differ`).toBeGreaterThan(0);
      expect(['rgba(0, 0, 0, 0)', 'transparent'], `${item.name}: tap highlight`).toContain(
        getComputedStyle(host).getPropertyValue('-webkit-tap-highlight-color'),
      );
      unmount();
    }
  },
);

it(
  '[AC-DSX-46-FOCUS#1] 每个可点基础件 :focus-visible 时显示统一焦点框（焦点色、宽度、偏移令牌）',
  TEST,
  async () => {
    for (const item of clickableCases()) {
      show(item.render());
      const host = await visible(item.host());
      const expected = {
        style: 'solid',
        width: tokenLength('--focus-width'),
        offset: tokenLength('--focus-offset'),
        color: tokenColor('--color-focus-ring'),
      };
      const ring = await whileForced(host, ['focus', 'focus-visible'], () => {
        const style = getComputedStyle(host);
        return {
          style: style.outlineStyle,
          width: style.outlineWidth,
          offset: style.outlineOffset,
          color: style.outlineColor,
        };
      });
      expect(ring, `${item.name}: focus ring`).toEqual(expected);
      unmount();
    }
  },
);

it('[AC-DSX-46-LOADING#1] Button 进入加载态时按钮内显示加载指示，宽高不跳', TEST, async () => {
  const Button = baseExport<ButtonProps>('Button');
  const render = (loading: boolean): ReactNode =>
    createElement(
      'div',
      { style: { display: 'flex', alignItems: 'flex-start' } },
      createElement(Button, { type: 'submit', loading, children: '提交订单' }),
    );
  show(render(false));
  const idle = await visible(page.getByRole('button', { name: '提交订单' }));
  const before = idle.getBoundingClientRect();
  show(render(true));
  const button = await visible(page.getByRole('button', { name: '提交订单' }));
  expect(button.getAttribute('aria-busy')).toBe('true');
  const after = button.getBoundingClientRect();
  expect(after.width).toBeCloseTo(before.width, 0);
  expect(after.height).toBeCloseTo(before.height, 0);
  const indicator = button.querySelector<HTMLElement>('[data-slot="button-loading"]');
  expect(indicator, 'loading indicator inside the button').not.toBeNull();
  const box = indicator!.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.left).toBeGreaterThanOrEqual(after.left);
  expect(box.right).toBeLessThanOrEqual(after.right);
  expect(getComputedStyle(indicator!).visibility).toBe('visible');
});
