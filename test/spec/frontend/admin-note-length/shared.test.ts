// F1-08ed: the shared counting function of the console's note / reason fields,
// apps/admin/src/text-length.ts → codePointLength(text): Unicode code points of the text after
// trimming surrounding whitespace, as the contract and the API count. The module is loaded only
// after its file is asserted to exist, so a missing module is an assertion failure.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { EXT, LIMIT, SHARED_EXPORT, SHARED_MODULE, fits, over, padded } from './support.ts';

type Count = (text: string) => number;

async function loadCount(): Promise<Count> {
  expect(existsSync(SHARED_MODULE), 'apps/admin/src/text-length.ts exists').toBe(true);
  const loaded: unknown = await import(/* @vite-ignore */ pathToFileURL(SHARED_MODULE).href);
  const count = (loaded ?? {}) as Record<string, unknown>;
  expect(
    typeof count[SHARED_EXPORT],
    `apps/admin/src/text-length.ts exports a function ${SHARED_EXPORT}`,
  ).toBe('function');
  return count[SHARED_EXPORT] as Count;
}

it(
  '[AC-F1-08ed-SHARED#1] codePointLength：199 个汉字 + 1 个「𠮷」计 200（UTF-16 是 201），去首尾空白后仍计 200；再多 1 个「𠮷」计 201',
  { timeout: 30_000 },
  async () => {
    const count = await loadCount();
    const note = fits('备');
    expect(note.length, 'sample: 201 UTF-16 units').toBe(LIMIT + 1);
    expect(count(note)).toBe(LIMIT);
    expect(count(padded(note))).toBe(LIMIT);
    expect(count(`\t${note}　`)).toBe(LIMIT);
    expect(count(over('备'))).toBe(LIMIT + 1);
    expect(count(padded(over('备')))).toBe(LIMIT + 1);
    expect(count(EXT.repeat(LIMIT))).toBe(LIMIT);
    expect(count('😀'.repeat(LIMIT))).toBe(LIMIT);
  },
);

it(
  '[AC-F1-08ed-SHARED#2] codePointLength：空串与只有空白计 0；内部空白照计；普通字符与 UTF-16 长度一致',
  { timeout: 30_000 },
  async () => {
    const count = await loadCount();
    expect(count('')).toBe(0);
    expect(count(' \t\n ')).toBe(0);
    expect(count('　')).toBe(0);
    expect(count(`a ${EXT} b`)).toBe(5);
    expect(count('  原 因  ')).toBe(3);
    expect(count('退款备注 abc')).toBe(8);
    expect(count('证'.repeat(LIMIT))).toBe(LIMIT);
    expect(count(`${'证'.repeat(LIMIT)}证`)).toBe(LIMIT + 1);
  },
);
