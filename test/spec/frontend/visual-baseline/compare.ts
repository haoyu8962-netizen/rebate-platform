/// <reference types="@vitest/browser-playwright" />
// DSX-50 screenshot baseline comparison, used by the browser cases in this directory. A case puts
// the page into a steady state (fixed time and random numbers, emulated colour scheme, reduced
// motion, fonts and images loaded, animations finished), takes a screenshot of the test page and
// compares it pixel by pixel with __baselines__/<page>-<theme>.png. Every comparison is written to
// test/.tmp/visual-baseline/ (CI uploads that directory as visual-baseline-report-*).
//
// Report only (11 §4.1): a difference above THRESHOLD_PERCENT never fails a case, it is marked with
// overThreshold in the report. A missing baseline does fail it; the screenshot of that run is then
// in the report's images/ directory, from where a reviewed copy becomes the baseline.
//
// The repository is public: pages run only against the existing fixtures (fake servers, fake
// bridges, example data), never against real accounts, tokens or staging.
import { expect, vi } from 'vitest';
import { cdp, commands, page } from 'vitest/browser';
import {
  THRESHOLD_PERCENT,
  baselineFile,
  type Theme,
  type Viewport,
  type VisualPage,
} from './pages.ts';

/** Element waits stay well below the case timeout. */
export const WAIT = { timeout: 8_000 } as const;
export const CASE_TIMEOUT = 30_000;

/** A pixel counts as different when one RGBA channel differs by more than this (0–255). */
export const PIXEL_TOLERANCE = 8;

/**
 * Test-only mutation switch (DSX-50 acceptance: "改一个按钮圆角后，报告能标出该页"): a style that
 * changes the corner radius of every button. Off unless a case turns it on. The self-check
 * compares the mutated screenshot with a reference taken in the same run, only inside the
 * bounding box of the mutated button (a corner change would be diluted over the whole page), and
 * never with the committed baseline (that comparison is report only).
 */
export const MUTATION_STYLE_ID = 'visual-baseline-mutation';
export const MUTATION_CSS =
  'button, [role="button"], [role="tab"], [role="radio"], .ant-btn { border-radius: 50% !important; }';

/** Where the baseline lives in the repository, for messages. */
export const BASELINE_REPO_DIR = 'test/spec/frontend/visual-baseline/__baselines__/';

// commands.readFile / writeFile resolve a relative path against the Vitest project root, which
// for vitest.browser.config.ts is test/ (`test:browser` runs from there). The paths are fixed
// constants relative to that root: import.meta.url of this module in the browser is a Vite
// server URL and does not reliably point at this directory.
/** test/spec/frontend/visual-baseline/__baselines__/, relative to the project root test/. */
export const BASELINE_DIR = 'spec/frontend/visual-baseline/__baselines__/';
/** test/.tmp/visual-baseline/ (git-ignored; uploaded by CI), relative to the project root test/. */
export const REPORT_DIR = '.tmp/visual-baseline/';

/**
 * page: the regular comparison; mutation-reference: the unmutated screenshot of the mutation
 * self-check against the baseline (report only); mutation: with the mutation switch on;
 * mutation-off: the same page after switching it off again; stability: the second of two
 * screenshots taken one after another.
 */
export type Variant = 'page' | 'mutation-reference' | 'mutation' | 'mutation-off' | 'stability';

/** A box in screenshot pixels (CSS pixels, origin at the top left corner of the screenshot). */
export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface VisualReportEntry {
  readonly page: string;
  readonly title: string;
  readonly surface: VisualPage['surface'];
  readonly theme: Theme;
  readonly variant: Variant;
  /**
   * baseline: compared with the committed __baselines__ file; run: compared with a screenshot
   * taken earlier in the same case (referenceImage).
   */
  readonly comparedWith: 'baseline' | 'run';
  /** Only the pixels inside this box were compared; null: the whole screenshot. */
  readonly region: Region | null;
  /** File name under __baselines__/. */
  readonly baseline: string;
  readonly baselineFound: boolean;
  readonly width: number;
  readonly height: number;
  /** Size of the committed baseline (comparedWith baseline only). */
  readonly baselineWidth: number | null;
  readonly baselineHeight: number | null;
  readonly diffPixels: number | null;
  /** Pixels compared: the whole union of both sizes, or the region. */
  readonly totalPixels: number | null;
  /** Differing pixels / compared pixels × 100, rounded to 4 decimals; null without a baseline. */
  readonly diffPercent: number | null;
  readonly thresholdPercent: number;
  readonly overThreshold: boolean;
  /** Paths relative to the report directory. */
  readonly actualImage: string;
  /** comparedWith run only: the reference screenshot of this case. */
  readonly referenceImage: string | null;
  /** Difference image (of the region when there is one). */
  readonly diffImage: string | null;
  /** stability only: difference between the two screenshots of this run. */
  readonly repeatDiffPercent: number | null;
}

