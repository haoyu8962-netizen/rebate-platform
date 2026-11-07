// DSX-50: the screenshot baselines are in the repository (规划/05 §3.11.3 验收「基准图已入库」).
// Node side only: the browser cases (h5 / admin *.browser.test.ts) compare against these files.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { BASELINES, H5_PAGES, baselineFile } from './pages.ts';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '__baselines__');
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from the IHDR chunk, or null when the bytes are not a PNG. */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

it('[AC-DSX-50-BASELINE#1] 18 张基准图（H5 七页浅深、后台四页浅色）都已入库，是 PNG，宽度不超过该页视口', () => {
  const problems: string[] = [];
  for (const { page, file } of BASELINES) {
    const path = resolve(DIR, file);
    if (!existsSync(path)) {
      problems.push(`${file}：不存在`);
      continue;
    }
    const size = pngSize(readFileSync(path));
    if (size === null) problems.push(`${file}：不是 PNG`);
    else if (size.width === 0 || size.height === 0) problems.push(`${file}：尺寸为 0`);
    else if (size.width > page.viewport.width)
      problems.push(`${file}：宽 ${size.width} 超过视口 ${page.viewport.width}`);
  }
  expect(problems).toEqual([]);
});

it('[AC-DSX-50-BASELINE#2] __baselines__ 里只有这 18 张基准图，没有多余文件', () => {
  const files = existsSync(DIR) ? readdirSync(DIR).sort() : [];
  expect(files).toEqual(BASELINES.map(({ file }) => file).sort());
});

it('[AC-DSX-50-BASELINE#3] H5 七页的深色基准与浅色基准内容不同（深色确实生效）', () => {
  const problems: string[] = [];
  for (const page of H5_PAGES) {
    const light = resolve(DIR, baselineFile(page, 'light'));
    const dark = resolve(DIR, baselineFile(page, 'dark'));
    if (!existsSync(light) || !existsSync(dark)) problems.push(`${page.id}：缺浅色或深色基准`);
    else if (readFileSync(light).equals(readFileSync(dark)))
      problems.push(`${page.id}：深色基准与浅色相同`);
  }
  expect(problems).toEqual([]);
});
