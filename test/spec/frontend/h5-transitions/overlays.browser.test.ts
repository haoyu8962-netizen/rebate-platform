/// <reference types="@vitest/browser-playwright" />
// DSX-48d overlays in a real Chromium with the shipped H5 styles (手感方案 ⑦, 编排 D10-1032;
// 规划/03 §10.6 items 1–3, 5, 8; design/ui-rules §3.3):
// - SHEET: the bottom sheet slides in from below (its panel starts at least half its height lower
//   and ends in place), emphasized duration and emphasized-enter easing; the backdrop only fades.
//   Closing keeps the same panel on screen while it slides back down with the emphasized-exit
//   easing, in 0.5–0.8 of the enter duration ("退出比进入短（约 2/3）"), then removes it.
// - DIALOG: fades in (opacity ≤ 0.5 → 1) and grows slightly (scale 0.85–0.99 → 1, no slide),
//   emphasized / emphasized-enter; closing fades it out with emphasized-exit, 0.5–0.8 of enter.
// - TOAST: the light notice fades in (normal, enter) and fades out (exit, at most normal) before it
//   is removed; it never moves (its position rules are unchanged).
// - REDUCED: with prefers-reduced-motion: reduce all of them only fade (no translate / scale), the
//   enter fades take --motion-reduced-fade and exits are no longer than that.
// Only opacity / transform animate everywhere. Closing never waits for transitionend /
// animationend: the exit tests stop those events at the window and still expect the element
// removed and focus back on the opener (jsdom never fires them, 编排 D10-1032 ⑤).
// Expected durations and easings are the computed values of the --motion-* variables; motion is
// recorded through document.getAnimations() (motion-kit.ts), so CSS transitions, CSS animations
// and script animations all count. Media features are emulated through CDP.
import { createElement, Fragment, useState, type ComponentType, type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../../../apps/h5/src/shared/styles/index.css';
import {
  Dialog,
  Sheet,
  Toast,
  type ModalProps,
} from '../../../../apps/h5/src/components/base/index.ts';
import {
  BACKDROP,
  DIALOG_MAX_SHIFT,
  DIALOG_START_SCALE,
  EXIT_RATIO,
  MOTION_PROPERTIES,
  SHEET_MIN_TRAVEL,
  TOAST_REGION,
} from './contract.ts';
import {
  VIEWPORT,
  WAIT,
  around,
  blockEndEvents,
  cleanupAll,
  emulate,
  expectFadeIn,
  fades,
  fadesIn,
  fadesOut,
  label,
  labels,
  moves,
  opacityAt,
  placement,
  record,
  reduceMotion,
  samplesOf,
  settled,
  show,
  shownProperties,
  tokens,
  type Recorder,
  type Sample,
} from './motion-kit.ts';

let originalViewport: { width: number; height: number };

beforeEach(async () => {
  originalViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(VIEWPORT.width, VIEWPORT.height);
});

afterEach(async () => {
  cleanupAll();
  await emulate([]);
  await page.viewport(originalViewport.width, originalViewport.height);
});

const OPEN = '打开面板';
const TITLE = '选择方式';
const CLOSE = '关闭面板';

type Modal = ComponentType<ModalProps>;

/** An opener button and the modal it controls, like a page would use it. */
function ModalHarness({ modal }: { modal: Modal }): ReactElement {
  const [open, setOpen] = useState(false);
  return createElement(
    Fragment,
    null,
    createElement('button', { type: 'button', onClick: () => setOpen(true) }, OPEN),
    createElement(
      modal,
      {
        open,
        title: TITLE,
        description: '请确认以下内容后继续',
        closeLabel: CLOSE,
        onClose: () => setOpen(false),
        primaryAction: { label: '确认', onClick: () => setOpen(false) },
      },
      createElement('p', null, '这里是调用方传入的正文。'),
    ),
  );
}

interface Opened {
  recorder: Recorder;
  opener: HTMLElement;
  panel: HTMLElement;
  backdrop: HTMLElement;
  /** Layout height of the panel. */
  height: number;
}

/** Renders the harness, opens the modal with a real click and waits until its motion settled. */
async function openModal(modal: Modal): Promise<Opened> {
  show(createElement(ModalHarness, { modal }));
  const recorder = record();
  const openButton = page.getByRole('button', { name: OPEN, exact: true });
  const opener = openButton.element();
  expect(opener).toBeInstanceOf(HTMLElement);
  recorder.mark('open');
  await openButton.click();
  const dialog = page.getByRole('dialog', { name: TITLE });
  await expect.element(dialog, WAIT).toBeInTheDocument();
  const panel = dialog.element();
  expect(panel).toBeInstanceOf(HTMLElement);
  const backdrop = document.querySelector<HTMLElement>(BACKDROP);
  expect(backdrop, BACKDROP).not.toBeNull();
  recorder.watch('panel-connected', () => String(panel.isConnected));
  await settled(recorder);
  return {
    recorder,
    opener: opener as HTMLElement,
    panel: panel as HTMLElement,
    backdrop: backdrop!,
    height: (panel as HTMLElement).offsetHeight,
  };
}

/**
 * Closes with the close button while transition / animation end events are stopped; waits for
 * focus on the opener, the panel removed and the motion settled.
 */
async function closeModal(opened: Opened): Promise<void> {
  blockEndEvents();
  opened.recorder.mark('close');
  await page.getByRole('button', { name: CLOSE, exact: true }).click();
  await expect.element(page.elementLocator(opened.opener), WAIT).toHaveFocus();
  await expect
    .element(page.elementLocator(opened.recorder.probe), WAIT)
    .toHaveAttribute('data-panel-connected', 'false');
  await settled(opened.recorder);
}

/** Motion of the panel itself or of a wrapper around it that does not hold the backdrop. */
function panelMotion(opened: Opened, mark: string): Sample[] {
  return samplesOf(
    opened.recorder,
    mark,
    (target) => around(target, opened.panel) && !target.contains(opened.backdrop),
  );
}

/** Motion of the panel or of anything around it (the whole layer included). */
function panelOrLayerMotion(opened: Opened, mark: string): Sample[] {
  return samplesOf(opened.recorder, mark, (target) => around(target, opened.panel));
}

/** Motion of the backdrop or of anything around it. */
function backdropMotion(opened: Opened, mark: string): Sample[] {
  return samplesOf(opened.recorder, mark, (target) => around(target, opened.backdrop));
}

/** Everything of the modal: panel, backdrop, their wrappers and the panel's content. */
function modalMotion(opened: Opened, mark: string): Sample[] {
  return samplesOf(
    opened.recorder,
    mark,
    (target) =>
      around(target, opened.panel) ||
      around(target, opened.backdrop) ||
      opened.panel.contains(target),
  );
}

function expectOnlyMotionProperties(samples: readonly Sample[], what: string): void {
  for (const sample of samples) {
    expect(
      shownProperties(sample).filter((name) => !MOTION_PROPERTIES.includes(name)),
      `${what}: only opacity / transform: ${label(sample)}`,
    ).toEqual([]);
  }
}

function expectEnterTiming(
  samples: readonly Sample[],
  what: string,
  durationMs: number,
  easing: string,
): void {
  expectOnlyMotionProperties(samples, what);
  for (const sample of samples) {
    if (shownProperties(sample).length === 0) continue;
    expect(sample.durationMs, `${what}: duration of ${label(sample)}`).toBeCloseTo(durationMs, 0);
    expect(sample.easing, `${what}: easing of ${label(sample)}`).toBe(easing);
  }
}

function expectExitTiming(
  samples: readonly Sample[],
  what: string,
  enterMs: number,
  easing: string,
): void {
  expectOnlyMotionProperties(samples, what);
  for (const sample of samples) {
    if (shownProperties(sample).length === 0) continue;
    const ratio = sample.durationMs / enterMs;
    expect(ratio, `${what}: exit / enter duration of ${label(sample)}`).toBeGreaterThanOrEqual(
      EXIT_RATIO.min,
    );
    expect(ratio, `${what}: exit / enter duration of ${label(sample)}`).toBeLessThanOrEqual(
      EXIT_RATIO.max,
    );
    expect(sample.easing, `${what}: easing of ${label(sample)}`).toBe(easing);
  }
}

/** The backdrop only fades, in the given direction. */
function expectBackdropFade(opened: Opened, mark: string, direction: 'in' | 'out'): void {
  const samples = backdropMotion(opened, mark);
  for (const sample of samples) {
    expect(
      shownProperties(sample).filter((name) => name !== 'opacity'),
      `backdrop only fades: ${label(sample)}`,
    ).toEqual([]);
  }
  expect(
    samples.some((sample) => {
      if (!fades(sample)) return false;
      const from = opacityAt(sample, 'from');
      const to = opacityAt(sample, 'to');
      return direction === 'in' ? from < to : from > to;
    }),
    `backdrop fades ${direction}; seen: ${labels(samples)}`,
  ).toBe(true);
}

it(
  '[AC-DSX-48d-SHEET#1] Sheet 打开：面板从下滑入（起点下移不少于半个面板高、终点归位），只动 opacity / transform，时长取 --motion-duration-emphasized、缓动取 --motion-easing-emphasized-enter；遮罩只淡入',
  { timeout: 30_000 },
  async () => {
    const motion = tokens();
    const opened = await openModal(Sheet);
    const enter = panelMotion(opened, 'open');
    expect(
      enter.length,
      `sheet panel enter motion; seen: ${labels(opened.recorder.samples)}`,
    ).toBeGreaterThan(0);
    expectEnterTiming(enter, 'sheet enter', motion.emphasized, motion.emphasizedEnter);
    const slides = enter.filter(moves);
    expect(slides.length, `sheet panel slides; seen: ${labels(enter)}`).toBeGreaterThan(0);
    const start = Math.max(...slides.map((sample) => placement(sample, 'from').dy));
    expect(start, 'starts below by at least half the panel height').toBeGreaterThanOrEqual(
      opened.height * SHEET_MIN_TRAVEL,
    );
    for (const sample of slides) {
      const end = placement(sample, 'to');
      expect(Math.abs(end.dy), `ends in place: ${label(sample)}`).toBeLessThanOrEqual(1);
      expect(end.sx, `ends at full size: ${label(sample)}`).toBeCloseTo(1, 2);
    }
    expectBackdropFade(opened, 'open', 'in');
  },
);

it(
  '[AC-DSX-48d-SHEET#2] Sheet 关闭：同一面板向下滑出后才移除，缓动取 --motion-easing-emphasized-exit、时长为进入的 0.5–0.8，遮罩淡出；拦掉 transitionend / animationend 仍按时移除，焦点回到打开者',
  { timeout: 30_000 },
  async () => {
    const motion = tokens();
    const opened = await openModal(Sheet);
    await closeModal(opened);
    const exit = panelMotion(opened, 'close');
    expect(
      exit.length,
      `the panel plays an exit motion before it is removed; seen: ${labels(opened.recorder.samples)}`,
    ).toBeGreaterThan(0);
    expectExitTiming(exit, 'sheet exit', motion.emphasized, motion.emphasizedExit);
    const slides = exit.filter(moves);
    expect(slides.length, `sheet panel slides out; seen: ${labels(exit)}`).toBeGreaterThan(0);
    const end = Math.max(...slides.map((sample) => placement(sample, 'to').dy));
    expect(end, 'ends below by at least half the panel height').toBeGreaterThanOrEqual(
      opened.height * SHEET_MIN_TRAVEL,
    );
    expectBackdropFade(opened, 'close', 'out');
  },
);

it(
  '[AC-DSX-48d-DIALOG#1] Dialog 打开：淡入（起点 opacity ≤ 0.5）加轻微放大（起点 scale 0.85–0.99、终点 1，不平移），时长取 --motion-duration-emphasized、缓动取 --motion-easing-emphasized-enter；遮罩只淡入',
  { timeout: 30_000 },
  async () => {
    const motion = tokens();
    const opened = await openModal(Dialog);
    const layered = panelOrLayerMotion(opened, 'open');
    expect(fadesIn(layered), `dialog fades in; seen: ${labels(opened.recorder.samples)}`).toBe(
      true,
    );
    expectEnterTiming(layered, 'dialog enter', motion.emphasized, motion.emphasizedEnter);
    const grows = panelMotion(opened, 'open').filter(moves);
    expect(grows.length, `dialog panel grows; seen: ${labels(layered)}`).toBeGreaterThan(0);
    const starts = grows.map((sample) => placement(sample, 'from'));
    expect(
      starts.some(
        (start) =>
          start.sx >= DIALOG_START_SCALE.min &&
          start.sx <= DIALOG_START_SCALE.max &&
          Math.abs(start.sy - start.sx) <= 0.01,
      ),
      `starts slightly smaller (scale ${DIALOG_START_SCALE.min}–${DIALOG_START_SCALE.max}); starts: ${JSON.stringify(starts)}`,
    ).toBe(true);
    for (const [index, start] of starts.entries()) {
      const shift = Math.max(Math.abs(start.dx), Math.abs(start.dy));
      expect(shift, `does not slide: ${label(grows[index]!)}`).toBeLessThanOrEqual(
        opened.height * DIALOG_MAX_SHIFT,
      );
    }
    for (const sample of grows) {
      const end = placement(sample, 'to');
      expect(end.sx, `ends at full size: ${label(sample)}`).toBeCloseTo(1, 2);
      expect(Math.abs(end.dy), `ends in place: ${label(sample)}`).toBeLessThanOrEqual(1);
    }
    expectBackdropFade(opened, 'open', 'in');
  },
);

it(
  '[AC-DSX-48d-DIALOG#2] Dialog 关闭：同一面板淡出（终点 opacity ≤ 0.1）后才移除，缓动取 --motion-easing-emphasized-exit、时长为进入的 0.5–0.8，遮罩淡出；拦掉 transitionend / animationend 仍按时移除，焦点回到打开者',
  { timeout: 30_000 },
  async () => {
    const motion = tokens();
    const opened = await openModal(Dialog);
    await closeModal(opened);
    const exit = panelOrLayerMotion(opened, 'close');
    expect(
      fadesOut(exit),
      `the dialog fades out before it is removed; seen: ${labels(opened.recorder.samples)}`,
    ).toBe(true);
    expectExitTiming(exit, 'dialog exit', motion.emphasized, motion.emphasizedExit);
    expectBackdropFade(opened, 'close', 'out');
  },
);

const MODALS: readonly (readonly [string, Modal])[] = [
  ['Sheet', Sheet],
  ['Dialog', Dialog],
];

it(
  '[AC-DSX-48d-REDUCED#1] 减弱动态：Sheet 与 Dialog 进出只淡入淡出（无位移、无缩放），进入时长取 --motion-reduced-fade、退出不长于它；拦掉结束事件仍按时移除、焦点回到打开者',
  { timeout: 30_000 },
  async () => {
    const motion = tokens();
    await reduceMotion();
    for (const [name, modal] of MODALS) {
      const opened = await openModal(modal);
      const enter = modalMotion(opened, 'open');
      expect(
        fadesIn(panelOrLayerMotion(opened, 'open')),
        `${name}: fades in under reduced motion; seen: ${labels(opened.recorder.samples)}`,
      ).toBe(true);
      for (const sample of enter) {
        const shown = shownProperties(sample);
        expect(
          shown.filter((property) => property !== 'opacity'),
          `${name}: only fades under reduced motion: ${label(sample)}`,
        ).toEqual([]);
        if (shown.length === 0) continue;
        expect(sample.durationMs, `${name}: duration of ${label(sample)}`).toBeCloseTo(
          motion.reducedFade,
          0,
        );
      }
      await closeModal(opened);
      for (const sample of modalMotion(opened, 'close')) {
        const shown = shownProperties(sample);
        expect(
          shown.filter((property) => property !== 'opacity'),
          `${name}: only fades out under reduced motion: ${label(sample)}`,
        ).toEqual([]);
        if (shown.length === 0) continue;
        expect(sample.durationMs, `${name}: exit duration of ${label(sample)}`).toBeLessThanOrEqual(
          motion.reducedFade + 0.5,
        );
      }
      cleanupAll();
    }
  },
);

// --- light notice --------------------------------------------------------------------------------

const MESSAGE = '已复制口令';
/** Display time of the notice in these tests; the exit fade ends by then (frozen F1-01f-TOAST). */
const DISPLAY_MS = 1_500;

interface ShownToast {
  recorder: Recorder;
  status: HTMLElement;
  region: HTMLElement;
}

async function showToast(): Promise<ShownToast> {
  const recorder = record();
  recorder.mark('open');
  show(createElement(Toast, { message: MESSAGE, durationMs: DISPLAY_MS }));
  const status = document.querySelector<HTMLElement>(`${TOAST_REGION} [role="status"]`);
  expect(status, 'the notice in its region').not.toBeNull();
  const region = status!.closest<HTMLElement>(TOAST_REGION);
  expect(region, TOAST_REGION).not.toBeNull();
  recorder.watch('status-connected', () => String(status!.isConnected));
  await settled(recorder);
  return { recorder, status: status!, region: region! };
}

/** Motion of the notice, of its content, or of a wrapper of it inside the region. */
function toastMotion(shown: ShownToast, mark: string): Sample[] {
  return samplesOf(
    shown.recorder,
    mark,
    (target) =>
      target === shown.status ||
      shown.status.contains(target) ||
      (target.contains(shown.status) && shown.region.contains(target) && target !== shown.region),
  );
}

/** Waits (end events stopped) until the notice is removed by its own timer. */
async function toastGone(shown: ShownToast): Promise<void> {
  blockEndEvents();
  shown.recorder.mark('close');
  await expect
    .element(page.elementLocator(shown.recorder.probe), {
      timeout: DISPLAY_MS + WAIT.timeout,
    })
    .toHaveAttribute('data-status-connected', 'false');
}

it(
  '[AC-DSX-48d-TOAST#1] 轻提示进出淡入淡出：进入只动 opacity（不位移），时长取 --motion-duration-normal、缓动取 --motion-easing-enter；到时前以 --motion-easing-exit 淡出（不长于 normal）再移除，拦掉结束事件也按时移除',
  { timeout: 30_000 },
  async () => {
    const motion = tokens();
    const shown = await showToast();
    expectFadeIn(toastMotion(shown, 'open'), 'toast enter', motion.normal, [motion.enter]);
    await toastGone(shown);
    const exit = toastMotion(shown, 'close');
    expect(fadesOut(exit), `toast fades out before removal; seen: ${labels(exit)}`).toBe(true);
    for (const sample of exit) {
      const properties = shownProperties(sample);
      expect(
        properties.filter((name) => name !== 'opacity'),
        `toast exit only fades: ${label(sample)}`,
      ).toEqual([]);
      if (properties.length === 0) continue;
      expect(sample.easing, `toast exit easing: ${label(sample)}`).toBe(motion.exit);
      expect(sample.durationMs, `toast exit duration: ${label(sample)}`).toBeGreaterThan(0);
      expect(sample.durationMs, `toast exit duration: ${label(sample)}`).toBeLessThanOrEqual(
        motion.normal + 0.5,
      );
    }
  },
);

it(
  '[AC-DSX-48d-TOAST#2] 减弱动态：轻提示只淡入淡出，进入时长取 --motion-reduced-fade，退出不长于它，到时移除',
  { timeout: 30_000 },
  async () => {
    const motion = tokens();
    await reduceMotion();
    const shown = await showToast();
    expectFadeIn(toastMotion(shown, 'open'), 'toast enter (reduced)', motion.reducedFade, null);
    await toastGone(shown);
    for (const sample of toastMotion(shown, 'close')) {
      const properties = shownProperties(sample);
      expect(
        properties.filter((name) => name !== 'opacity'),
        `toast exit only fades: ${label(sample)}`,
      ).toEqual([]);
      if (properties.length === 0) continue;
      expect(sample.durationMs, `toast exit duration: ${label(sample)}`).toBeLessThanOrEqual(
        motion.reducedFade + 0.5,
      );
    }
  },
);
