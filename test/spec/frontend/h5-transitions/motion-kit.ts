/// <reference types="@vitest/browser-playwright" />
// DSX-48d browser kit: renders into the page, records every animation the page runs (CSS
// transitions, CSS animations and script animations alike) and measures them, so the tests do not
// depend on how a component animates.
//
// - record(): a per-frame sampler of document.getAnimations() (plus transitionrun / animationstart,
//   so nothing starts and ends unseen). Each animation is described once, when first seen: target,
//   animated properties, duration, easing (the computed transition / animation timing function at
//   that moment, or the script animation's own easing), keyframe start / end values, and the
//   target's size and transform origin. `mark(label)` tags what follows (open, close, …).
//   The sampler writes `data-quiet="true"` onto its marker element once QUIET_FRAMES frames have
//   passed without a finite running animation since the last mark, so the tests wait with
//   expect.element only.
// - tokens(): durations and easings of the --motion-* variables as the loaded styles compute them.
// - placement(): where a transform keyframe value puts a box of the target's size (centre shift
//   and scale), whatever the spelling (transform / translate / scale, matrix or functions).
// - blockEndEvents(): stops transitionend / animationend / …cancel at the window (capture), so
//   nothing below can wait for them (jsdom never fires them either: 编排 D10-1032 ⑤).
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { expect } from 'vitest';
import { cdp, page } from 'vitest/browser';
import {
  DISCRETE_PROPERTIES,
  FADE_EDGE,
  FADED_OUT,
  MOTION_PROPERTIES,
  SHOWN,
  TRANSFORM_PROPERTIES,
} from './contract.ts';

export const WAIT = { timeout: 5_000 } as const;
export const VIEWPORT = { width: 375, height: 812 } as const;

/** Frames without a finite running animation after which a step counts as settled (~200 ms). */
const QUIET_FRAMES = 12;

// --- rendering -----------------------------------------------------------------------------------

let root: Root | undefined;
let renderFailure: unknown;
const cleanups: (() => void)[] = [];

