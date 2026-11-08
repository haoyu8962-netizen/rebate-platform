/// <reference types="@vitest/browser-playwright" />
// DSX-48 / DSX-108 in a real Chromium with the shipped H5 styles:
// - SHIMMER: the skeleton block shimmers (a gradient highlight, linear, endless, one sweep per
//   motion.skeleton.shimmer) instead of Tailwind's breathing `pulse` (规划/03 §10.6 item 7);
//   with prefers-reduced-motion: reduce it stands still (item 8), and nothing on the page keeps
//   animating (DSX-108 acceptance).
// - FORCED: with forced-colors: active the base components keep a visible boundary (a border or
//   outline of at least 1px on the component or a part covering at least half of it; colours are
//   replaced by the system palette there, so fills and shadows no longer separate them) and the
//   focus ring stays visible on the clickable ones.
// - TOAST: inside the App (bridge present, 03 §8.3) the light notice sits at the top of the page;
//   outside the App it keeps the bottom position (DSX-48: "Toast.tsx 只在站外分支保留底部定位").
// Media features are emulated through the Chrome DevTools Protocol (Emulation.setEmulatedMedia).
import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cdp, page, type Locator } from 'vitest/browser';
import '../../../../apps/h5/src/shared/styles/index.css';
import { Skeleton, Toast } from '../../../../apps/h5/src/components/base/index.ts';
import {
  baseExport,
  type ButtonProps,
  type CardProps,
  type ChipProps,
  type ListRowProps,
} from '../h5-base-press/base-api.ts';
import { SHIMMER_MS, SKELETON_BLOCK } from './expected.ts';

const WAIT = { timeout: 5_000 } as const;
const TEST = { timeout: 30_000 } as const;
const VIEWPORT = { width: 375, height: 812 } as const;
const PROBE_ATTRIBUTE = 'data-dsx48-probe';

let root: Root | undefined;
let originalViewport: { width: number; height: number };
let renderFailure: unknown;
let probeCount = 0;

beforeEach(async () => {
  originalViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(VIEWPORT.width, VIEWPORT.height);
});

afterEach(async () => {
  unmount();
  vi.unstubAllGlobals();
  await emulate([]);
  await page.viewport(originalViewport.width, originalViewport.height);
});

function unmount(): void {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
}

/** Renders into a fresh <main>; rethrows a render error (e.g. NotImplemented) in the test. */
function show(component: ReactNode): HTMLElement {
  unmount();
  const container = document.createElement('main');
  container.style.fontFamily = 'var(--font-family-system)';
  container.style.padding = '16px';
  document.body.append(container);
  root = createRoot(container, {
    onUncaughtError: (error) => {
      renderFailure = error;
    },
  });
  renderFailure = undefined;
  flushSync(() => root?.render(component));
  const failure = renderFailure;
  renderFailure = undefined;
  if (failure !== undefined) throw failure;
  return container;
}

async function visible(locator: Locator): Promise<HTMLElement> {
  await expect.element(locator, WAIT).toBeVisible();
  const element = locator.element();
  expect(element).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
}

function firstChild(container: HTMLElement): HTMLElement {
  const element = container.firstElementChild;
  expect(element, 'the component renders an element').toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
}

async function emulate(features: { name: string; value: string }[]): Promise<void> {
  await cdp().send('Emulation.setEmulatedMedia', { features });
}

function animationLabel(animation: Animation): string {
  return animation instanceof CSSAnimation ? animation.animationName : `(${animation.id})`;
}

function durationOf(animation: Animation): number {
  return Number(animation.effect?.getComputedTiming().duration ?? 0);
}

/** CSS animations under `element` (pseudo-elements and descendants included) that never end. */
function endless(element: Element): CSSAnimation[] {
  return element
    .getAnimations({ subtree: true })
    .filter(
      (animation): animation is CSSAnimation =>
        animation instanceof CSSAnimation &&
        animation.effect?.getComputedTiming().iterations === Infinity,
    );
}

/** One entry of a comma-separated computed list (commas inside parentheses do not split). */
function listItem(list: string, index: number): string {
  const items = list.split(/,(?![^(]*\))/).map((item) => item.trim());
  return items[index % items.length] ?? '';
}

/** Computed style of the element or pseudo-element a CSS animation runs on. */
function animatedStyle(animation: CSSAnimation): CSSStyleDeclaration {
  const effect = animation.effect;
  expect(effect, `${animation.animationName}: keyframe effect`).toBeInstanceOf(KeyframeEffect);
  const keyframes = effect as KeyframeEffect;
  expect(keyframes.target, `${animation.animationName}: target`).not.toBeNull();
  return getComputedStyle(keyframes.target as Element, keyframes.pseudoElement);
}

const PSEUDOS = [null, '::before', '::after'] as const;

/** Some part of the skeleton paints a gradient (background or mask): the shimmer highlight. */
function paintsGradient(host: Element): boolean {
  return [host, ...host.querySelectorAll('*')].some((element) =>
    PSEUDOS.some((pseudo) => {
      const style = getComputedStyle(element, pseudo);
      return [
        style.getPropertyValue('background-image'),
        style.getPropertyValue('mask-image'),
        style.getPropertyValue('-webkit-mask-image'),
      ].some((value) => value.includes('gradient('));
    }),
  );
}

