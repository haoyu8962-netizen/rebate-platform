// F1-08ed: shared samples of the note / reason length rule tests (no DOM, no React).
//
// The contract (maxLength of the request schemas, validated by Ajv, which counts Unicode code
// points) and the API handlers ([...text].length after trimming) count characters as code points.
// An extension-B character such as 𠮷 (U+20BB7) is one character but two UTF-16 units, so a
// 200-character note with one 𠮷 has `.length` 201.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** apps/admin/src. */
export const ADMIN_SRC = resolve(REPO, 'apps/admin/src');
/** The shared counting module the task adds (exports codePointLength). */
export const SHARED_MODULE = resolve(ADMIN_SRC, 'text-length.ts');
/** The export name of the shared counting function. */
export const SHARED_EXPORT = 'codePointLength';

/** One code point outside the BMP (two UTF-16 units). */
export const EXT = '\u{20BB7}';
/** The limit of every note / reason field in scope (characters = code points after trimming). */
export const LIMIT = 200;

/** 199 copies of `han` + one 𠮷: 200 code points, 201 UTF-16 units. */
export function fits(han: string): string {
  return han.repeat(LIMIT - 1) + EXT;
}
/** 199 copies of `han` + two 𠮷: 201 code points, 203 UTF-16 units. */
export function over(han: string): string {
  return han.repeat(LIMIT - 1) + EXT + EXT;
}
/** `text` with surrounding whitespace (not counted after trimming). */
export function padded(text: string): string {
  return `  ${text} \n`;
}
