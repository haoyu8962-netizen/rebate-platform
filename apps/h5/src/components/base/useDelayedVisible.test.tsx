// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SKELETON_MIN_VISIBLE_MS, SKELETON_SHOW_DELAY_MS } from './motion.ts';
import { useDelayedVisible } from './useDelayedVisible.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

it('keeps a shown skeleton when loading starts again during the hold', () => {
  const view = renderHook(({ loading }) => useDelayedVisible(loading), {
    initialProps: { loading: true },
  });
  advance(SKELETON_SHOW_DELAY_MS);
  expect(view.result.current).toBe(true);
  view.rerender({ loading: false });
  view.rerender({ loading: true });
  advance(SKELETON_MIN_VISIBLE_MS * 3);
  expect(view.result.current).toBe(true);
  view.rerender({ loading: false });
  expect(view.result.current).toBe(false);
});

it('restarts the delay for a second load after the skeleton was hidden', () => {
  const view = renderHook(({ loading }) => useDelayedVisible(loading), {
    initialProps: { loading: false },
  });
  expect(view.result.current).toBe(false);
  view.rerender({ loading: true });
  advance(SKELETON_SHOW_DELAY_MS - 1);
  expect(view.result.current).toBe(false);
  advance(1);
  expect(view.result.current).toBe(true);
});
