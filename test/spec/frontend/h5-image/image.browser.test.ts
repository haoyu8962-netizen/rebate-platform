/// <reference types="@vitest/browser-playwright" />
// DSX-48c in a real Chromium with the shipped H5 styles (手感方案 ④; design/ui-rules §3.6 "图片有
// 占位 + 渐显 + 缓存 + 失败态 …… 不要：图片从占位硬切"; 规划/03 §10.6 "骨架换成内容时淡入（normal）",
// "减弱动态……无法改成淡入的直接取 instant", "只动 opacity 与 transform"):
// - FADE: while loading the frame shows a token placeholder colour at the given aspect ratio and the
//   image is not shown (opacity 0); after `load` the image fades in through an opacity transition
//   whose duration and easing are the computed values of var(--motion-duration-normal) and
//   var(--motion-easing-enter); only opacity / transform transition; the frame keeps its size.
// - REDUCED: with prefers-reduced-motion: reduce the loaded image is fully shown at once, with no
//   transition at all.
// - FAILED: a broken image shows the readable failure text on the placeholder, no broken-image
//   icon, and the frame keeps its size.
// Images are fresh blob: URLs made here (no network, never cached), so each one loads only after
// the first style pass. Media features are emulated through CDP Emulation.setEmulatedMedia.
import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import '../../../../apps/h5/src/shared/styles/index.css';
import { FRAME, imageComponent, shownImgs, stateOf } from './kit.ts';

const WAIT = { timeout: 5_000 } as const;
const TEST = { timeout: 30_000 } as const;
const VIEWPORT = { width: 375, height: 812 } as const;
/** Width of the box the image frame fills; with aspect-ratio 3 / 2 the frame is 300 × 200. */
const BOX_WIDTH = 300;
const BOX_HEIGHT = 200;
const RATIO = '3 / 2';
const ALT = '商品主图';
const FAILED = '图片没有加载出来';
/** Properties 规划/03 §10.6 lets a transition animate. */
const MOTION_PROPERTIES = new Set(['opacity', 'transform', 'translate', 'scale', 'rotate']);

let root: Root | undefined;
let originalViewport: { width: number; height: number };
let renderFailure: unknown;
const urls: string[] = [];
let imageCount = 0;

beforeEach(async () => {
  originalViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(VIEWPORT.width, VIEWPORT.height);
});

afterEach(async () => {
  unmount();
  for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  await emulate([]);
  await page.viewport(originalViewport.width, originalViewport.height);
});

function unmount(): void {
  observer?.disconnect();
  observer = undefined;
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
}

async function emulate(features: { name: string; value: string }[]): Promise<void> {
  await cdp().send('Emulation.setEmulatedMedia', { features });
}

interface Timing {
  duration: string;
  easing: string;
}

/** A transitionrun seen inside the box, with the timing its element had at that moment. */
interface TransitionRecord {
  property: string;
  target: Element;
  timing: Timing | null;
}

interface Shown {
  box: HTMLElement;
  runs: TransitionRecord[];
  /**
   * Mirrors the box's image frame: `data-frame-state` is the frame's current data-state (the
   * frame may be re-rendered), `data-fade-done` turns "true" once an opacity transition inside the
   * box has ended.
   */
  probe: HTMLElement;
}

let observer: MutationObserver | undefined;

/** One entry of a comma-separated computed list (commas inside parentheses do not split). */
function listItem(list: string, index: number): string {
  const items = list.split(/,(?![^(]*\))/).map((item) => item.trim());
  return items[index % items.length] ?? '';
}

/** Duration and easing of the element's opacity transition, or null when it has none listed. */
function opacityTiming(element: Element): Timing | null {
  const style = getComputedStyle(element);
  const properties = style.transitionProperty.split(',').map((item) => item.trim());
  const index = properties.findIndex((name) => name === 'opacity' || name === 'all');
  if (index < 0) return null;
  return {
    duration: listItem(style.transitionDuration, index),
    easing: listItem(style.transitionTimingFunction, index),
  };
}

/**
 * Renders into a fresh box BOX_WIDTH px wide and records the transitions inside it from the
 * start. Rethrows a render error (e.g. NotImplemented) in the test.
 */
function show(component: ReactNode): Shown {
  unmount();
  const box = document.createElement('div');
  box.style.width = `${BOX_WIDTH}px`;
  box.style.fontFamily = 'var(--font-family-system)';
  const probe = document.createElement('span');
  probe.dataset.fadeDone = 'false';
  probe.dataset.frameState = '';
  document.body.append(box, probe);
  const mirror = (): void => {
    probe.dataset.frameState = box.querySelector(FRAME)?.getAttribute('data-state') ?? '';
  };
  observer = new MutationObserver(mirror);
  observer.observe(box, { subtree: true, childList: true, attributes: true });
  const runs: TransitionRecord[] = [];
  box.addEventListener(
    'transitionrun',
    (event) => {
      if (!(event.target instanceof Element)) return;
      runs.push({
        property: event.propertyName,
        target: event.target,
        timing: event.propertyName === 'opacity' ? opacityTiming(event.target) : null,
      });
    },
    { capture: true },
  );
  box.addEventListener(
    'transitionend',
    (event) => {
      if (event.propertyName === 'opacity') probe.dataset.fadeDone = 'true';
    },
    { capture: true },
  );
  root = createRoot(box, {
    onUncaughtError: (error) => {
      renderFailure = error;
    },
  });
  renderFailure = undefined;
  flushSync(() => root?.render(component));
  const failure = renderFailure;
  renderFailure = undefined;
  if (failure !== undefined) throw failure;
  mirror();
  return { box, runs, probe };
}