/** Renders into a fresh <main> appended to body; rethrows a render error in the test. */
export function show(component: ReactNode): HTMLElement {
  root?.unmount();
  const container = document.createElement('main');
  container.style.fontFamily = 'var(--font-family-system)';
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

/** Stops every recorder and blocker, unmounts and empties the body. */
export function cleanupAll(): void {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
}

export async function emulate(features: { name: string; value: string }[]): Promise<void> {
  await cdp().send('Emulation.setEmulatedMedia', { features });
}

export async function reduceMotion(): Promise<void> {
  await emulate([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  expect(matchMedia('(prefers-reduced-motion: reduce)').matches, 'emulated reduced motion').toBe(
    true,
  );
}

/** Stops end / cancel events of transitions and animations before they reach any listener. */
export function blockEndEvents(): void {
  const types = ['transitionend', 'transitioncancel', 'animationend', 'animationcancel'];
  const stop = (event: Event): void => {
    event.stopImmediatePropagation();
  };
  for (const type of types) window.addEventListener(type, stop, true);
  cleanups.push(() => {
    for (const type of types) window.removeEventListener(type, stop, true);
  });
}

// --- tokens --------------------------------------------------------------------------------------

/** Milliseconds of a computed CSS time ("0.35s", "250ms"). */
export function milliseconds(time: string): number {
  const value = Number.parseFloat(time);
  return time.trim().endsWith('ms') ? value : value * 1000;
}

export interface Tokens {
  normal: number;
  emphasized: number;
  reducedFade: number;
  standard: string;
  enter: string;
  exit: string;
  emphasizedEnter: string;
  emphasizedExit: string;
}

interface ComputedTiming {
  duration: string;
  easing: string;
}

/** Computed transition duration and timing function of a probe given these values. */
function computedTransition(duration: string, easing: string): ComputedTiming {
  const probe = document.createElement('div');
  probe.style.setProperty('transition-property', 'opacity');
  probe.style.setProperty('transition-duration', duration);
  probe.style.setProperty('transition-timing-function', easing);
  document.documentElement.append(probe);
  const style = getComputedStyle(probe);
  const snapshot = { duration: style.transitionDuration, easing: style.transitionTimingFunction };
  probe.remove();
  return snapshot;
}

/** The --motion-* durations (ms) and easings as the loaded H5 styles compute them. */
export function tokens(): Tokens {
  const duration = (name: string): number =>
    milliseconds(computedTransition(`var(${name})`, 'linear').duration);
  const easing = (name: string): string => computedTransition('1s', `var(${name})`).easing;
  const result: Tokens = {
    normal: duration('--motion-duration-normal'),
    emphasized: duration('--motion-duration-emphasized'),
    reducedFade: duration('--motion-reduced-fade'),
    standard: easing('--motion-easing-standard'),
    enter: easing('--motion-easing-enter'),
    exit: easing('--motion-easing-exit'),
    emphasizedEnter: easing('--motion-easing-emphasized-enter'),
    emphasizedExit: easing('--motion-easing-emphasized-exit'),
  };
  for (const name of ['normal', 'emphasized', 'reducedFade'] as const) {
    expect(result[name], `${name} token from the H5 styles`).toBeGreaterThan(0);
  }
  for (const name of ['standard', 'enter', 'exit', 'emphasizedEnter', 'emphasizedExit'] as const) {
    expect(result[name], `${name} easing token from the H5 styles`).toMatch(/^cubic-bezier\(/);
  }
  return result;
}

// --- samples -------------------------------------------------------------------------------------

type Values = Readonly<Record<string, string>>;

export interface Sample {
  /** Label of the recorder's last mark when the animation was first seen. */
  readonly mark: string;
  readonly target: Element | null;
  readonly pseudo: string | null;
  readonly kind: 'transition' | 'css-animation' | 'script';
  /** transition-property, animation-name or the script animation's id. */
  readonly name: string;
  /** Animated properties, kebab-case. */
  readonly properties: readonly string[];
  readonly durationMs: number;
  readonly easing: string;
  /** Infinite iterations (the skeleton shimmer, spinners): not a transition. */
  readonly endless: boolean;
  /** Keyframe values at offset 0 and 1 (kebab-case keys); may be empty for some engines. */
  readonly from: Values;
  readonly to: Values;
  /** Layout size and computed transform-origin of the target when first seen. */
  readonly width: number;
  readonly height: number;
  readonly origin: string;
  /** Computed opacity / transform values when first and last seen (keyframe fallback). */
  readonly first: Values;
  last: Values;
}

const META_KEYS = new Set(['offset', 'computedOffset', 'easing', 'composite']);

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function frameValues(frame: ComputedKeyframe | undefined): Values {
  const values: Record<string, string> = {};
  if (frame === undefined) return values;
  for (const [key, value] of Object.entries(frame)) {
    if (META_KEYS.has(key) || value === null || value === undefined) continue;
    values[kebab(key)] = String(value);
  }
  return values;
}

function keyframeProperties(frames: ComputedKeyframe[]): string[] {
  const names = new Set<string>();
  for (const frame of frames) {
    for (const key of Object.keys(frame)) if (!META_KEYS.has(key)) names.add(kebab(key));
  }
  return [...names];
}

/** Items of a computed comma-separated list (commas inside parentheses do not split). */
function listItems(list: string): string[] {
  return list.split(/,(?![^(]*\))/).map((item) => item.trim());
}

function itemAt(list: string, index: number): string {
  const items = listItems(list);
  return items[index % items.length] ?? '';
}

function indexIn(list: string, name: string): number {
  const items = listItems(list);
  const own = items.indexOf(name);
  if (own >= 0) return own;
  const all = items.indexOf('all');
  return all >= 0 ? all : 0;
}

function motionValues(target: Element | null, pseudo: string | null): Values {
  if (target === null || !target.isConnected) return {};
  const style = getComputedStyle(target, pseudo);
  const values: Record<string, string> = {};
  for (const property of MOTION_PROPERTIES) values[property] = style.getPropertyValue(property);
  return values;
}

function sampleOf(animation: Animation, mark: string): Sample {
  const effect = animation.effect;
  const keyframes = effect instanceof KeyframeEffect ? effect : null;
  const target = keyframes?.target ?? null;
  const pseudo = keyframes?.pseudoElement ?? null;
  const style = target === null ? null : getComputedStyle(target, pseudo);
  const frames = keyframes?.getKeyframes() ?? [];
  const timing = effect?.getComputedTiming();
  let kind: Sample['kind'];
  let name: string;
  let properties: string[];
  let easing: string;
  if (animation instanceof CSSTransition) {
    kind = 'transition';
    name = animation.transitionProperty;
    properties = [name];
    easing =
      style === null
        ? ''
        : itemAt(style.transitionTimingFunction, indexIn(style.transitionProperty, name));
  } else if (animation instanceof CSSAnimation) {
    kind = 'css-animation';
    name = animation.animationName;
    properties = keyframeProperties(frames);
    easing =
      style === null
        ? ''
        : itemAt(style.animationTimingFunction, indexIn(style.animationName, name));
  } else {
    kind = 'script';
    name = animation.id;
    properties = keyframeProperties(frames);
    const own = effect?.getTiming().easing ?? 'linear';
    easing = own !== 'linear' ? own : String(frames[0]?.easing ?? 'linear');
  }
  const start = frames.find((frame) => frame.computedOffset === 0);
  const end = [...frames].reverse().find((frame) => frame.computedOffset === 1);
  const box = target?.getBoundingClientRect();
  const first = motionValues(target, pseudo);
  return {
    mark,
    target,
    pseudo,
    kind,
    name,
    properties,
    durationMs: Number(timing?.duration ?? 0),
    easing,
    endless: timing?.iterations === Infinity,
    from: frameValues(start),
    to: frameValues(end),
    width: target instanceof HTMLElement ? target.offsetWidth : (box?.width ?? 0),
    height: target instanceof HTMLElement ? target.offsetHeight : (box?.height ?? 0),
    origin: style?.transformOrigin ?? '50% 50%',
    first,
    last: first,
  };
}

function isBusy(animation: Animation): boolean {
  const timing = animation.effect?.getComputedTiming();
  return (
    animation.playState === 'running' &&
    timing?.iterations !== Infinity &&
    Number(timing?.duration ?? 0) > 0
  );
}

export interface Recorder {
  readonly samples: readonly Sample[];
  /** Hidden marker: `data-quiet`, plus the attributes `watch` keeps up to date. */
  readonly probe: HTMLElement;
  /** Labels what is seen from now on; `data-quiet` turns false until the page settles again. */
  mark(label: string): void;
  /** Writes `read()` to `data-<name>` on the marker every frame. */
  watch(name: string, read: () => string): void;
}

/** Starts recording; stopped by cleanupAll(). */
export function record(): Recorder {
  const samples: Sample[] = [];
  const known = new Map<Animation, Sample>();
  const watchers = new Map<string, () => string>();
  const probe = document.createElement('output');
  probe.hidden = true;
  probe.setAttribute('data-quiet', 'false');
  document.body.append(probe);
  let current = 'start';
  let frame = 0;
  let since = 0;
  let busyAt = 0;
  let handle = 0;
  let live = true;

  const collect = (): void => {
    if (!live) return;
    for (const animation of document.getAnimations()) {
      const seen = known.get(animation);
      if (seen !== undefined) {
        const values = motionValues(seen.target, seen.pseudo);
        if (Object.keys(values).length > 0) seen.last = values;
        continue;
      }
      const sample = sampleOf(animation, current);
      known.set(animation, sample);
      samples.push(sample);
    }
  };
  const tick = (): void => {
    if (!live) return;
    frame += 1;
    collect();
    if (document.getAnimations().some(isBusy)) busyAt = frame;
    probe.setAttribute('data-quiet', String(frame - Math.max(busyAt, since) >= QUIET_FRAMES));
    for (const [name, read] of watchers) probe.setAttribute(`data-${name}`, read());
    handle = requestAnimationFrame(tick);
  };
  const events = ['transitionrun', 'transitionstart', 'animationstart'];
  for (const type of events) document.addEventListener(type, collect, true);
  handle = requestAnimationFrame(tick);
  cleanups.push(() => {
    live = false;
    cancelAnimationFrame(handle);
    for (const type of events) document.removeEventListener(type, collect, true);
    probe.remove();
  });

  return {
    samples,
    probe,
    mark(next: string): void {
      collect();
      current = next;
      since = frame;
      probe.setAttribute('data-quiet', 'false');
    },
    watch(name: string, read: () => string): void {
      watchers.set(name, read);
      probe.setAttribute(`data-${name}`, read());
    },
  };
}

/** Waits until no finite animation has run for QUIET_FRAMES frames since the last mark. */
export async function settled(recorder: Recorder): Promise<void> {
  await expect
    .element(page.elementLocator(recorder.probe), WAIT)
    .toHaveAttribute('data-quiet', 'true');
}

// --- reading samples -----------------------------------------------------------------------------

/** Animated properties that show (discrete display / overlay / visibility helpers left out). */
export function shownProperties(sample: Sample): string[] {
  return sample.properties.filter((name) => !DISCRETE_PROPERTIES.includes(name));
}

export function moves(sample: Sample): boolean {
  return sample.properties.some((name) => TRANSFORM_PROPERTIES.includes(name));
}

export function fades(sample: Sample): boolean {
  return sample.properties.includes('opacity');
}

/** Opacity at the start or end of the sample (keyframes, else computed when first / last seen). */
export function opacityAt(sample: Sample, phase: 'from' | 'to'): number {
  const frame = phase === 'from' ? sample.from : sample.to;
  const fallback = phase === 'from' ? sample.first : sample.last;
  const value = frame['opacity'] ?? fallback['opacity'];
  return value === undefined ? Number.NaN : Number.parseFloat(value);
}

export interface Placement {
  /** Shift of the box centre, px (positive: right / down). */
  dx: number;
  dy: number;
  /** Size ratio of the transformed box. */
  sx: number;
  sy: number;
}

/**
 * Where the sample's transform values at `phase` put a box of the target's size: a hidden fixed
 * probe gets the same size, transform origin and transform values, and its box is measured.
 */
export function placement(sample: Sample, phase: 'from' | 'to'): Placement {
  const frame = phase === 'from' ? sample.from : sample.to;
  const fallback = phase === 'from' ? sample.first : sample.last;
  expect(sample.width * sample.height, `${label(sample)}: target has a size`).toBeGreaterThan(0);
  const probe = document.createElement('div');
  const set = (name: string, value: string): void => probe.style.setProperty(name, value);
  set('position', 'fixed');
  set('left', '0px');
  set('top', '0px');
  set('margin', '0px');
  set('padding', '0px');
  set('border', '0px none');
  set('box-sizing', 'border-box');
  set('width', `${sample.width}px`);
  set('height', `${sample.height}px`);
  set('visibility', 'hidden');
  set('pointer-events', 'none');
  set('transform-origin', sample.origin);
  for (const name of TRANSFORM_PROPERTIES) {
    if (!sample.properties.includes(name)) continue;
    const value = frame[name] ?? fallback[name];
    if (value !== undefined && value !== '') set(name, value);
  }
  document.documentElement.append(probe);
  const box = probe.getBoundingClientRect();
  probe.remove();
  return {
    dx: box.left + box.width / 2 - sample.width / 2,
    dy: box.top + box.height / 2 - sample.height / 2,
    sx: box.width / sample.width,
    sy: box.height / sample.height,
  };
}

function nameOf(element: Element | null): string {
  if (element === null) return '(no target)';
  const parts = [element.tagName.toLowerCase()];
  const role = element.getAttribute('role');
  const slot = element.getAttribute('data-slot');
  if (role !== null) parts.push(`[role=${role}]`);
  if (slot !== null) parts.push(`[data-slot=${slot}]`);
  return parts.join('');
}

/** One line per sample for assertion messages. */
export function label(sample: Sample): string {
  return `${sample.mark}: ${sample.kind} ${sample.name} on ${nameOf(sample.target)} [${sample.properties.join(', ')}] ${Math.round(sample.durationMs)}ms ${sample.easing}`;
}

export function labels(samples: readonly Sample[]): string {
  return samples.length === 0 ? '(none)' : samples.map(label).join(' | ');
}

/** Finite samples of `mark` whose target passes `where`. */
export function samplesOf(
  recorder: Recorder,
  mark: string,
  where: (target: Element) => boolean,
): Sample[] {
  return recorder.samples.filter(
    (sample) =>
      sample.mark === mark && !sample.endless && sample.target !== null && where(sample.target),
  );
}

/** True when `element` is `node` or one of its ancestors below body. */
export function around(element: Element, node: Element): boolean {
  return (
    element === node ||
    (element.contains(node) && element !== document.body && element !== document.documentElement)
  );
}

/** Some sample fades in: opacity from ≤ FADE_EDGE to fully shown. */
export function fadesIn(samples: readonly Sample[]): boolean {
  return samples.some(
    (sample) =>
      fades(sample) && opacityAt(sample, 'from') <= FADE_EDGE && opacityAt(sample, 'to') >= SHOWN,
  );
}

/** Some sample fades out: opacity from fully shown to ≤ FADED_OUT. */
export function fadesOut(samples: readonly Sample[]): boolean {
  return samples.some(
    (sample) =>
      fades(sample) && opacityAt(sample, 'from') >= SHOWN && opacityAt(sample, 'to') <= FADED_OUT,
  );
}

/**
 * Samples that fade in only (no movement), with at least one fade from ≤ FADE_EDGE to fully
 * shown; every fading sample takes `durationMs` and, when given, one of `easings`.
 */
export function expectFadeIn(
  samples: readonly Sample[],
  what: string,
  durationMs: number,
  easings: readonly string[] | null,
): void {
  expect(
    fadesIn(samples),
    `${what}: fades in (opacity ≤ ${FADE_EDGE} → 1); seen: ${labels(samples)}`,
  ).toBe(true);
  for (const sample of samples) {
    const shown = shownProperties(sample);
    expect(
      shown.filter((name) => name !== 'opacity'),
      `${what}: only opacity, no movement: ${label(sample)}`,
    ).toEqual([]);
    if (shown.length === 0) continue;
    expect(sample.durationMs, `${what}: duration of ${label(sample)}`).toBeCloseTo(durationMs, 0);
    if (easings !== null) {
      expect(easings, `${what}: easing of ${label(sample)}`).toContain(sample.easing);
    }
  }
}
