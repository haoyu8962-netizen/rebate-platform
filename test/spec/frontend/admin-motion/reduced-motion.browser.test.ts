/// <reference types="@vitest/browser-playwright" />
// DSX-51a (规划/03 §10.6 第 8 条, 手感方案 ⑥, D10-1037): with the system set to reduce motion the
// admin turns antd motion off (ConfigProvider theme.token.motion = false or equivalent); without it
// antd keeps its default motion; a change of the system setting applies at once, the way the
// shell already follows prefers-color-scheme. Measured on a real antd Button in Chromium: antd
// writes its motion durations into the button transition, 0s when motion is off.
// motion-media.ts goes first: it must replace matchMedia before the admin app loads.
import { setReducedMotion } from './motion-media.ts';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { SHORT, ready, sample, showDashboard, unmount } from './motion-browser.ts';

afterEach(() => {
  unmount();
  setReducedMotion(false);
});

/** Transition of the workbench's 【刷新】 antd Button: still (all 0s), moving, or absent. */
function refreshMotion(): string {
  const button = Array.from(document.querySelectorAll<HTMLElement>('main .ant-btn')).find(
    (node) => node.textContent?.includes('刷新') === true,
  );
  if (button === undefined) return 'absent';
  const durations = getComputedStyle(button)
    .transitionDuration.split(',')
    .map((value) => Number.parseFloat(value));
  return durations.every((duration) => duration === 0) ? 'still' : 'moving';
}

it('[AC-DSX-51a-REDUCED#1] 系统设置减弱动态时后台关闭 antd 动效', async () => {
  setReducedMotion(true);
  const marker = showDashboard();
  await ready(marker);
  sample(marker, 'motion', refreshMotion);
  await expect.element(page.elementLocator(marker), SHORT).toHaveAttribute('data-motion', 'still');
});

it('[AC-DSX-51a-REDUCED#2] 不减弱时保持 antd 默认动效，系统设置切换后随之关闭与恢复', async () => {
  setReducedMotion(false);
  const marker = showDashboard();
  await ready(marker);
  sample(marker, 'motion', refreshMotion);
  const state = page.elementLocator(marker);
  await expect.element(state, SHORT).toHaveAttribute('data-motion', 'moving');
  setReducedMotion(true);
  await expect.element(state, SHORT).toHaveAttribute('data-motion', 'still');
  setReducedMotion(false);
  await expect.element(state, SHORT).toHaveAttribute('data-motion', 'moving');
});