/** The shimmer: endless, linear, one sweep per motion.skeleton.shimmer, a gradient highlight. */
function expectShimmer(host: Element): void {
  const animations = endless(host);
  expect(animations.map(animationLabel), 'endless animation on the skeleton').not.toEqual([]);
  for (const animation of animations) {
    const name = animation.animationName;
    expect(name, 'not the breathing pulse of Tailwind').not.toBe('pulse');
    expect(durationOf(animation), `${name}: duration`).toBe(SHIMMER_MS);
    const style = animatedStyle(animation);
    const index = style.animationName
      .split(',')
      .map((item) => item.trim())
      .indexOf(name);
    expect(index, `${name}: listed in animation-name`).toBeGreaterThanOrEqual(0);
    expect(listItem(style.animationTimingFunction, index), `${name}: timing`).toBe('linear');
  }
  expect(paintsGradient(host), 'a gradient highlight').toBe(true);
}

function runningLabels(animations: Animation[]): string[] {
  return animations
    .filter((animation) => animation.playState === 'running' && durationOf(animation) > 0)
    .map(animationLabel);
}

it(
  '[AC-DSX-48-SHIMMER#1] 骨架块是渐变微光：线性、无限循环、周期取 --motion-skeleton-shimmer（不再是 pulse 呼吸）',
  TEST,
  async () => {
    expect(
      getComputedStyle(document.documentElement)
        .getPropertyValue('--motion-skeleton-shimmer')
        .trim(),
      '--motion-skeleton-shimmer from the H5 styles',
    ).toBe(`${SHIMMER_MS}ms`);
    const container = show(createElement(Skeleton, { width: 160, height: 32 }));
    await visible(page.elementLocator(firstChild(container)));
    const block = container.querySelector<HTMLElement>(SKELETON_BLOCK);
    expect(block, SKELETON_BLOCK).not.toBeNull();
    await expect.element(page.elementLocator(block!), WAIT).toBeVisible();
    expectShimmer(firstChild(container));
  },
);

it(
  '[AC-DSX-48-SHIMMER#2] prefers-reduced-motion: reduce 时微光停播、骨架静止仍可见，页面上没有持续动画',
  TEST,
  async () => {
    const Button = baseExport<ButtonProps>('Button');
    const container = show(
      createElement(
        'div',
        null,
        createElement(Skeleton, { width: 160, height: 32 }),
        createElement(Button, { loading: true, children: '提交订单' }),
      ),
    );
    const skeleton = firstChild(firstChild(container));
    await visible(page.elementLocator(skeleton));
    expectShimmer(skeleton);

    await emulate([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches, 'emulated media').toBe(true);
    expect(runningLabels(skeleton.getAnimations({ subtree: true })), 'skeleton animations').toEqual(
      [],
    );
    const block = container.querySelector<HTMLElement>(SKELETON_BLOCK);
    expect(block, SKELETON_BLOCK).not.toBeNull();
    await expect.element(page.elementLocator(block!), WAIT).toBeVisible();
    const box = block!.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([160, 32]);
    const endlessRunning = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations === Infinity);
    expect(runningLabels(endlessRunning), 'endless animations on the page').toEqual([]);
  },
);

// --- forced colours ------------------------------------------------------------------------------

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

/** Forces CSS pseudo-classes on `element` (CDP CSS.forcePseudoState), reads, releases. */
async function whileForced<T>(element: HTMLElement, states: string[], read: () => T): Promise<T> {
  probeCount += 1;
  const marker = `probe-${probeCount}`;
  element.setAttribute(PROBE_ATTRIBUTE, marker);
  const session = cdp();
  await session.send('DOM.enable');
  await session.send('CSS.enable');
  const walk = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const nodeId = findNode(walk.root, marker) ?? 0;
  expect(nodeId, 'CDP finds the element under test').toBeGreaterThan(0);
  await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: states });
  try {
    for (const animation of element.getAnimations({ subtree: true })) {
      if (animation.effect?.getTiming().iterations !== Infinity) animation.finish();
    }
    return read();
  } finally {
    await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    element.removeAttribute(PROBE_ATTRIBUTE);
  }
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

function visibleEdge(style: CSSStyleDeclaration): boolean {
  const border = SIDES.some((side) => {
    const lineStyle = style.getPropertyValue(`border-${side}-style`);
    const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
    return lineStyle !== 'none' && lineStyle !== 'hidden' && width >= 1;
  });
  const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 1;
  return border || outline;
}

/** A border / outline on the host, on a part covering half of it, or on a painted pseudo-element. */
function hasBoundary(host: HTMLElement): boolean {
  const box = host.getBoundingClientRect();
  const area = box.width * box.height;
  return [host, ...host.querySelectorAll<HTMLElement>('*')].some((element) => {
    const part = element.getBoundingClientRect();
    if (element !== host && part.width * part.height < area / 2) return false;
    if (visibleEdge(getComputedStyle(element))) return true;
    return (['::before', '::after'] as const).some((pseudo) => {
      const style = getComputedStyle(element, pseudo);
      return style.content !== 'none' && style.content !== 'normal' && visibleEdge(style);
    });
  });
}

