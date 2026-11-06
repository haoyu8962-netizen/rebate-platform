// @vitest-environment jsdom
// F1-01v (H5-DARK, 规划/05 §3.11.3, D10-643 ⑦): the modal backdrop of ModalFrame (Dialog, Sheet)
// takes only the color.overlay.scrim token, never a text colour with an opacity modifier.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ComponentType } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Dialog, Sheet, type ModalProps } from '../../../../apps/h5/src/components/base/index.ts';
import {
  REPO,
  SCRIM_SOURCE,
  THEMES,
  colorSources,
  expectGeneratedTokens,
  parseColor,
  required,
  resolveSource,
  tokenSource,
} from './support.ts';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function openModal(Component: ComponentType<ModalProps>): HTMLElement {
  const portalContainer = document.createElement('div');
  document.body.append(portalContainer);
  render(
    createElement(Component, {
      open: true,
      title: 'Fixture title',
      description: 'Fixture body text',
      closeLabel: 'Close',
      onClose: vi.fn(),
      portalContainer,
    }),
  );
  return portalContainer;
}

function expectScrimBackdrop(portal: HTMLElement): void {
  expectGeneratedTokens();
  const backdrop = required('[data-slot="modal-backdrop"]', portal);
  const source = tokenSource(colorSources(backdrop, 'background'), 'modal-backdrop background');
  expect(source.variable, `backdrop colour "${source.raw}"`).toBe('--color-overlay-scrim');
  expect(source.opacity, `backdrop colour "${source.raw}" has no opacity modifier`).toBe(1);
  for (const theme of THEMES) {
    const painted = resolveSource(source, theme);
    const expected = parseColor(SCRIM_SOURCE[theme]);
    const rgb = (c: { r: number; g: number; b: number }) => [c.r, c.g, c.b];
    expect(rgb(painted), `${theme} backdrop rgb`).toEqual(rgb(expected));
    expect(painted.a, `${theme} backdrop alpha`).toBeCloseTo(expected.a, 2);
  }
}

it('[AC-F1-01v-SCRIM#1] Dialog 遮罩只取 overlay.scrim 令牌，浅深两态计算值等于令牌源的浅 / 深值', () => {
  expectScrimBackdrop(openModal(Dialog));
});

it('[AC-F1-01v-SCRIM#2] Sheet 遮罩只取 overlay.scrim 令牌，浅深两态计算值等于令牌源的浅 / 深值', () => {
  expectScrimBackdrop(openModal(Sheet));
});

it('[AC-F1-01v-SCRIM#3] apps/h5/src/components 源码里没有以 text-primary 作背景的写法', () => {
  // Render first, so the check also exercises the components it is about.
  required('[data-slot="modal-backdrop"]', openModal(Dialog));
  const directory = resolve(REPO, 'apps/h5/src/components');
  const files = readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.(?:tsx?|css)$/.test(path) && !/\.test\.tsx?$/.test(path))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  const textPrimaryAsBackground = new RegExp(
    [
      String.raw`\bbg-couli-text-primary\b`,
      String.raw`\bbg-(?:\(|\[var\()(?:color:)?--color-(?:couli-)?text-primary\b`,
      String.raw`background(?:-color)?\s*:\s*var\(\s*--color-(?:couli-)?text-primary\b`,
      String.raw`backgroundColor\s*:\s*['"\x60]var\(\s*--color-(?:couli-)?text-primary\b`,
    ].join('|'),
  );
  const offenders = files.filter((path) =>
    textPrimaryAsBackground.test(readFileSync(resolve(directory, path), 'utf8')),
  );
  expect(offenders).toEqual([]);
});