/** A fresh PNG (10 × 30, unlike the 3 / 2 frame) as a blob: URL never seen before. */
async function freshImage(): Promise<string> {
  imageCount += 1;
  const canvas = document.createElement('canvas');
  canvas.width = 10;
  canvas.height = 30;
  const context = canvas.getContext('2d');
  expect(context, '2d canvas').not.toBeNull();
  context!.fillStyle = `rgb(${imageCount % 256}, 120, 200)`;
  context!.fillRect(0, 0, 10, 30);
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
  expect(blob, 'PNG blob').not.toBeNull();
  const url = URL.createObjectURL(blob!);
  urls.push(url);
  return url;
}

/** A blob: URL whose bytes are not an image: the img fires `error`. */
function brokenImage(): string {
  imageCount += 1;
  const url = URL.createObjectURL(new Blob([`not an image ${imageCount}`], { type: 'image/png' }));
  urls.push(url);
  return url;
}

function onlyFrameIn(box: HTMLElement): HTMLElement {
  const frames = box.querySelectorAll<HTMLElement>(FRAME);
  expect(frames.length, `one ${FRAME}`).toBe(1);
  return frames[0]!;
}

function onlyImg(frame: HTMLElement): HTMLImageElement {
  const imgs = frame.querySelectorAll('img');
  expect(imgs.length, 'one img in the frame').toBe(1);
  return imgs[0]!;
}

/** Opacity the img is painted with: its own times its ancestors' up to (not including) the frame. */
function shownOpacity(img: HTMLImageElement, frame: HTMLElement): number {
  let opacity = 1;
  for (let node: Element | null = img; node !== null && node !== frame; node = node.parentElement) {
    opacity *= Number.parseFloat(getComputedStyle(node).opacity);
  }
  return opacity;
}

function size(element: Element): [number, number] {
  const rect = element.getBoundingClientRect();
  return [Math.round(rect.width), Math.round(rect.height)];
}

interface ProbeStyle {
  transitionDuration: string;
  transitionTimingFunction: string;
  backgroundColor: string;
}

/** Computed values with `property` set to `value` on a probe (resolves var() the way CSS does). */
function computed(property: 'transition' | 'background-color', value: string): ProbeStyle {
  const probe = document.createElement('div');
  probe.style.setProperty(property, value);
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const snapshot: ProbeStyle = {
    transitionDuration: style.transitionDuration,
    transitionTimingFunction: style.transitionTimingFunction,
    backgroundColor: style.backgroundColor,
  };
  probe.remove();
  return snapshot;
}

/** The frame, or a non-img part covering the whole frame, paints a placeholder token colour. */
function paintsPlaceholder(frame: HTMLElement): boolean {
  const colours = ['--color-background-placeholder', '--color-background-muted'].map(
    (name) => computed('background-color', `var(${name})`).backgroundColor,
  );
  const [width, height] = size(frame);
  return [frame, ...frame.querySelectorAll<HTMLElement>('*')].some((element) => {
    if (element.tagName === 'IMG') return false;
    const [w, h] = size(element);
    if (element !== frame && (w < width || h < height)) return false;
    return colours.includes(getComputedStyle(element).backgroundColor);
  });
}

/** Two animation frames: transition events of the last style change have been dispatched. */
async function twoFrames(): Promise<void> {
  await new Promise<void>((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  });
}