interface ForcedCase {
  name: string;
  render: () => ReactNode;
  host: (container: HTMLElement) => Promise<HTMLElement>;
  clickable: boolean;
}

function forcedCases(): ForcedCase[] {
  const Button = baseExport<ButtonProps>('Button');
  const Chip = baseExport<ChipProps>('Chip');
  const Card = baseExport<CardProps>('Card');
  const ListRow = baseExport<ListRowProps>('ListRow');
  const noop = (): void => {};
  const byRole = (name: string) => async () =>
    visible(page.getByRole('button', { name, exact: true }));
  return [
    {
      name: 'Button primary',
      render: () =>
        createElement(Button, { variant: 'primary', onClick: noop, children: '提交订单' }),
      host: byRole('提交订单'),
      clickable: true,
    },
    {
      name: 'Button secondary',
      render: () =>
        createElement(Button, { variant: 'secondary', onClick: noop, children: '取消' }),
      host: byRole('取消'),
      clickable: true,
    },
    {
      name: 'Chip unselected',
      render: () =>
        createElement(Chip, { selected: false, onSelectedChange: noop, children: '待返现' }),
      host: byRole('待返现'),
      clickable: true,
    },
    {
      name: 'Chip selected',
      render: () =>
        createElement(Chip, { selected: true, onSelectedChange: noop, children: '已返现' }),
      host: byRole('已返现'),
      clickable: true,
    },
    {
      name: 'Card',
      render: () => createElement(Card, { children: createElement('p', null, '本月预估 ¥12.30') }),
      host: async (container) => visible(page.elementLocator(firstChild(container))),
      clickable: false,
    },
    {
      name: 'Card clickable',
      render: () =>
        createElement(Card, {
          onClick: noop,
          children: createElement('span', null, '订单 A123'),
        }),
      host: async () => visible(page.getByRole('button', { name: '订单 A123' })),
      clickable: true,
    },
    {
      name: 'ListRow clickable',
      render: () => createElement(ListRow, { title: '收款账户', onClick: noop }),
      host: async () => visible(page.getByRole('button', { name: '收款账户' })),
      clickable: true,
    },
    {
      name: 'Skeleton',
      render: () => createElement(Skeleton, { width: 160, height: 32 }),
      host: async (container) => {
        const block = container.querySelector<HTMLElement>(SKELETON_BLOCK);
        expect(block, SKELETON_BLOCK).not.toBeNull();
        return visible(page.elementLocator(block!));
      },
      clickable: false,
    },
  ];
}

it(
  '[AC-DSX-48-FORCED#1] forced-colors: active 下 Button / Chip / Card / ListRow / Skeleton 仍有可见边界（≥1px 边框或轮廓），可点件焦点框可见',
  TEST,
  async () => {
    await emulate([{ name: 'forced-colors', value: 'active' }]);
    expect(matchMedia('(forced-colors: active)').matches, 'emulated media').toBe(true);
    const missing: string[] = [];
    for (const item of forcedCases()) {
      const container = show(item.render());
      const host = await item.host(container);
      if (!hasBoundary(host)) missing.push(`${item.name}: no visible boundary`);
      if (item.clickable) {
        const ring = await whileForced(host, ['focus', 'focus-visible'], () => {
          const style = getComputedStyle(host);
          return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
        });
        if (ring.style === 'none' || !(ring.width >= 1)) {
          missing.push(`${item.name}: focus ring ${ring.style} ${ring.width}px`);
        }
      }
      unmount();
    }
    expect(missing).toEqual([]);
  },
);

// --- light notice position -----------------------------------------------------------------------

it(
  '[AC-DSX-48-TOAST#1] App 内（有 __REBATE_BRIDGE__）轻提示在页顶居中；站外（无桥）保留底部居中',
  TEST,
  async () => {
    vi.stubGlobal('__REBATE_BRIDGE__', { version: 1, methods: [] });
    show(createElement(Toast, { message: '已复制口令', durationMs: 60_000 }));
    const inApp = (await visible(page.getByRole('status'))).getBoundingClientRect();
    expect(inApp.top, 'in the App: inside the viewport').toBeGreaterThanOrEqual(0);
    expect(inApp.bottom, 'in the App: upper half of the page').toBeLessThanOrEqual(
      VIEWPORT.height / 2,
    );
    expect(inApp.x + inApp.width / 2).toBeCloseTo(VIEWPORT.width / 2, 0);
    unmount();

    vi.unstubAllGlobals();
    show(createElement(Toast, { message: '已复制口令', durationMs: 60_000 }));
    const outside = (await visible(page.getByRole('status'))).getBoundingClientRect();
    expect(outside.top, 'outside the App: lower half of the page').toBeGreaterThan(
      VIEWPORT.height / 2,
    );
    expect(outside.bottom).toBeLessThanOrEqual(VIEWPORT.height);
    expect(outside.x + outside.width / 2).toBeCloseTo(VIEWPORT.width / 2, 0);
  },
);
