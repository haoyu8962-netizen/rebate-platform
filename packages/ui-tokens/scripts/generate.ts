// Writes the generated files of @couli/ui-tokens from contracts/design-tokens.json:
//   src/tokens.gen.css    CSS variables (generateTokensCss)
//   src/tailwind.gen.css  Tailwind 4 @theme aliases (generateTailwindCss)
//   src/theme.gen.ts      TS theme object (generateThemeTs)
//   src/a11y.gen.css      reduced-motion / forced-colors fallbacks (generateA11yCss)
//   src/motion.gen.ts     duration tokens in milliseconds (generateMotionTs)
//   node packages/ui-tokens/scripts/generate.ts           write the files
//   node packages/ui-tokens/scripts/generate.ts --verify  exit 1 when a committed file differs
// The generators are pure; the drift tests in test/spec/frontend/ui-tokens compare the same output.
import { readFileSync, writeFileSync } from 'node:fs';
import type { DesignTokens } from '../src/generate.ts';
import {
  generateA11yCss,
  generateMotionTs,
  generateTailwindCss,
  generateThemeTs,
  generateTokensCss,
} from '../src/generate.ts';

const root = new URL('../../../', import.meta.url);
const args = process.argv.slice(2);
const verify = args.includes('--verify');
const unknown = args.filter((arg) => arg !== '--verify');
if (unknown.length > 0) {
  console.error(`ui-tokens generate: unknown argument(s): ${unknown.join(' ')}`);
  process.exit(2);
}

const tokens = JSON.parse(
  readFileSync(new URL('contracts/design-tokens.json', root), 'utf8'),
) as DesignTokens;
const outputs: [string, string][] = [
  ['packages/ui-tokens/src/tokens.gen.css', generateTokensCss(tokens)],
  ['packages/ui-tokens/src/tailwind.gen.css', generateTailwindCss(tokens)],
  ['packages/ui-tokens/src/theme.gen.ts', generateThemeTs(tokens)],
  ['packages/ui-tokens/src/a11y.gen.css', generateA11yCss(tokens)],
  ['packages/ui-tokens/src/motion.gen.ts', generateMotionTs(tokens)],
];

let stale = 0;
for (const [path, text] of outputs) {
  const url = new URL(path, root);
  if (verify) {
    let current: string | undefined;
    try {
      current = readFileSync(url, 'utf8');
    } catch {
      current = undefined;
    }
    if (current !== text) {
      stale += 1;
      console.error(`${path} is out of date: run node packages/ui-tokens/scripts/generate.ts`);
    }
  } else {
    writeFileSync(url, text);
    console.log(`wrote ${path}`);
  }
}
process.exit(stale > 0 ? 1 : 0);