export interface Comparison {
  readonly width: number;
  readonly height: number;
  readonly diffPixels: number;
  readonly totalPixels: number;
  readonly diffPercent: number;
  /** PNG (base64) with the differing pixels in red over a faded copy of the screenshot. */
  readonly image: string;
}

/** Entries of this test file, in the order they were recorded (summary written in afterAll). */
const results: VisualReportEntry[] = [];

// ---------------------------------------------------------------------------------------------
// Steady environment

interface Saved {
  readonly theme: string | null;
  readonly width: number;
  readonly height: number;
}

let saved: Saved | undefined;
let random: { mockRestore(): void } | undefined;

/** Deterministic Math.random (mulberry32), so ids and jitter are the same in every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed clock and random numbers, the theme on <html> and in the emulated media, the viewport. */
export async function enterStableEnvironment(options: {
  readonly theme: Theme;
  readonly now: string | number;
  readonly viewport: Viewport;
}): Promise<void> {
  saved = {
    theme: document.documentElement.getAttribute('data-theme'),
    width: innerWidth,
    height: innerHeight,
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(options.now));
  random = vi.spyOn(Math, 'random').mockImplementation(seededRandom(0x0d5c5032));
  document.documentElement.setAttribute('data-theme', options.theme);
  await cdp().send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: options.theme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  await page.viewport(options.viewport.width, options.viewport.height);
}

