// F1-01v (H5-DARK) test support: reads the token source and the generated ui-tokens CSS, resolves
// which colour token an element's classes (or inline style) take, and computes WCAG contrast.
// Independent of the implementation: nothing here imports apps/h5 or @couli/ui-tokens code.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../../../..');

export function readRepo(path: string): string {
  return readFileSync(resolve(REPO, path), 'utf8');
}

export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];

// --- token source (contracts/design-tokens.json) -------------------------------------------------

interface ColorLeaf {
  value: string;
  dark: string;
}

const tokenJson = JSON.parse(readRepo('contracts/design-tokens.json')) as {
  tokens: { color: { overlay: { scrim: ColorLeaf } } };
};

/** color.overlay.scrim as written in the token source: light `value`, dark `dark`. */
export const SCRIM_SOURCE: Record<Theme, string> = {
  light: tokenJson.tokens.color.overlay.scrim.value,
  dark: tokenJson.tokens.color.overlay.scrim.dark,
};

// --- generated CSS (packages/ui-tokens) ----------------------------------------------------------

function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1]!, match[2]!.trim());
  }
  return out;
}

const tokensCss = readRepo('packages/ui-tokens/src/tokens.gen.css');
const lightBlock = /^:root\s*\{([^}]*)\}/m.exec(tokensCss)?.[1];
const darkBlock = /^:root\[data-theme="dark"\]\s*\{([^}]*)\}/m.exec(tokensCss)?.[1];

/** CSS variable → value, per theme, from tokens.gen.css (dark: the explicit data-theme block). */
export const VARIABLES: Record<Theme, Map<string, string>> = {
  light: declarations(lightBlock ?? ''),
  dark: new Map([...declarations(lightBlock ?? ''), ...declarations(darkBlock ?? '')]),
};

/** Tailwind colour name after `couli-` → the token variable it points at (tailwind.gen.css). */
export const COLOR_ALIASES = new Map<string, string>();
const ALIAS = /--color-couli-([a-z0-9-]+)\s*:\s*var\((--color-[a-z0-9-]+)\)\s*;/g;
for (const match of readRepo('packages/ui-tokens/src/tailwind.gen.css').matchAll(ALIAS)) {
  COLOR_ALIASES.set(match[1]!, match[2]!);
}

export function expectGeneratedTokens(): void {
  expect(lightBlock, 'tokens.gen.css :root block').toBeDefined();
  expect(darkBlock, 'tokens.gen.css :root[data-theme="dark"] block').toBeDefined();
  expect(VARIABLES.light.has('--color-overlay-scrim')).toBe(true);
  expect(COLOR_ALIASES.get('overlay-scrim')).toBe('--color-overlay-scrim');
}

// --- colours and WCAG contrast -------------------------------------------------------------------

/** Channels 0–255 (may be fractional after compositing), alpha 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})?$/i;
const NUM = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
const RGB = new RegExp(
  String.raw`^rgba?\(\s*${NUM}\s*,\s*${NUM}\s*,\s*${NUM}\s*(?:,\s*${NUM}\s*)?\)$`,
);

export function parseColor(text: string): Rgba {
  const value = text.trim();
  const hex = HEX.exec(value);
  if (hex !== null) {
    const alpha = hex[4];
    return {
      r: parseInt(hex[1]!, 16),
      g: parseInt(hex[2]!, 16),
      b: parseInt(hex[3]!, 16),
      a: alpha === undefined ? 1 : parseInt(alpha, 16) / 255,
    };
  }
  const fn = RGB.exec(value);
  expect(fn, `colour value "${value}" is #RRGGBB(AA) or rgb(a)()`).not.toBeNull();
  const alpha = fn![4];
  return {
    r: Number(fn![1]),
    g: Number(fn![2]),
    b: Number(fn![3]),
    a: alpha === undefined ? 1 : Number(alpha),
  };
}

/** Source-over compositing of `top` on `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

/** WCAG 2.x relative luminance of an opaque sRGB colour. */
export function relativeLuminance(color: Rgba): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** WCAG contrast ratio of a foreground over an opaque background (foreground alpha composited). */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const fg = relativeLuminance(composite(foreground, background));
  const bg = relativeLuminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

// --- which token an element's colour comes from --------------------------------------------------

export type ColorKind = 'background' | 'text';

/** One colour declaration found on an element. `variable` is null when it is not a token var. */
export interface ColorSource {
  raw: string;
  variable: string | null;
  /** Tailwind opacity modifier as a fraction (1 when there is none, NaN when not a number). */
  opacity: number;
}

/** A colon outside brackets / parentheses marks a variant (`dark:`, `active:`, `data-x:` …). */
function hasVariant(cls: string): boolean {
  let depth = 0;
  for (const ch of cls) {
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    else if (ch === ':' && depth === 0) return true;
  }
  return false;
}

function splitModifier(cls: string): [string, string | undefined] {
  let depth = 0;
  for (let i = cls.length - 1; i >= 0; i -= 1) {
    const ch = cls[i];
    if (ch === ']' || ch === ')') depth += 1;
    else if (ch === '[' || ch === '(') depth -= 1;
    else if (ch === '/' && depth === 0) return [cls.slice(0, i), cls.slice(i + 1)];
  }
  return [cls, undefined];
}

