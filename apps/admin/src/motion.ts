// Admin motion (规划/03 §10.6 第 5、8 条; 手感方案 ⑥, D10-1037).
// - Loading indicators wait for motion.skeleton.show-delay before they show, so a short load never
//   flashes a spinner. Every antd Spin takes `delay={LOADING_DELAY_MS}` and every Table takes
//   `loading={delayedLoading(flag, clock)}` with `clock` from useLoadingClock.
// - With the system set to reduce motion the shell turns antd motion off (useReducedMotion feeds
//   createAntdTheme, theme token `motion: false`), following the setting live like the colour
//   scheme.
import { motionSkeletonShowDelayMs } from '@couli/ui-tokens';
import type { SpinProps } from 'antd';
import { useEffect, useState } from 'react';

/** How long a loading indicator stays hidden: the motion.skeleton.show-delay token. */
export const LOADING_DELAY_MS = motionSkeletonShowDelayMs;

/**
 * True from the task after the component first commits. The show-delay of a table that mounts
 * while loading counts from the moment the table is on screen, not from inside the commit that
 * builds it (passive effects of that commit can run before the browser shows anything).
 */
export function useLoadingClock(): boolean {
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setStarted(true), 0);
    return () => clearTimeout(timer);
  }, []);
  return started;
}

/**
 * Table `loading` value: spinning while `spinning` is true, shown only after the show-delay.
 * `clock` comes from useLoadingClock in the component that renders the table.
 */
export function delayedLoading(spinning: boolean, clock: boolean): SpinProps {
  return { spinning: spinning && clock, delay: LOADING_DELAY_MS };
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function reducedMotionList(): MediaQueryList | undefined {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION)
    : undefined;
}

/** True while the system asks for reduced motion; follows changes of the setting. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionList()?.matches === true);
  useEffect(() => {
    const media = reducedMotionList();
    if (media === undefined || typeof media.addEventListener !== 'function') return undefined;
    const refresh = (): void => setReduced(media.matches);
    media.addEventListener('change', refresh);
    // The setting may have changed between the first render and this effect.
    refresh();
    return () => media.removeEventListener('change', refresh);
  }, []);
  return reduced;
}
