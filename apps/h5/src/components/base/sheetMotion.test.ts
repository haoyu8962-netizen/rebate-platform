// Sheet panel motion (DSX-48e): the panel slides up from below and fades in, and leaves the same
// way. jsdom does not apply @starting-style or transitions, so the rules are read from the
// stylesheet source.
import { expect, it } from 'vitest';

// Vitest blanks CSS imports (including `?raw`) unless CSS processing is on, and this package has no
// Node typings, so the file is read through a loosely typed `node:fs` import.
const fsModule: string = 'node:fs';
const { readFileSync } = (await import(fsModule)) as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
// A plain path string: in jsdom, `URL` is jsdom's class, which `fs` does not accept.
const cssPath = decodeURIComponent(new URL(import.meta.url).pathname).replace(
  /components\/base\/[^/]+$/,
  'shared/styles/index.css',
);
const css = readFileSync(cssPath, 'utf8');

interface Rule {
  /** Enclosing at-rule preludes, outermost first (e.g. `@layer components`, `@starting-style`). */
  context: string[];
  selectors: string[];
  decls: Map<string, string>;
}

/** A minimal CSS block reader: enough for nested at-rules and plain style rules. */
function parseRules(source: string): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const stack: string[] = [];
  let buffer = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (ch === '}') {
      const prelude = stack.pop() ?? '';
      if (!prelude.startsWith('@')) {
        const decls = new Map<string, string>();
        for (const part of buffer.split(';')) {
          const at = part.indexOf(':');
          if (at > 0) decls.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
        }
        rules.push({
          context: stack.filter((p) => p.startsWith('@')),
          selectors: prelude.split(',').map((s) => s.replace(/\s+/g, ' ').trim()),
          decls,
        });
      }
      buffer = '';
    } else if (ch === ';' && buffer.trim().startsWith('@') && !buffer.includes(':')) {
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return rules;
}

const rules = parseRules(css);

function isReduced(rule: Rule): boolean {
  return rule.context.some((c) => c.includes('prefers-reduced-motion'));
}

function isStarting(rule: Rule): boolean {
  return rule.context.some((c) => c.startsWith('@starting-style'));
}

/** Rules (outside reduced motion) whose selector list contains `selector` exactly. */
function find(selector: string, opts: { starting: boolean }): Rule[] {
  return rules.filter(
    (r) => !isReduced(r) && isStarting(r) === opts.starting && r.selectors.includes(selector),
  );
}

function prop(found: Rule[], name: string): string | undefined {
  let value: string | undefined;
  for (const r of found) value = r.decls.get(name) ?? value;
  return value;
}

it('[DSX-48e#1] the sheet panel transitions both opacity and transform with the emphasized enter tokens', () => {
  const base = find('.h5-modal-sheet', { starting: false });
  expect(base.length).toBeGreaterThan(0);
  const property = prop(base, 'transition-property') ?? prop(base, 'transition') ?? '';
  expect(property).toMatch(/\bopacity\b/);
  expect(property).toMatch(/\btransform\b/);
  expect(prop(base, 'transition-duration')).toBe('var(--motion-duration-emphasized)');
  expect(prop(base, 'transition-timing-function')).toBe('var(--motion-easing-emphasized-enter)');
});

it('[DSX-48e#2] the sheet panel enters from opacity 0 below its resting place', () => {
  const start = find('[data-appear] > .h5-modal-sheet', { starting: true });
  expect(start.length).toBeGreaterThan(0);
  expect(prop(start, 'opacity')).toBe('0');
  expect(prop(start, 'transform')).toBe('translateY(100%)');
});

it('[DSX-48e#3] the closing sheet panel fades to 0 and slides down with the exit tokens', () => {
  const closed = find("[data-state='closed'] > .h5-modal-sheet", { starting: false });
  expect(closed.length).toBeGreaterThan(0);
  expect(prop(closed, 'opacity')).toBe('0');
  expect(prop(closed, 'transform')).toBe('translateY(100%)');
  expect(prop(closed, 'transition-duration')).toBe('var(--motion-duration-normal)');
  expect(prop(closed, 'transition-timing-function')).toBe('var(--motion-easing-emphasized-exit)');
});

it('[DSX-48e#4] under reduced motion the sheet panel only fades', () => {
  const reduced = rules.filter((r) => isReduced(r));
  const base = reduced.filter(
    (r) => !isStarting(r) && r.selectors.includes('[data-state] > .h5-modal-sheet'),
  );
  expect(prop(base, 'transition-property')).toBe('opacity');
  expect(prop(base, 'transition-duration')).toBe('var(--motion-reduced-fade)');
  const start = reduced.filter(
    (r) => isStarting(r) && r.selectors.includes('[data-appear] > .h5-modal-sheet'),
  );
  expect(prop(start, 'opacity')).toBe('0');
  expect(prop(start, 'transform')).toBe('none');
});

it('[DSX-48e#5] sheet motion uses only motion tokens, no literal milliseconds or cubic-bezier', () => {
  const sheet = rules.filter((r) => r.selectors.some((s) => s.includes('.h5-modal-sheet')));
  for (const r of sheet) {
    for (const [name, value] of r.decls) {
      if (!name.startsWith('transition')) continue;
      expect(value, `${r.selectors.join(', ')} { ${name} }`).not.toMatch(/\d\s*m?s\b|cubic-bezier/);
    }
  }
});
