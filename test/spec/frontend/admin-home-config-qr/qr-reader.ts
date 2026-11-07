// Minimal QR Code (model 2) reader for rule tests: turns the module grid that antd's QRCode draws
// with type="svg" (one <path> of one-module-high runs over a viewBox of whole modules, as drawn
// by @rc-component/qrcode) back into text. No error correction: a freshly drawn code has no
// damaged modules, so the data codewords are read as they are. Layout, masks and block tables
// follow ISO/IEC 18004 as implemented by qrcodegen, the encoder inside antd. Supports numeric,
// alphanumeric and byte (UTF-8) segments; anything else is reported as unreadable.

export type Grid = boolean[][];
export type ReadResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string };

// Index 0 is unused; rows are error correction levels by ordinal L, M, Q, H.
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30,
    30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30,
    30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
];
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
    15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23,
    25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34,
    34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35,
    37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
];
// The 2-bit level field of the format information (M=00, L=01, H=10, Q=11) → ordinal L, M, Q, H.
const ORDINAL_OF_FORMAT_LEVEL = [1, 0, 3, 2] as const;
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function fail(reason: string): ReadResult {
  return { ok: false, reason };
}

function emptyGrid(size: number): Grid {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

/** Module grid (quiet zone included) of an @rc-component/qrcode SVG, or why it is unreadable. */
export function svgGrid(svg: Element): Grid | string {
  const viewBox = svg.getAttribute('viewBox') ?? '';
  const box = viewBox
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const size = box[2] ?? Number.NaN;
  if (
    box.length !== 4 ||
    box[0] !== 0 ||
    box[1] !== 0 ||
    box[3] !== size ||
    !Number.isInteger(size) ||
    size < 21
  )
    return `viewBox "${viewBox}" is not a square of whole modules`;
  const background = /^M0,0 h\d+v\d+H0z$/;
  const shapes = [...svg.querySelectorAll('path')]
    .map((path) => path.getAttribute('d') ?? '')
    .filter((d) => !background.test(d));
  if (shapes.length !== 1) return `expected one module path, found ${shapes.length}`;
  const data = shapes[0]!;
  const grid = emptyGrid(size);
  let consumed = 0;
  for (const run of data.matchAll(/M(\d+)[ ,](\d+) ?h(\d+)v1H(\d+)z/g)) {
    if (run.index !== consumed) return `unreadable path data at ${consumed}`;
    consumed += run[0].length;
    const x = Number(run[1]);
    const y = Number(run[2]);
    const width = Number(run[3]);
    if (Number(run[4]) !== x || width < 1 || x + width > size || y >= size)
      return `module run out of bounds at ${run.index}`;
    for (let column = x; column < x + width; column += 1) grid[y]![column] = true;
  }
  if (consumed === 0 || consumed !== data.length) return `unreadable path data at ${consumed}`;
  return grid;
}

/** The symbol without its (possibly empty) light quiet zone. */
function withoutQuietZone(grid: Grid): Grid | string {
  const total = grid.length;
  let top = -1;
  let left = total;
  for (let y = 0; y < total; y += 1)
    for (let x = 0; x < total; x += 1)
      if (grid[y]![x]) {
        if (top < 0) top = y;
        left = Math.min(left, x);
      }
  if (top < 0) return 'no dark module';
  if (left !== top) return 'quiet zone is not even';
  const size = total - 2 * top;
  if (size < 21 || size > 177 || (size - 17) % 4 !== 0)
    return `${size} modules is not a QR Code size`;
  for (let y = 0; y < total; y += 1)
    for (let x = 0; x < total; x += 1) {
      const inside = y >= top && y < top + size && x >= top && x < top + size;
      if (!inside && grid[y]![x]) return 'dark module in the quiet zone';
    }
  return grid.slice(top, top + size).map((row) => row.slice(top, top + size));
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = version * 4 + 10; result.length < count; position -= step)
    result.splice(1, 0, position);
  return result;
}

/** Finder, separator, timing, alignment, format and version modules (never carry data). */
function functionModules(version: number): Grid {
  const size = version * 4 + 17;
  const marked = emptyGrid(size);
  const mark = (x: number, y: number): void => {
    if (x >= 0 && x < size && y >= 0 && y < size) marked[y]![x] = true;
  };
  for (let i = 0; i < size; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const)
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) mark(cx + dx, cy + dy);
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((x, i) =>
    positions.forEach((y, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) mark(x + dx, y + dy);
    }),
  );
  for (let i = 0; i <= 8; i += 1) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  if (version >= 7)
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(a, b);
      mark(b, a);
    }
  return marked;
}

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2;
    result -= (25 * count - 10) * count - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Whether mask pattern `mask` inverts the module in column x, row y. */
