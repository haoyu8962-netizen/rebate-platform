// @vitest-environment jsdom
// F1-01v (H5-DARK, 规划/05 §3.11.3, D10-643 ⑦): the light notice (Toast) paints its background and
// its text with one existing role token each, never text-primary as the background, and the pair
// stays readable (WCAG AA body text, ≥ 4.5:1) in light and dark. Which pair is not prescribed.
// Both colours are read from the role="status" element (the text colour may be inherited).
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Toast } from '../../../../apps/h5/src/components/base/index.ts';
import {
  THEMES,
  canvas,
  colorSources,
  composite,
  contrastRatio,
  expectGeneratedTokens,
  required,
  resolveSource,
  textSources,
  tokenSource,
  type TokenSource,
} from './support.ts';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function toastColors(): { background: TokenSource; text: TokenSource } {
  expectGeneratedTokens();
  render(createElement(Toast, { message: 'Fixture notice', durationMs: 60_000 }));
  const status = required('[data-slot="toast-region"] [role="status"]', document.body);
  return {
    background: tokenSource(colorSources(status, 'background'), 'toast background'),
    text: tokenSource(textSources(status), 'toast text'),
  };
}

it('[AC-F1-01v-TOAST#1] 轻提示底色与文字色各取一个令牌变量（不加透明度），底色不是 text-primary', () => {
  const { background, text } = toastColors();
  const bg = `toast background "${background.raw}"`;
  expect(background.variable, bg).not.toBe('--color-text-primary');
  expect(background.opacity, `${bg} opacity modifier`).toBe(1);
  expect(text.opacity, `toast text "${text.raw}" opacity modifier`).toBe(1);
  expect(text.variable, 'toast text and background tokens differ').not.toBe(background.variable);
});

it('[AC-F1-01v-TOAST#2] 轻提示底与字的对比度在浅色、深色下都 ≥ 4.5:1（按令牌值计算）', () => {
  const { background, text } = toastColors();
  for (const theme of THEMES) {
    const surface = composite(resolveSource(background, theme), canvas(theme));
    const ratio = contrastRatio(resolveSource(text, theme), surface);
    const label = `${theme}: ${text.variable} on ${background.variable} contrast`;
    expect(ratio, label).toBeGreaterThanOrEqual(4.5);
  }
});
