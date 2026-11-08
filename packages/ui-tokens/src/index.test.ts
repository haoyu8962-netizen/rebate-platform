// Unit tests for the generator edge cases; the contract-level rules live in test/spec/frontend/ui-tokens.
import { expect, it } from 'vitest';
import type { DesignTokens } from './index.ts';
import {
  generateA11yCss,
  generateTailwindCss,
  generateThemeTs,
  generateTokensCss,
  themeFromTokens,
  themeValuesFromTokens,
  tokenTheme,
  tokenValues,
} from './index.ts';

function doc(tokens: Record<string, unknown>, cssFontBase = 16): DesignTokens {
  return { schemaVersion: 'couli.tokens.v1', metadata: { version: '0.0.0', cssFontBase }, tokens };
}

const dimension = (value: number) => ({ type: 'dimension', value, unit: 'logical' });

it('exports the generated theme object with var() leaves', () => {
  expect(tokenTheme.color.background.canvas).toBe('var(--color-background-canvas)');
  expect(tokenTheme.space['4']).toBe('var(--space-4)');
});

it('spells numbers without exponents or trailing zeros', () => {
  const css = generateTokensCss(
    doc({
      space: { tiny: dimension(1e-7), big: dimension(1e21), half: dimension(0.5) },
      font: { size: { body: { type: 'fontSize', value: 17, unit: 'logical' } } },
    }),
  );
  expect(css).toContain('--space-tiny: 0.0000001px;');
  expect(css).toContain('--space-big: 1000000000000000000000px;');
  expect(css).toContain('--space-half: 0.5px;');
  expect(css).toContain('--font-size-body: 1.0625rem;');
});

it('quotes font families that are not bare identifiers', () => {
  const css = generateTokensCss(
    doc({ font: { family: { ui: { type: 'fontFamily', value: ['a-b', 'Say "hi"', 'x\\y'] } } } }),
  );
  expect(css).toContain('--font-family-ui: a-b, "Say \\"hi\\"", "x\\\\y";');
});

it('renders multi-layer and empty shadows', () => {
  const layer = { x: -1, y: 2, blur: 3, spread: 0, color: '#0A0B0C', opacity: 0.5 };
  const css = generateTokensCss(
    doc({
      shadow: {
        none: { type: 'shadow', value: [] },
        two: { type: 'shadow', value: [layer, { ...layer, opacity: 1 }] },
      },
    }),
  );
  expect(css).toContain('--shadow-none: none;');
  expect(css).toContain(
    '--shadow-two: -1px 2px 3px 0px rgba(10, 11, 12, 0.5), -1px 2px 3px 0px rgba(10, 11, 12, 1);',
  );
});

it('rejects invalid tokens instead of emitting them', () => {
  const bad: Record<string, unknown>[] = [
    { color: { a: { type: 'color', value: '#abcdef' } } },
    { color: { a: { type: 'color' } } },
    { color: { Bad: { type: 'color', value: '#ABCDEF' } } },
    { color: {} },
    { space: { a: { type: 'dimension', value: 4 } } },
    { space: { a: dimension(-1) } },
    { x: { a: { type: 'gradient', value: 'x' } } },
    { shadow: { a: { type: 'shadow', value: [{ x: 0, y: 0, blur: 0, color: '#000000' }] } } },
    { a: { b: dimension(1) }, 'a-b': dimension(1) },
  ];
  for (const tokens of bad) {
    expect(() => generateTokensCss(doc(tokens)), JSON.stringify(tokens)).toThrow(/design tokens/);
  }
  expect(() => generateTokensCss(doc({ space: { a: dimension(1) } }, 0))).toThrow(/cssFontBase/);
});

it('maps Tailwind namespaces without self references and rejects alias collisions', () => {
  const css = generateTailwindCss(
    doc({
      radius: { card: dimension(16) },
      focus: { width: dimension(2) },
      font: { weight: { bold: { type: 'fontWeight', value: 700 } } },
    }),
  );
  expect(css).toContain('  --radius-couli-card: var(--radius-card);');
  expect(css).toContain('  --spacing-couli-focus-width: var(--focus-width);');
  expect(css).toContain('  --font-weight-couli-bold: var(--font-weight-bold);');
  expect(() =>
    generateTailwindCss(
      doc({ space: { 'focus-width': dimension(1) }, focus: { width: dimension(2) } }),
    ),
  ).toThrow(/duplicate Tailwind alias/);
});