function inverted(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function formatWord(data: number): number {
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

function readFormat(grid: Grid): { readonly ordinal: number; readonly mask: number } | string {
  const size = grid.length;
  const at = (x: number, y: number): number => (grid[y]![x] ? 1 : 0);
  let first = 0;
  for (let i = 0; i <= 5; i += 1) first |= at(8, i) << i;
  first |= at(8, 7) << 6;
  first |= at(8, 8) << 7;
  first |= at(7, 8) << 8;
  for (let i = 9; i < 15; i += 1) first |= at(14 - i, 8) << i;
  let second = 0;
  for (let i = 0; i < 8; i += 1) second |= at(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i += 1) second |= at(8, size - 15 + i) << i;
  if (first !== second) return 'the two copies of the format information differ';
  for (let data = 0; data < 32; data += 1)
    if (formatWord(data) === first)
      return { ordinal: ORDINAL_OF_FORMAT_LEVEL[data >>> 3]!, mask: data & 7 };
  return 'format information is not a valid code word';
}

/** All codewords (data and error correction, interleaved) in placement order, unmasked. */
function readCodewords(grid: Grid, version: number, mask: number): number[] | string {
  const size = grid.length;
  const fixed = functionModules(version);
  const bits: boolean[] = [];
  let right = size - 1;
  while (right >= 1) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vertical = 0; vertical < size; vertical += 1)
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const y = upward ? size - 1 - vertical : vertical;
        if (!fixed[y]![x]) bits.push(grid[y]![x] !== inverted(mask, x, y));
      }
    right -= 2;
  }
  if (bits.length !== rawDataModules(version))
    return `found ${bits.length} data modules, expected ${rawDataModules(version)}`;
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => byte * 2 + (bit ? 1 : 0), 0));
  return codewords;
}

/** Data codewords block by block, without the error correction codewords. */
function dataCodewords(codewords: readonly number[], version: number, ordinal: number): number[] {
  const blocks = NUM_ERROR_CORRECTION_BLOCKS[ordinal]![version]!;
  const eccLength = ECC_CODEWORDS_PER_BLOCK[ordinal]![version]!;
  const shortBlocks = blocks - (codewords.length % blocks);
  const shortData = Math.floor(codewords.length / blocks) - eccLength;
  const split: number[][] = Array.from({ length: blocks }, () => []);
  let next = 0;
  for (let i = 0; i <= shortData; i += 1)
    for (let j = 0; j < blocks; j += 1)
      if (i < shortData || j >= shortBlocks) {
        split[j]!.push(codewords[next]!);
        next += 1;
      }
  return split.flat();
}

function readSegments(data: readonly number[], version: number): ReadResult {
  const available = data.length * 8;
  let position = 0;
  const read = (count: number): number | undefined => {
    if (position + count > available) return undefined;
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const index = position + i;
      value = value * 2 + ((data[index >>> 3]! >>> (7 - (index & 7))) & 1);
    }
    position += count;
    return value;
  };
  const group = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  const overrun = fail('a segment runs past the data codewords');
  let text = '';
  while (available - position >= 4) {
    const mode = read(4)!;
    if (mode === 0) break;
    if (mode === 1) {
      let count = read([10, 12, 14][group]!);
      if (count === undefined) return overrun;
      for (; count >= 3; count -= 3) {
        const value = read(10);
        if (value === undefined || value > 999) return overrun;
        text += String(value).padStart(3, '0');
      }
      if (count > 0) {
        const value = read(count === 2 ? 7 : 4);
        if (value === undefined || value >= 10 ** count) return overrun;
        text += String(value).padStart(count, '0');
      }
    } else if (mode === 2) {
      let count = read([9, 11, 13][group]!);
      if (count === undefined) return overrun;
      for (; count >= 2; count -= 2) {
        const value = read(11);
        if (value === undefined || value >= 45 * 45) return overrun;
        text += ALPHANUMERIC[Math.floor(value / 45)]! + ALPHANUMERIC[value % 45]!;
      }
      if (count === 1) {
        const value = read(6);
        if (value === undefined || value >= 45) return overrun;
        text += ALPHANUMERIC[value]!;
      }
    } else if (mode === 4) {
      const count = read([8, 16, 16][group]!);
      if (count === undefined) return overrun;
      const bytes: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const value = read(8);
        if (value === undefined) return overrun;
        bytes.push(value);
      }
      try {
        text += new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
      } catch {
        return fail('byte segment is not UTF-8');
      }
    } else return fail(`unsupported segment mode ${mode}`);
  }
  return { ok: true, text };
}

/** Reads a module grid (quiet zone allowed) as a QR Code symbol. */
export function readGrid(drawn: Grid): ReadResult {
  const grid = withoutQuietZone(drawn);
  if (typeof grid === 'string') return fail(grid);
  const version = (grid.length - 17) / 4;
  const format = readFormat(grid);
  if (typeof format === 'string') return fail(format);
  const codewords = readCodewords(grid, version, format.mask);
  if (typeof codewords === 'string') return fail(codewords);
  return readSegments(dataCodewords(codewords, version, format.ordinal), version);
}

/** Text of the QR code drawn under `root` (an antd QRCode with type="svg"). */
export function readQr(root: Element): ReadResult {
  const svg = root.matches('svg') ? root : root.querySelector('svg');
  if (svg === null)
    return fail('no <svg> in the QR code: render antd QRCode with type="svg" so it can be read');
  const grid = svgGrid(svg);
  return typeof grid === 'string' ? fail(grid) : readGrid(grid);
}