it(
  '[AC-DSX-48c-FADE#1] 加载中是令牌底色占位、保持 3/2 不跳版、图不显示；load 后图以 opacity 渐显，时长与缓动取 --motion-duration-normal / --motion-easing-enter，只动 opacity/transform',
  TEST,
  async () => {
    const AsyncImage = imageComponent();
    const motion = computed(
      'transition',
      'opacity var(--motion-duration-normal) var(--motion-easing-enter)',
    );
    const expected: Timing = {
      duration: motion.transitionDuration,
      easing: motion.transitionTimingFunction,
    };
    expect(Number.parseFloat(expected.duration), 'motion duration > 0').toBeGreaterThan(0);

    const src = await freshImage();
    const { box, runs, probe } = show(
      createElement(AsyncImage, { src, alt: ALT, aspectRatio: RATIO }),
    );
    const loadingFrame = onlyFrameIn(box);
    expect(stateOf(loadingFrame)).toBe('loading');
    // This style read happens before the blob can load: it is the "before" style of the fade.
    expect(shownOpacity(onlyImg(loadingFrame), loadingFrame), 'not shown while loading').toBe(0);
    expect(size(loadingFrame), 'placeholder 300 × 200').toEqual([BOX_WIDTH, BOX_HEIGHT]);
    expect(paintsPlaceholder(loadingFrame), 'token placeholder colour').toBe(true);

    await expect.element(probe, WAIT).toHaveAttribute('data-frame-state', 'loaded');
    await expect.element(probe, WAIT).toHaveAttribute('data-fade-done', 'true');

    const frame = onlyFrameIn(box);
    const img = onlyImg(frame);
    const fades = runs.filter(
      (run) => run.property === 'opacity' && (run.target === img || run.target.contains(img)),
    );
    expect(fades.length, 'an opacity transition on the image (or its wrapper)').toBeGreaterThan(0);
    for (const run of fades) {
      expect(frame.contains(run.target), 'the fading element is inside the frame').toBe(true);
      expect(run.target, 'the frame itself (the placeholder) does not fade').not.toBe(frame);
      expect(run.timing, 'opacity transition timing').toEqual(expected);
    }
    const others = runs.map((run) => run.property).filter((name) => !MOTION_PROPERTIES.has(name));
    expect(others, 'transitions other than opacity / transform').toEqual([]);
    expect(shownOpacity(img, frame), 'fully shown after the fade').toBe(1);
    expect(size(frame), 'frame keeps 300 × 200 after load').toEqual([BOX_WIDTH, BOX_HEIGHT]);
    expect(frame.textContent?.trim() ?? '', 'no text on a loaded image').toBe('');
  },
);

it(
  '[AC-DSX-48c-REDUCED#1] prefers-reduced-motion: reduce 时 load 后图直接完整显示：不跑任何过渡，框尺寸不变',
  TEST,
  async () => {
    const AsyncImage = imageComponent();
    await emulate([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches, 'emulated media').toBe(true);

    const src = await freshImage();
    const { box, runs, probe } = show(
      createElement(AsyncImage, { src, alt: ALT, aspectRatio: RATIO }),
    );
    const loadingFrame = onlyFrameIn(box);
    expect(stateOf(loadingFrame)).toBe('loading');
    expect(size(loadingFrame), 'placeholder 300 × 200').toEqual([BOX_WIDTH, BOX_HEIGHT]);
    expect(shownOpacity(onlyImg(loadingFrame), loadingFrame), 'not shown while loading').toBe(0);

    await expect.element(probe, WAIT).toHaveAttribute('data-frame-state', 'loaded');
    await twoFrames();
    const frame = onlyFrameIn(box);
    const img = onlyImg(frame);
    // Two frames after the switch: a fade (even a 150 ms reduced one) would still be below 1.
    expect(shownOpacity(img, frame), 'fully shown at once').toBe(1);
    const running = frame
      .getAnimations({ subtree: true })
      .filter((animation): animation is CSSTransition => animation instanceof CSSTransition)
      .map((animation) => animation.transitionProperty);
    expect(running, 'transitions under reduced motion').toEqual([]);
    expect(
      runs.map((run) => run.property),
      'transitionrun events under reduced motion',
    ).toEqual([]);
    expect(size(frame), 'frame keeps 300 × 200').toEqual([BOX_WIDTH, BOX_HEIGHT]);
  },
);

it(
  '[AC-DSX-48c-FAILED#1] 图片加载失败：占位底色上显示可见的失败文字，不显示破图，框尺寸不变',
  TEST,
  async () => {
    const AsyncImage = imageComponent();
    const { box, probe } = show(
      createElement(AsyncImage, {
        src: brokenImage(),
        alt: ALT,
        aspectRatio: RATIO,
        failedText: FAILED,
      }),
    );
    expect(size(onlyFrameIn(box)), 'placeholder 300 × 200').toEqual([BOX_WIDTH, BOX_HEIGHT]);

    await expect.element(probe, WAIT).toHaveAttribute('data-frame-state', 'error');
    const text = page.elementLocator(box).getByText(FAILED);
    await expect.element(text, WAIT).toBeVisible();
    const frame = onlyFrameIn(box);
    expect(frame.contains(text.element()), 'failure text inside the frame').toBe(true);
    const painted = shownImgs(frame).filter((img) => {
      const style = getComputedStyle(img);
      return (
        style.display !== 'none' && style.visibility !== 'hidden' && shownOpacity(img, frame) > 0
      );
    });
    expect(painted, 'no broken image painted').toEqual([]);
    expect(size(frame), 'frame keeps 300 × 200').toEqual([BOX_WIDTH, BOX_HEIGHT]);
    expect(paintsPlaceholder(frame), 'token placeholder colour behind the failure text').toBe(true);
  },
);