/** Undo enterStableEnvironment and the mutation switch (safe to call when nothing was entered). */
export async function leaveStableEnvironment(): Promise<void> {
  setMutation(false);
  random?.mockRestore();
  random = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (saved === undefined) return;
  const previous = saved;
  saved = undefined;
  if (previous.theme === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', previous.theme);
  await cdp().send('Emulation.setEmulatedMedia', { features: [] });
  await page.viewport(previous.width, previous.height);
}

/** The test-only mutation switch: adds or removes the button corner radius style. */
export function setMutation(on: boolean): void {
  const existing = document.getElementById(MUTATION_STYLE_ID);
  if (!on) {
    existing?.remove();
    return;
  }
  if (existing !== null) return;
  const style = document.createElement('style');
  style.id = MUTATION_STYLE_ID;
  style.textContent = MUTATION_CSS;
  document.head.append(style);
}

function nextFrames(): Promise<void> {
  return new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

function within(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([promise, new Promise<void>((resolve) => setTimeout(() => resolve(), ms))]);
}

/**
 * Fonts loaded, images decoded (a broken one is left as it is), finite animations run to their
 * end and endless ones cancelled, then two painted frames.
 */
export async function settle(): Promise<void> {
  await document.fonts.ready;
  await Promise.all(
    Array.from(document.images, (image) =>
      image.complete
        ? undefined
        : within(
            image.decode().catch(() => undefined),
            3_000,
          ),
    ),
  );
  for (const animation of document.getAnimations()) {
    const iterations = animation.effect?.getComputedTiming().iterations;
    try {
      if (iterations === Infinity) animation.cancel();
      else animation.finish();
    } catch {
      animation.cancel();
    }
  }
  await nextFrames();
  await document.fonts.ready;
}

// ---------------------------------------------------------------------------------------------
// Screenshots and pixels

/** Screenshot of the test page (PNG, base64), CSS pixels, animations stopped, caret hidden. */
export async function capture(): Promise<string> {
  return page.screenshot({ save: false, animations: 'disabled', caret: 'hide', scale: 'css' });
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('Chromium has no 2D canvas context');
  return context;
}

async function decodePng(base64: string): Promise<ImageData> {
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = context2d(canvas);
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function encodePng(pixels: ImageData): string {
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  context2d(canvas).putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
}

function round(percent: number): number {
  return Math.round(percent * 10_000) / 10_000;
}

/**
 * Pixel comparison over the union of both sizes: where only one image has pixels, they differ.
 */
function comparePixels(actual: ImageData, baseline: ImageData): Comparison {
  const width = Math.max(actual.width, baseline.width);
  const height = Math.max(actual.height, baseline.height);
  const diff = new ImageData(width, height);
  let diffPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      const inActual = x < actual.width && y < actual.height;
      const inBaseline = x < baseline.width && y < baseline.height;
      const a = (y * actual.width + x) * 4;
      const b = (y * baseline.width + x) * 4;
      let differs = !(inActual && inBaseline);
      if (!differs) {
        for (let channel = 0; channel < 4; channel += 1) {
          const delta = Math.abs(actual.data[a + channel]! - baseline.data[b + channel]!);
          if (delta > PIXEL_TOLERANCE) {
            differs = true;
            break;
          }
        }
      }
      if (differs) {
        diffPixels += 1;
        diff.data[out] = 255;
        diff.data[out + 1] = 0;
        diff.data[out + 2] = 0;
        diff.data[out + 3] = 255;
      } else {
        const grey =
          (actual.data[a]! * 0.299 + actual.data[a + 1]! * 0.587 + actual.data[a + 2]! * 0.114) /
          255;
        const faded = Math.round(255 - (1 - grey) * 64);
        diff.data[out] = faded;
        diff.data[out + 1] = faded;
        diff.data[out + 2] = faded;
        diff.data[out + 3] = 255;
      }
    }
  }
  const totalPixels = width * height;
  return {
    width,
    height,
    diffPixels,
    totalPixels,
    diffPercent: round(totalPixels === 0 ? 100 : (diffPixels / totalPixels) * 100),
    image: diffPixels === 0 ? '' : encodePng(diff),
  };
}

/**
 * The bounding box of an element in the pixels of capture(): the screenshot is of <body>, so the
 * box is taken relative to the body's box, rounded outwards to whole pixels.
 */
export function regionOf(element: Element): Region {
  const box = element.getBoundingClientRect();
  const origin = document.body.getBoundingClientRect();
  const left = Math.floor(box.left - origin.left);
  const top = Math.floor(box.top - origin.top);
  const right = Math.ceil(box.right - origin.left);
  const bottom = Math.ceil(box.bottom - origin.top);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The part of an image inside the region (clipped to the image). */
function crop(pixels: ImageData, region: Region): ImageData {
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(pixels.width, Math.ceil(region.x + region.width));
  const bottom = Math.min(pixels.height, Math.ceil(region.y + region.height));
  if (right <= left || bottom <= top) {
    const size = `${pixels.width}×${pixels.height}`;
    throw new Error(`region ${JSON.stringify(region)} lies outside the ${size} screenshot`);
  }
  const width = right - left;
  const out = new ImageData(width, bottom - top);
  for (let y = top; y < bottom; y += 1) {
    const from = (y * pixels.width + left) * 4;
    out.data.set(pixels.data.subarray(from, from + width * 4), (y - top) * width * 4);
  }
  return out;
}

/**
 * Compares two screenshots (PNG, base64): over the whole images, or with a region only over the
 * pixels inside it (the percentage is then of the region's pixels).
 */
export async function compareCaptures(
  actual: string,
  reference: string,
  region: Region | null = null,
): Promise<Comparison> {
  const actualPixels = await decodePng(actual);
  const referencePixels = await decodePng(reference);
  if (region === null) return comparePixels(actualPixels, referencePixels);
  return comparePixels(crop(actualPixels, region), crop(referencePixels, region));
}

/**
 * Whether a command error says the file does not exist. The error crosses the browser RPC, so it
 * may arrive as a plain object and lose its code; the Node message starts with
 * "ENOENT: no such file or directory".
 */
function isMissingFile(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === 'ENOENT') return true;
  if (!('message' in error) || typeof error.message !== 'string') return false;
  return /\bENOENT\b/.test(error.message);
}

/**
 * The baseline (PNG, base64), or null when the file is not in the repository. Any other error
 * (path outside the allowed directories, permissions and the like) is thrown as it is.
 */
export async function readBaseline(target: VisualPage, theme: Theme): Promise<string | null> {
  try {
    return await commands.readFile(`${BASELINE_DIR}${baselineFile(target, theme)}`, 'base64');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Report

function variantDir(variant: Variant): string {
  return variant === 'page' ? 'pages' : variant;
}

function entryPath(variant: Variant, target: VisualPage, theme: Theme): string {
  return `${REPORT_DIR}${variantDir(variant)}/${target.id}-${theme}.json`;
}

/** File stem of the report images of one entry. */
function imageStem(target: VisualPage, theme: Theme, variant: Variant): string {
  return `${target.id}-${theme}${variant === 'page' ? '' : `.${variant}`}`;
}

/** Writes the entry file and keeps the entry for the summary. */
async function writeEntry(
  target: VisualPage,
  entry: VisualReportEntry,
): Promise<VisualReportEntry> {
  await commands.writeFile(
    entryPath(entry.variant, target, entry.theme),
    `${JSON.stringify(entry, null, 2)}\n`,
  );
  results.push(entry);
  return entry;
}

/** A report entry written earlier in this run, or null. */
export async function readEntry(
  variant: Variant,
  target: VisualPage,
  theme: Theme,
): Promise<VisualReportEntry | null> {
  try {
    const text = await commands.readFile(entryPath(variant, target, theme));
    return JSON.parse(text) as VisualReportEntry;
  } catch {
    return null;
  }
}

/**
 * Compares a screenshot with the baseline and writes the entry, the screenshot and (when pixels
 * differ) the difference image to the report directory.
 */
export async function record(
  target: VisualPage,
  theme: Theme,
  variant: Variant,
  actual: string,
  repeatDiffPercent: number | null = null,
): Promise<VisualReportEntry> {
  const stem = imageStem(target, theme, variant);
  const actualImage = `images/${stem}.actual.png`;
  await commands.writeFile(`${REPORT_DIR}${actualImage}`, actual, 'base64');
  const actualPixels = await decodePng(actual);
  const baseline = await readBaseline(target, theme);
  const baselinePixels = baseline === null ? null : await decodePng(baseline);
  const comparison = baselinePixels === null ? null : comparePixels(actualPixels, baselinePixels);
  let diffImage: string | null = null;
  if (comparison !== null && comparison.diffPixels > 0) {
    diffImage = `images/${stem}.diff.png`;
    await commands.writeFile(`${REPORT_DIR}${diffImage}`, comparison.image, 'base64');
  }
  const diffPercent = comparison?.diffPercent ?? null;
  return writeEntry(target, {
    page: target.id,
    title: target.title,
    surface: target.surface,
    theme,
    variant,
    comparedWith: 'baseline',
    region: null,
    baseline: baselineFile(target, theme),
    baselineFound: baselinePixels !== null,
    width: actualPixels.width,
    height: actualPixels.height,
    baselineWidth: baselinePixels?.width ?? null,
    baselineHeight: baselinePixels?.height ?? null,
    diffPixels: comparison?.diffPixels ?? null,
    totalPixels: comparison?.totalPixels ?? null,
    diffPercent,
    thresholdPercent: THRESHOLD_PERCENT,
    overThreshold: diffPercent !== null && diffPercent > THRESHOLD_PERCENT,
    actualImage,
    referenceImage: null,
    diffImage,
    repeatDiffPercent,
  });
}

/**
 * Compares a screenshot with a reference screenshot of the same case (whole image, or only inside
 * the region) and writes the entry, both screenshots and the difference image to the report. The
 * committed baseline is not compared; baselineFound only tells whether it is in the repository.
 */
export async function recordRun(
  target: VisualPage,
  theme: Theme,
  variant: Variant,
  actual: string,
  reference: string,
  region: Region | null,
): Promise<VisualReportEntry> {
  const stem = imageStem(target, theme, variant);
  const actualImage = `images/${stem}.actual.png`;
  const referenceImage = `images/${stem}.reference.png`;
  await commands.writeFile(`${REPORT_DIR}${actualImage}`, actual, 'base64');
  await commands.writeFile(`${REPORT_DIR}${referenceImage}`, reference, 'base64');
  const actualPixels = await decodePng(actual);
  const comparison = await compareCaptures(actual, reference, region);
  let diffImage: string | null = null;
  if (comparison.diffPixels > 0) {
    diffImage = `images/${stem}.diff.png`;
    await commands.writeFile(`${REPORT_DIR}${diffImage}`, comparison.image, 'base64');
  }
  return writeEntry(target, {
    page: target.id,
    title: target.title,
    surface: target.surface,
    theme,
    variant,
    comparedWith: 'run',
    region,
    baseline: baselineFile(target, theme),
    baselineFound: (await readBaseline(target, theme)) !== null,
    width: actualPixels.width,
    height: actualPixels.height,
    baselineWidth: null,
    baselineHeight: null,
    diffPixels: comparison.diffPixels,
    totalPixels: comparison.totalPixels,
    diffPercent: comparison.diffPercent,
    thresholdPercent: THRESHOLD_PERCENT,
    overThreshold: comparison.diffPercent > THRESHOLD_PERCENT,
    actualImage,
    referenceImage,
    diffImage,
    repeatDiffPercent: null,
  });
}

/** The baseline must exist; otherwise the case fails and names where this run's screenshot is. */
export function expectBaseline(entry: VisualReportEntry): void {
  expect(
    entry.baselineFound,
    `基准存在：${BASELINE_REPO_DIR}${entry.baseline}（本次截图在 test/.tmp/visual-baseline/${entry.actualImage}）`,
  ).toBe(true);
}

/**
 * Screenshot, comparison and report entry for one page. Fails only when the baseline is missing
 * or the report does not hold this comparison; a difference above the threshold passes and is
 * marked overThreshold in the report.
 */
export async function checkPage(
  target: VisualPage,
  theme: Theme,
  variant: Variant = 'page',
): Promise<VisualReportEntry> {
  const entry = await record(target, theme, variant, await capture());
  expectBaseline(entry);
  expect(entry.diffPercent, '报告里有这一页的差异百分比').toEqual(expect.any(Number));
  expect(entry.overThreshold, `差异超过 ${THRESHOLD_PERCENT}% 只在报告里标出`).toBe(
    entry.diffPercent! > THRESHOLD_PERCENT,
  );
  expect(await readEntry(variant, target, theme), '报告文件与本次比对一致').toEqual(entry);
  return entry;
}

function percentText(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(4)}%`;
}

function statusText(entry: VisualReportEntry): string {
  if (entry.comparedWith === 'baseline' && !entry.baselineFound) return 'MISSING';
  return entry.overThreshold ? 'OVER' : 'ok';
}

function comparedText(entry: VisualReportEntry): string {
  if (entry.comparedWith === 'baseline') return 'vs baseline';
  const { region } = entry;
  if (region === null) return 'vs run reference';
  return `vs run reference in ${region.width}×${region.height} at ${region.x},${region.y}`;
}

/** Summary of this file's entries: summary-<name>.json and a line per entry in summary-<name>.txt. */
export async function writeSummary(name: string): Promise<void> {
  if (results.length === 0) return;
  const over = results
    .filter((entry) => entry.variant === 'page' && entry.overThreshold)
    .map((entry) => `${entry.page}-${entry.theme}`);
  const missing = results
    .filter((entry) => entry.variant === 'page' && !entry.baselineFound)
    .map((entry) => `${entry.page}-${entry.theme}`);
  // Self-checks (mutation and the like) over the threshold, apart from the regular comparisons.
  const overInChecks = results
    .filter((entry) => entry.variant !== 'page' && entry.overThreshold)
    .map((entry) => `${entry.page}-${entry.theme} (${entry.variant})`);
  const summary = {
    thresholdPercent: THRESHOLD_PERCENT,
    overThreshold: over,
    missingBaseline: missing,
    overThresholdInChecks: overInChecks,
    entries: results,
  };
  await commands.writeFile(
    `${REPORT_DIR}summary-${name}.json`,
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  const lines = results.map((entry) =>
    [
      statusText(entry),
      entry.variant,
      `${entry.page}-${entry.theme}`,
      percentText(entry.diffPercent),
      comparedText(entry),
    ].join('\t'),
  );
  await commands.writeFile(`${REPORT_DIR}summary-${name}.txt`, `${lines.join('\n')}\n`);
}
