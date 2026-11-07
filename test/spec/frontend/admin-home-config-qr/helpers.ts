// Node-side helpers (jsdom tests) for the home-config preview QR. The browser test imports only
// qr-reader.ts.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { within } from '@testing-library/react';
import { expect } from 'vitest';
import { readQr } from './qr-reader.ts';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Every antd QRCode root on the page. */
export function qrRoots(): Element[] {
  return [...document.querySelectorAll('.ant-qrcode')];
}

/** Exactly one antd QRCode on the page, in the main area, in the region that shows `token`. */
export function previewQr(token: string): Element {
  const roots = qrRoots();
  expect(roots, 'exactly one antd QRCode on the page').toHaveLength(1);
  const root = roots[0]!;
  expect(root.closest('main'), 'QR code in the main area').not.toBeNull();
  let region = root.parentElement;
  while (region && !(region.textContent ?? '').includes(token)) region = region.parentElement;
  expect(region, 'QR code shares a region with the preview token').not.toBeNull();
  expect(region!.matches('body, main, [role="dialog"]'), 'region narrower than the page').toBe(
    false,
  );
  return root;
}

/** The QR code (its svg / canvas, itself or a wrapper) is an image with a non-empty name. */
export function expectQrName(root: Element): void {
  const scope = root.closest('main') as HTMLElement;
  const named = within(scope)
    .queryAllByRole('img', { name: /\S/ })
    .filter((node) => node === root || root.contains(node) || node.contains(root));
  expect(named.length, 'QR code has an accessible name').toBeGreaterThan(0);
}

interface Encoder {
  readonly QrCode: {
    encodeSegments(
      segments: unknown[],
      level: unknown,
      minVersion: number,
      maxVersion: number,
      mask: number,
      boostLevel: boolean,
    ): { getModules(): boolean[][] };
  };
  readonly QrSegment: { makeSegments(text: string): unknown[] };
  readonly Ecc: Readonly<Record<'LOW' | 'MEDIUM' | 'QUARTILE' | 'HIGH', unknown>>;
}
interface Drawing {
  generatePath(modules: boolean[][], margin: number): string;
}

/**
 * Self-check of qr-reader.ts against the encoder antd itself uses (@rc-component/qrcode, resolved
 * through apps/admin's antd; no extra dependency): every level, several versions (both
 * character-count widths, version information, multi-block layouts), every mask, with and
 * without a quiet zone, drawn with the same path generator as antd's SVG.
 */
export function expectReaderAgreesWithAntd(text: string): void {
  const fromAdmin = createRequire(resolve(REPO, 'apps/admin/package.json'));
  const fromAntd = createRequire(fromAdmin.resolve('antd'));
  const encoder = fromAntd('@rc-component/qrcode/lib/libs/qrcodegen.js') as Encoder;
  const { QrCode, QrSegment, Ecc } = encoder;
  const { generatePath } = fromAntd('@rc-component/qrcode/lib/utils.js') as Drawing;
  const misses: string[] = [];
  for (const level of ['LOW', 'MEDIUM', 'QUARTILE', 'HIGH'] as const)
    for (const minVersion of [1, 7, 10, 27])
      for (let mask = 0; mask < 8; mask += 1) {
        const modules = QrCode.encodeSegments(
          QrSegment.makeSegments(text),
          Ecc[level],
          minVersion,
          40,
          mask,
          false,
        ).getModules();
        const margin = mask % 2 === 0 ? 0 : 4;
        const cells = modules.length + margin * 2;
        const host = document.createElement('div');
        const background = `<path d="M0,0 h${cells}v${cells}H0z"></path>`;
        const foreground = `<path d="${generatePath(modules, margin)}"></path>`;
        host.innerHTML = `<svg viewBox="0 0 ${cells} ${cells}">${background}${foreground}</svg>`;
        const result = readQr(host);
        if (!result.ok || result.text !== text)
          misses.push(`${level} v>=${minVersion} mask ${mask}: ${JSON.stringify(result)}`);
      }
  expect(misses, `QR reader self-check for ${JSON.stringify(text)}`).toEqual([]);
}

/** The QR code under `root` encodes exactly `expected` (reader checked against antd first). */
export function expectQrText(root: Element, expected: string): void {
  expectReaderAgreesWithAntd(expected);
  expect(readQr(root), 'text encoded in the preview QR code').toEqual({ ok: true, text: expected });
}