function opacityOf(modifier: string | undefined): number {
  if (modifier === undefined) return 1;
  return /^\d+(?:\.\d+)?$/.test(modifier) ? Number(modifier) / 100 : Number.NaN;
}

function varOf(value: string): string | null {
  return /^var\(\s*(--color-[a-z0-9-]+)\s*\)$/.exec(value.trim())?.[1] ?? null;
}

const BG_NOT_COLOR =
  /^bg-(?:fixed|local|scroll|auto|cover|contain|none|repeat(?:-.*)?|no-repeat|space|round|clip-.*|origin-.*|blend-.*|linear-.*|radial(?:-.*)?|conic(?:-.*)?|gradient-.*|position-.*|size-.*|top.*|bottom.*|left.*|right.*|center|\[url.*)$/;
const TEXT_LITERAL_COLOR =
  /^text-(?:white|black|current|inherit|transparent|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+|\[(?:color:)?(?:#|rgb|hsl|oklch|oklab|lab|lch|hwb).*\])$/;

function classSource(cls: string, kind: ColorKind): ColorSource | null {
  if (hasVariant(cls)) return null;
  const property = /^\[(background-color|background|color):(.+)\]$/.exec(cls);
  if (property !== null) {
    const isBackground = property[1] !== 'color';
    if (isBackground !== (kind === 'background')) return null;
    return { raw: cls, variable: varOf(property[2]!), opacity: 1 };
  }
  const prefix = kind === 'background' ? 'bg-' : 'text-';
  if (!cls.startsWith(prefix)) return null;
  const [utility, modifier] = splitModifier(cls);
  const opacity = opacityOf(modifier);
  const nonToken: ColorSource = { raw: cls, variable: null, opacity };
  const named = /^(?:bg|text)-couli-([a-z0-9-]+)$/.exec(utility);
  if (named !== null) {
    const variable = COLOR_ALIASES.get(named[1]!);
    // text-couli-footnote and the like are font sizes, not colours.
    if (variable === undefined) return kind === 'background' ? nonToken : null;
    return { raw: cls, variable, opacity };
  }
  const arbitrary =
    /^(?:bg|text)-(?:\((?:color:)?(--[a-z0-9-]+)\)|\[(?:color:)?var\((--[a-z0-9-]+)\)\])$/.exec(
      utility,
    );
  if (arbitrary !== null) {
    const variable = arbitrary[1] ?? arbitrary[2]!;
    return { raw: cls, variable: variable.startsWith('--color-') ? variable : null, opacity };
  }
  if (kind === 'background') return BG_NOT_COLOR.test(utility) ? null : nonToken;
  return TEXT_LITERAL_COLOR.test(utility) ? nonToken : null;
}

/** Every colour declaration of `kind` on the element itself: unprefixed classes and inline style. */
export function colorSources(element: Element, kind: ColorKind): ColorSource[] {
  const out: ColorSource[] = [];
  for (const cls of Array.from(element.classList)) {
    const source = classSource(cls, kind);
    if (source !== null) out.push(source);
  }
  if (element instanceof HTMLElement) {
    const properties = kind === 'background' ? ['background-color', 'background'] : ['color'];
    for (const property of properties) {
      const value = element.style.getPropertyValue(property);
      if (value === '') continue;
      out.push({ raw: `${property}: ${value}`, variable: varOf(value), opacity: 1 });
    }
  }
  return out;
}

/** The text colour declarations that apply to the element: its own, else the nearest ancestor's. */
export function textSources(element: Element): ColorSource[] {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const found = colorSources(node, 'text');
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * Asserts the element takes exactly one colour of `kind`, from a token variable defined in
 * tokens.gen.css, and returns it.
 */
export type TokenSource = ColorSource & { variable: string };

export function tokenSource(sources: ColorSource[], what: string): TokenSource {
  expect(
    sources.map((s) => s.raw),
    `${what}: exactly one colour declaration`,
  ).toHaveLength(1);
  const source = sources[0]!;
  const raw = source.raw;
  expect(source.variable, `${what}: "${raw}" reads a --color-* token variable`).not.toBeNull();
  expect(Number.isFinite(source.opacity), `${what}: "${raw}" opacity modifier`).toBe(true);
  expect(
    VARIABLES.light.has(source.variable!) && VARIABLES.dark.has(source.variable!),
    `${what}: ${source.variable} is defined in tokens.gen.css for light and dark`,
  ).toBe(true);
  return source as TokenSource;
}

/** The colour a token source paints in a theme (variable value × opacity modifier). */
export function resolveSource(source: TokenSource, theme: Theme): Rgba {
  const value = VARIABLES[theme].get(source.variable);
  expect(value, `${source.variable} in ${theme}`).toBeDefined();
  const color = parseColor(value!);
  return { ...color, a: color.a * source.opacity };
}

/** The page canvas under every floating layer (apps/h5 body background). */
export function canvas(theme: Theme): Rgba {
  const value = VARIABLES[theme].get('--color-background-canvas');
  expect(value, `--color-background-canvas in ${theme}`).toBeDefined();
  return parseColor(value!);
}

export function required(selector: string, parent: ParentNode = document): HTMLElement {
  const element = parent.querySelector<HTMLElement>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}