it('serializes the theme with quoted keys only where needed', () => {
  const tokens = doc({ space: { '0': dimension(0), 'x-y': dimension(1), z: dimension(2) } });
  expect(themeFromTokens(tokens)).toEqual({
    space: { '0': 'var(--space-0)', 'x-y': 'var(--space-x-y)', z: 'var(--space-z)' },
  });
  expect(generateThemeTs(tokens)).toContain(
    "  space: {\n    '0': 'var(--space-0)',\n    'x-y': 'var(--space-x-y)',\n    z: 'var(--space-z)',\n  },\n",
  );
});

it('converts #RRGGBBAA colors to rgba() with two-decimal alpha', () => {
  const css = generateTokensCss(
    doc({
      color: {
        a: { type: 'color', value: '#28251F66', dark: '#0000008C' },
        b: { type: 'color', value: '#000000FF' },
        c: { type: 'color', value: '#00000000' },
        d: { type: 'color', value: '#00000001' },
      },
    }),
  );
  expect(css).toContain('  --color-a: rgba(40, 37, 31, 0.4);');
  expect(css).toContain('    --color-a: rgba(0, 0, 0, 0.55);');
  expect(css).toContain('--color-b: rgba(0, 0, 0, 1);');
  expect(css).toContain('--color-c: rgba(0, 0, 0, 0);');
  expect(css).toContain('--color-d: rgba(0, 0, 0, 0);');
});

it('writes number tokens and keeps dark blocks to tokens with dark', () => {
  const tokens = doc({
    scale: { type: 'number', value: 1.5 },
    color: {
      a: { type: 'color', value: '#111111', dark: '#222222' },
      b: { type: 'color', value: '#333333' },
    },
  });
  const css = generateTokensCss(tokens);
  expect(css).toContain('  --scale: 1.5;');
  expect(css.match(/--color-a: #222222;/g)).toHaveLength(2);
  expect(css.match(/--color-b:/g)).toHaveLength(1);
  expect(themeValuesFromTokens(tokens, 'dark')).toEqual({
    scale: '1.5',
    color: { a: '#222222', b: '#333333' },
  });
  expect(themeValuesFromTokens(tokens, 'light')).toEqual({
    scale: '1.5',
    color: { a: '#111111', b: '#333333' },
  });
  expect(generateTailwindCss(tokens)).toContain('  --number-couli-scale: var(--scale);');
});

it('rejects dark on other token types and invalid dark values', () => {
  const bad: Record<string, unknown>[] = [
    { space: { a: { ...dimension(1), dark: 2 } } },
    { color: { a: { type: 'color', value: '#111111', dark: '#abcdef' } } },
    { shadow: { a: { type: 'shadow', value: [], dark: {} } } },
    {
      shadow: {
        a: {
          type: 'shadow',
          value: [],
          dark: [{ x: 0, y: 0, blur: 0, spread: 0, color: '#00000080', opacity: 1 }],
        },
      },
    },
  ];
  for (const tokens of bad) {
    expect(() => generateTokensCss(doc(tokens)), JSON.stringify(tokens)).toThrow(/design tokens/);
  }
});

it('exports resolved light and dark values from the committed theme', () => {
  expect(tokenValues.light.color.background.canvas).toBe('#F2EEE6');
  expect(tokenValues.dark.color.background.canvas).toBe('#171513');
  expect(tokenValues.dark.space['4']).toBe(tokenValues.light.space['4']);
});

it('spells motion tokens as milliseconds and cubic-bezier() and aliases easings as ease-*', () => {
  const input = doc({
    motion: {
      duration: { half: { type: 'duration', value: 12.5, unit: 'ms' } },
      easing: { out: { type: 'cubicBezier', value: [0, 0, 0.58, 1] } },
    },
  });
  const css = generateTokensCss(input);
  expect(css).toContain('--motion-duration-half: 12.5ms;');
  expect(css).toContain('--motion-easing-out: cubic-bezier(0, 0, 0.58, 1);');
  const tailwind = generateTailwindCss(input);
  expect(tailwind).toContain('--duration-couli-duration-half: var(--motion-duration-half);');
  expect(tailwind).toContain('--ease-couli-out: var(--motion-easing-out);');
});

it('builds the accessibility fallbacks from token variables and needs the referenced tokens', () => {
  const tokens = {
    motion: { duration: { instant: { type: 'duration', value: 0, unit: 'ms' } } },
    focus: { width: dimension(2), offset: dimension(2) },
  };
  const css = generateA11yCss(doc(tokens));
  expect(css.split('\n')[0]).toContain('Generated by @couli/ui-tokens');
  expect(css).toContain('animation-duration: var(--motion-duration-instant) !important;');
  expect(css).toContain('outline: var(--focus-width) solid Highlight;');
  expect(() => generateA11yCss(doc({ focus: tokens.focus }))).toThrow('motion.duration.instant');
});
