// @vitest-environment jsdom
// F1-01v (H5-DARK, 规划/05 §3.11.3, D10-643 ⑦): light / dark contrast of the H5 base layers,
// computed from the generated token values (WCAG relative luminance; a translucent layer is first
// composited over what lies below it). Covered per theme: the Dialog / Sheet panel over the scrim
// with its body text, and the Toast background with its text. The scrim itself is only checked
// for which token it takes, not for contrast.
import { createElement, type ComponentType } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Dialog,
  Sheet,
  Toast,
  type ModalProps,
} from '../../../../apps/h5/src/components/base/index.ts';
import {
  canvas,
  colorSources,
  composite,
  contrastRatio,
  expectGeneratedTokens,
  parseColor,
  required,
  resolveSource,
  textSources,
  tokenSource,
  type Theme,
} from './support.ts';

const BODY_TEXT = 'Fixture body text';
const AA_TEXT = 4.5;

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function reset(): void {
  cleanup();
  document.body.replaceChildren();
}

function expectFormula(): void {
  const white = parseColor('#FFFFFF');
  expect(contrastRatio(parseColor('#000000'), white)).toBeCloseTo(21, 5);
  expect(contrastRatio(parseColor('#767676'), white)).toBeCloseTo(4.54, 1);
  // #00000080 over white composites to #7F7F7F (4.00:1 against white).
  expect(contrastRatio(parseColor('#00000080'), white)).toBeCloseTo(4, 1);
}

function expectModalPanel(
  Component: ComponentType<ModalProps>,
  component: string,
  theme: Theme,
): void {
  const portal = document.createElement('div');
  document.body.append(portal);
  render(
    createElement(Component, {
      open: true,
      title: 'Fixture title',
      description: BODY_TEXT,
      closeLabel: 'Close',
      onClose: vi.fn(),
      portalContainer: portal,
    }),
  );
  const name = `${component} (${theme})`;
  const backdrop = required('[data-slot="modal-backdrop"]', portal);
  const scrim = tokenSource(colorSources(backdrop, 'background'), `${name} backdrop`);
  expect(scrim.variable, `${name} backdrop "${scrim.raw}"`).toBe('--color-overlay-scrim');
  expect(scrim.opacity, `${name} backdrop "${scrim.raw}" opacity modifier`).toBe(1);
  const underPanel = composite(resolveSource(scrim, theme), canvas(theme));

  const panel = required('[role="dialog"]', portal);
  const panelSource = tokenSource(colorSources(panel, 'background'), `${name} panel background`);
  const panelColor = composite(resolveSource(panelSource, theme), underPanel);

  const body = Array.from(portal.querySelectorAll('p')).find((p) => p.textContent === BODY_TEXT);
  expect(body, `${name} body text element`).toBeDefined();
  const textSource = tokenSource(textSources(body!), `${name} body text`);
  const ratio = contrastRatio(resolveSource(textSource, theme), panelColor);
  const label = `${name}: ${textSource.variable} on ${panelSource.variable} contrast`;
  expect(ratio, label).toBeGreaterThanOrEqual(AA_TEXT);
  reset();
}

function expectToast(theme: Theme): void {
  render(createElement(Toast, { message: 'Fixture notice', durationMs: 60_000 }));
  const status = required('[data-slot="toast-region"] [role="status"]', document.body);
  const background = tokenSource(colorSources(status, 'background'), `toast ${theme} background`);
  const text = tokenSource(textSources(status), `toast ${theme} text`);
  const surface = composite(resolveSource(background, theme), canvas(theme));
  const ratio = contrastRatio(resolveSource(text, theme), surface);
  const label = `toast (${theme}): ${text.variable} on ${background.variable} contrast`;
  expect(ratio, label).toBeGreaterThanOrEqual(AA_TEXT);
  reset();
}

it('[AC-F1-01v-CONTRAST#1] 浅色：遮罩（overlay.scrim）之上的 Dialog / Sheet 面板与正文、轻提示底与字对比度都 ≥ 4.5:1', () => {
  expectGeneratedTokens();
  expectFormula();
  expectModalPanel(Dialog, 'Dialog', 'light');
  expectModalPanel(Sheet, 'Sheet', 'light');
  expectToast('light');
});

it('[AC-F1-01v-CONTRAST#2] 深色：遮罩（overlay.scrim）之上的 Dialog / Sheet 面板与正文、轻提示底与字对比度都 ≥ 4.5:1', () => {
  expectGeneratedTokens();
  expectFormula();
  expectModalPanel(Dialog, 'Dialog', 'dark');
  expectModalPanel(Sheet, 'Sheet', 'dark');
  expectToast('dark');
});
