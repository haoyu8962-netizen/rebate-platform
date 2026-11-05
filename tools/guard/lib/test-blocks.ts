// Which rule tests of a file changed since the base (CT-06p; red check, 规划/11 §2.3 step 3).
//
// A rule-test file that already existed at the base and is changed again by a task (an exact
// assertion synchronised with a new column, a new test added next to the old ones) needs only its
// new and changed tests red: the unchanged ones were shown red when they were added and may pass
// on the new skeleton. This module tells them apart, and it does so conservatively — whatever it
// cannot read for certain counts as changed (the test must be red, as before):
//
// - The file is cut into test blocks — every outermost call of `it` / `test` imported from
//   'vitest' (with its modifier chain: `.each(table)`, `.concurrent`, `.for`, type arguments …, and the
//   `;` that ends it) — and the shared rest: imports, helpers, top-level constants and tables,
//   hooks, loops, `describe` headers and bodies. Both are compared token by token: comments and
//   the amount of whitespace do not count, a line break between two tokens does (ASI), string,
//   template and regular-expression literals count byte for byte.
// - Any difference in the shared rest makes every test of the file changed (a helper, a hook, an
//   import, a top-level table or a describe title can change what any test means).
// - A test block is unchanged only when the same block (same text at the same place of the
//   shared rest — same number of shared tokens before it — in the same describes)
//   occurs exactly once at the base and exactly once at the head, and the unchanged blocks keep
//   their relative order (a moved test is changed: the order of a file's tests can matter).
//   A renamed test is a new block; a row of a parameterised table (`it.each([...])`) that changed
//   changes the block, so every case of that table must be red.
// - A test of the report belongs to a block through the block's title pattern: the describe
//   titles and the test title, exact for plain literals, a wildcard for every `${…}` of a template,
//   for every non-literal title and, in `.each` / `.for` titles, for every `%x` and `$name`
//   Vitest formats; an unknown suite prefix is always allowed. A test is exempt only when exactly
//   one block's pattern matches its full name and that block is unchanged. Patterns are supersets
//   of the names a block can produce, so a test whose own block changed always matches that block.
// - A file that cannot be tokenized (an unterminated literal, unbalanced brackets, JSX) is judged
//   as a whole.
//
// Test-support files (a helper, fixture or data file the task changed inside its test_paths) are
// judged by mayReadSupport: a file that may read one is judged as a whole (see there).
//
// CT-06w (orchestrator ruling of 2026-10-19, after B1-12g red/4 and five Codex rounds) — a
// conservative fallback, not a proof about arbitrary code:
// - Design intent: an import specifier such as `./kit.ts` names a file; when that file resolves
//   to a different test-code module than the changed support file (test/spec/platform/events/kit.ts
//   is not test/spec/identity/step-up-verify/kit.ts), the basename in the specifier is no evidence
//   that the test reads the support file. Only such a specifier literal is exempt from the name
//   rules; the name anywhere else (a comment, another literal) still counts.
// - Closed module (Module.closed): tokenised; no dynamic load (glob / require / computed import);
//   no directory listing; no file-system API; no code or process execution (child_process, vm,
//   worker_threads, module, inspector, eval, Function, Worker …, built-in subpaths too); no
//   browser or network API (fetch, XMLHttpRequest, document …: in browser mode Vite serves the
//   work tree); no way to the Function constructor (`constructor` in any spelling but a
//   constructor definition, getPrototypeOf, __proto__); no capability object (process,
//   globalThis, global, window, self) used by a computed key or as a value, no `process.<name>`
//   outside PROCESS_PROPERTIES; no capability named
//   by a string literal (also one built from literals with `+` or `[…].join(…)`); no import.meta;
//   no mock call of any spelling (`.` or `?.`, `?.()`, any receiver, a computed key on vi, a
//   destructured or renamed mock function, vi passed on as a value); no template specifier or
//   import inside a template; every relative or `#` import resolves (certainly, by Vite's rules)
//   to a closed module of the closure or to a module outside the test code (implementation code
//   never reads test-support files, as since CT-06p); a bare specifier keeps it closed only when
//   it is a known pure package (KNOWN_BUILTINS / KNOWN_PACKAGES, exact specifiers: no file read or
//   code load on the caller's behalf — prettier's resolveConfig, kysely/migration read files,
//   Codex reviews r8, r9; the listed packages' file APIs such as toMatchFileSnapshot and
//   FileMigrationProvider are capabilities of the scan above) or a capability
//   module judged by the scan above; a workspace package (`@couli/*`, test code such as
//   packages/testing that the closure does not follow) or any other package keeps it open. Computed as a fixpoint over the closure; `opaque` says why not. The capabilities are
//   a list of the ordinary spellings (Codex reviews r4–r7), not a proof: a name computed some
//   other way is not seen (see the threat model below).
// - Fallback rule: a specifier is exempt only when it resolves to a closed module and the whole
//   closure is closed. Whenever the module it names is not closed, not followed or not resolved,
//   the importing module mocks modules, ANY module the rule-test file loads is not closed (a
//   sibling the specifier does not name too), or the rule-test file itself has a way to files
//   that no rule here judges even on its own text (`Module.unjudged`: unreadable code, a dynamic
//   or template load, code or process execution, a mock, an import that is neither a package
//   nor resolved to the closure or to code outside the test code), every specifier keeps the
//   name rules of CT-06p unchanged — the file is judged as a whole exactly as before, the reason
//   says `unresolved import`. So a closure with one module that is not closed judges like the
//   old code (test `[CT-06w] fallback …`, clause by clause). The one thing the rule-test file
//   itself may do and still be exempt is what the name and listing rules already judge on its
//   own text, as before CT-06w: file-system reads, path helpers, `import.meta` and listings
//   resolved statically (B1-12g: queue/contract.test.ts lists and reads apps/api/src; a listing
//   that holds the support file, or the support file's name in another literal, still makes it
//   whole; this is the CT-06r judgement, not a new gap). The question a review must answer is
//   whether a closure of closed modules, written in the ordinary way, can still reach a changed
//   support file.
// - Threat model (orchestrator ruling of 2026-10-19, after Codex r7): the red check catches tests
//   that are wrong — not red against the old implementation — in test code written the ordinary
//   way; it is no security boundary against deliberate obfuscation. The test authors are our own
//   Codex / Claude and the tests pass the rule-test review. Code that reaches Function, process,
//   a built-in module or a dynamic import through a computed property name or a string built at
//   run time is out of scope here; the rule-test review is what stops it.
//
// Node built-ins only; pure functions (the caller reads the files).

export class TestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestParseError';
  }
}

export type Token = {
  kind: 'id' | 'num' | 'str' | 'tpl' | 're' | 'punct';
  /** Raw source text (a template literal includes its `${…}` expressions). */
  text: string;
  /** A line break occurs in the whitespace or comments before the token. */
  nl: boolean;
  /** Offset of the token in the source. */
  start?: number;
  /** The exact whitespace and comments between the previous token and this one. */
  gap?: string;
  /** str: the cooked value (null when an escape cannot be decoded for certain). */
  value?: string | null;
  /** tpl: the cooked static parts around the `${…}` expressions (null when not decodable). */
  parts?: (string | null)[];
  /** tpl: the tokens of its `${…}` expressions, in order. */
  inner?: Token[];
};

const PUNCTUATORS = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '**',
  '<<',
  '>>',
];
const SINGLE_PUNCTUATORS = '{}()[];,<>+-*/%&|^!~?:=.@';
/** Identifiers after which a `/` starts a regular expression, not a division. */
const BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

function lineTerminator(c: string | undefined): boolean {
  return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
}

function idStart(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z_$\u0080-\uffff]/.test(c) && !/\s/.test(c);
}

function idPart(c: string | undefined): boolean {
  return c !== undefined && /[\w$\u0080-\uffff]/.test(c) && !/\s/.test(c);
}

/**
 * The cooked value of a string or template literal body, or null when an escape cannot be
 * decoded for certain (a legacy octal escape, a malformed \x / \u).
 */
export function cook(body: string, template: boolean): string | null {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] as string;
    if (c !== '\\') {
      if (template && c === '\r') {
        // Template literals normalise CRLF and CR to LF.
        out += '\n';
        if (body[i + 1] === '\n') i += 1;
      } else {
        out += c;
      }
      continue;
    }
    i += 1;
    const d = body[i];
    if (d === undefined) return null;
    if (d === 'n') out += '\n';
    else if (d === 't') out += '\t';
    else if (d === 'r') out += '\r';
    else if (d === 'b') out += '\b';
    else if (d === 'f') out += '\f';
    else if (d === 'v') out += '\v';
    else if (d === '0') {
      if (/[0-9]/.test(body[i + 1] ?? '')) return null;
      out += '\0';
    } else if (d === 'x') {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else if (d === 'u') {
      if (body[i + 1] === '{') {
        const end = body.indexOf('}', i + 2);
        const hex = end < 0 ? '' : body.slice(i + 2, end);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return null;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) return null;
        out += String.fromCodePoint(cp);
        i = end;
      } else {
        const hex = body.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      }
    } else if (d === '\r') {
      // A line continuation: nothing.
      if (body[i + 1] === '\n') i += 1;
    } else if (d === '\n' || d === '\u2028' || d === '\u2029') {
      // A line continuation: nothing.
    } else if (/[1-9]/.test(d)) {
      return null;
    } else {
      out += d;
    }
  }
  return out;
}

function regexAllowed(prev: Token | undefined): boolean {
  if (prev === undefined) return true;
  if (prev.kind === 'id') return BEFORE_EXPRESSION.has(prev.text);
  if (prev.kind !== 'punct') return false;
  return ![')', ']', '}', '++', '--'].includes(prev.text);
}

/** End (exclusive) of the regular expression literal starting at `i`, or null when it is none. */
function scanRegex(src: string, i: number): number | null {
  let j = i + 1;
  let inClass = false;
  for (;;) {
    const c = src[j];
    if (c === undefined || lineTerminator(c)) return null;
    if (c === '\\') {
      if (lineTerminator(src[j + 1])) return null;
      j += 2;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
    } else if (c === '/') {
      break;
    }
    j += 1;
  }
  j += 1;
  while (idPart(src[j])) j += 1;
  return j;
}

type Lexed = { tokens: Token[]; end: number };

function lex(src: string, start: number, inTemplate: boolean): Lexed {
  const tokens: Token[] = [];
  const n = src.length;
  let i = start;
  let nl = false;
  let depth = 0;
  let prevEnd = start;
  while (i < n) {
    const c = src[i] as string;
    if (lineTerminator(c)) {
      nl = true;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && !lineTerminator(src[i])) i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new TestParseError('unterminated comment');
      if (/[\n\r\u2028\u2029]/.test(src.slice(i, end))) nl = true;
      i = end + 2;
      continue;
    }
    if (i === 0 && c === '#' && src[1] === '!') {
      while (i < n && !lineTerminator(src[i])) i += 1;
      continue;
    }
    let token: Token;
    const at = i;
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (;;) {
        const d = src[j];
        if (d === undefined || d === '\n' || d === '\r') {
          throw new TestParseError('unterminated string literal');
        }
        if (d === '\\') {
          j += src[j + 1] === '\r' && src[j + 2] === '\n' ? 3 : 2;
          continue;
        }
        if (d === c) break;
        j += 1;
      }
      token = {
        kind: 'str',
        text: src.slice(i, j + 1),
        nl,
        value: cook(src.slice(i + 1, j), false),
      };
      i = j + 1;
    } else if (c === '`') {
      const parts: (string | null)[] = [];
      const inner: Token[] = [];
      let j = i + 1;
      let seg = j;
      for (;;) {
        const d = src[j];
        if (d === undefined) throw new TestParseError('unterminated template literal');
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '`') {
          parts.push(cook(src.slice(seg, j), true));
          break;
        }
        if (d === '$' && src[j + 1] === '{') {
          parts.push(cook(src.slice(seg, j), true));
          const expression = lex(src, j + 2, true);
          inner.push(...expression.tokens);
          j = expression.end;
          seg = j;
          continue;
        }
        j += 1;
      }
      token = { kind: 'tpl', text: src.slice(i, j + 1), nl, parts, inner };
      i = j + 1;
    } else if (idStart(c) || (c === '#' && idStart(src[i + 1]))) {
      let j = i + 1;
      while (idPart(src[j])) j += 1;
      token = { kind: 'id', text: src.slice(i, j), nl };
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j] as string)) j += 1;
      token = { kind: 'num', text: src.slice(i, j), nl };
      i = j;
    } else {
      const prev = tokens[tokens.length - 1];
      const re = c === '/' && regexAllowed(prev) ? scanRegex(src, i) : null;
      if (re !== null) {
        token = { kind: 're', text: src.slice(i, re), nl };
        i = re;
      } else {
        const multi = PUNCTUATORS.find((p) => src.startsWith(p, i));
        const text = multi ?? (SINGLE_PUNCTUATORS.includes(c) ? c : null);
        if (text === null) throw new TestParseError(`unexpected character ${JSON.stringify(c)}`);
        token = { kind: 'punct', text, nl };
        i += text.length;
      }
    }
    token.start = at;
    token.gap = src.slice(prevEnd, at);
    prevEnd = i;
    if (inTemplate && token.kind === 'punct') {
      if (token.text === '{') depth += 1;
      if (token.text === '}') {
        if (depth === 0) return { tokens, end: i };
        depth -= 1;
      }
    }
    tokens.push(token);
    nl = false;
  }
  if (inTemplate) throw new TestParseError('unterminated template expression');
  return { tokens, end: n };
}

/** The tokens of a JavaScript / TypeScript source (no JSX); throws TestParseError. */
export function tokenize(source: string): Token[] {
  return lex(source, 0, false).tokens;
}

/** Index of the matching bracket of every bracket token; throws on unbalanced brackets. */
function matchBrackets(tokens: readonly Token[]): number[] {
  const match = new Array<number>(tokens.length).fill(-1);
  const stack: number[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  tokens.forEach((t, i) => {
    if (t.kind !== 'punct') return;
    if (t.text === '(' || t.text === '[' || t.text === '{') {
      stack.push(i);
    } else if (t.text in pairs) {
      const open = stack.pop();
      if (open === undefined || tokens[open]?.text !== pairs[t.text]) {
        throw new TestParseError(`unbalanced "${t.text}"`);
      }
      match[open] = i;
      match[i] = open;
    }
  });
  if (stack.length > 0) throw new TestParseError('unclosed bracket');
  return match;
}

/**
 * The separator before token k in a normalised text: a line break when the gap has one, else
 * one space — except on a line that has a division `/` or `/=`, where the exact gap is kept: a
 * regular expression literal the lexer takes for a division (after `)` of an `if (…)`, after a
 * `}`) is then compared byte for byte, its spaces included (Codex review r3, S2).
 */
type Separator = (k: number) => string;

function separators(source: string, tokens: readonly Token[]): Separator {
  const breaks: number[] = [];
  for (const m of source.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) breaks.push(m.index ?? 0);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((breaks[mid] as number) < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const division = new Set<number>();
  for (const t of tokens) {
    if (t.kind === 'punct' && (t.text === '/' || t.text === '/='))
      division.add(lineOf(t.start ?? 0));
  }
  return (k) => {
    const t = tokens[k] as Token;
    if (t.nl) return '\n';
    return division.has(lineOf(t.start ?? 0)) ? (t.gap ?? ' ') : ' ';
  };
}

/** Normalised text of tokens[from..to]: see separators. */
function joinTokens(tokens: readonly Token[], from: number, to: number, sep: Separator): string {
  let out = '';
  for (let i = from; i <= to; i += 1) {
    const t = tokens[i] as Token;
    out += i === from ? t.text : `${sep(i)}${t.text}`;
  }
  return out;
}

/** The local names of `it` / `test` (tests) and `describe` / `suite` imported from 'vitest'. */
function vitestNames(tokens: readonly Token[]): Map<string, 'test' | 'suite'> {
  const names = new Map<string, 'test' | 'suite'>();
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i]?.text !== 'import' || tokens[i]?.kind !== 'id') continue;
    let j = i + 1;
    if (tokens[j]?.text === 'type') continue; // `import type { … }`: no values
    if (tokens[j]?.kind === 'id' && tokens[j + 1]?.text === ',') j += 2; // a default import
    if (tokens[j]?.text !== '{') continue;
    const entries: { name: string; local: string }[] = [];
    let k = j + 1;
    while (k < tokens.length && tokens[k]?.text !== '}') {
      const name = tokens[k];
      if (name?.text === 'type' && tokens[k + 1]?.kind === 'id' && tokens[k + 1]?.text !== 'as') {
        // `type X` inside the braces: a type only
        k += 2;
        if (tokens[k]?.text === 'as') k += 2;
        if (tokens[k]?.text === ',') k += 1;
        continue;
      }
      if (name?.kind !== 'id' && name?.kind !== 'str') break;
      let local = name.text;
      if (tokens[k + 1]?.text === 'as' && tokens[k + 2]?.kind === 'id') {
        local = (tokens[k + 2] as Token).text;
        k += 2;
      }
      entries.push({ name: name.kind === 'str' ? (name.value ?? '') : name.text, local });
      k += 1;
      if (tokens[k]?.text === ',') k += 1;
    }
    if (tokens[k]?.text !== '}' || tokens[k + 1]?.text !== 'from') continue;
    const from = tokens[k + 2];
    if (from?.kind !== 'str' || from.value !== 'vitest') continue;
    for (const e of entries) {
      if (e.name === 'it' || e.name === 'test') names.set(e.local, 'test');
      if (e.name === 'describe' || e.name === 'suite') names.set(e.local, 'suite');
    }
  }
  return names;
}

/** One segment of a title: a literal, or null for a wildcard (any text). */
type Segment = string | null;

/** The title segments of the first argument tokens[from..to) of a test or describe call. */
function titleOf(tokens: readonly Token[], from: number, to: number, each: boolean): Segment[] {
  const only = to - from === 1 ? tokens[from] : undefined;
  let segments: Segment[];
  if (only?.kind === 'str' && typeof only.value === 'string') {
    segments = [only.value];
  } else if (only?.kind === 'tpl' && only.parts !== undefined && !only.parts.includes(null)) {
    segments = [];
    only.parts.forEach((p, i) => {
      if (i > 0) segments.push(null);
      segments.push(p);
    });
  } else {
    return [null];
  }
  if (!each) return segments;
  // .each / .for: Vitest formats %s, %d, %#, %$, %% … and $name / $a.b in the title.
  const out: Segment[] = [];
  for (const s of segments) {
    if (s === null) {
      out.push(null);
      continue;
    }
    const pieces = s.split(/%[\s\S]|\$[$\p{ID_Continue}.]+/u);
    pieces.forEach((p, i) => {
      if (i > 0) out.push(null);
      out.push(p);
    });
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** The full-name pattern of a test: any unknown suite prefix, the describe titles, the title. */
function patternOf(suites: readonly Segment[][], title: readonly Segment[]): RegExp {
  const part = (segments: readonly Segment[]): string =>
    segments.map((s) => (s === null ? '[\\s\\S]*' : escapeRegex(s))).join('');
  const chain = [...suites.map(part), part(title)].join(' > ');
  return new RegExp(`^(?:[\\s\\S]* > )?${chain}$`);
}

/** End index (exclusive) of the type arguments `<…>` starting at `j`, or null. */
function skipTypeArgs(
  tokens: readonly Token[],
  match: readonly number[],
  j: number,
): number | null {
  let depth = 0;
  for (let k = j; k < tokens.length; k += 1) {
    const t = tokens[k] as Token;
    if (t.kind === 'punct') {
      if (t.text === '<') depth += 1;
      else if (/^>+$/.test(t.text)) depth -= t.text.length;
      else if (t.text === '(' || t.text === '[' || t.text === '{') k = match[k] as number;
      else if ([')', ']', '}', ';'].includes(t.text)) return null;
    }
    if (depth === 0) return k + 1;
    if (depth < 0) return null;
  }
  return null;
}

type Call = {
  kind: 'test' | 'suite';
  start: number;
  /** Last token of the call, the `;` that ends it included for a test. */
  end: number;
  /** The argument list of the final call: tokens (open, close). */
  open: number;
  close: number;
  title: Segment[];
  /** Normalised text of the callee chain and the title (describe key). */
  head: string;
};

/** The call of `it` / `test` / `describe` / `suite` starting at token i, or null. */
function callAt(
  tokens: readonly Token[],
  match: readonly number[],
  i: number,
  kind: 'test' | 'suite',
  sep: Separator,
): Call | null {
  const prev = tokens[i - 1];
  if (prev !== undefined && ['.', '?.', 'function'].includes(prev.text)) return null;
  let j = i + 1;
  let each = false;
  let last: 'member' | 'call' | 'tag' | null = null;
  let open = -1;
  let close = -1;
  for (;;) {
    const t = tokens[j];
    if (t === undefined) break;
    if (t.text === '.' && tokens[j + 1]?.kind === 'id') {
      const name = (tokens[j + 1] as Token).text;
      // `it.extend({…})` / `it.scoped({…})` define fixtures, not a test: they stay in the shared
      // rest, so a change to them makes every test of the file changed.
      if (name === 'extend' || name === 'scoped') return null;
      if (name === 'each' || name === 'for') each = true;
      last = 'member';
      j += 2;
    } else if (t.kind === 'punct' && t.text === '<') {
      const k = skipTypeArgs(tokens, match, j);
      if (k === null || (tokens[k]?.text !== '(' && tokens[k]?.kind !== 'tpl')) break;
      j = k;
    } else if (t.kind === 'punct' && t.text === '(') {
      open = j;
      close = match[j] as number;
      last = 'call';
      j = close + 1;
    } else if (t.kind === 'tpl' && last === 'member' && each) {
      last = 'tag';
      j += 1;
    } else {
      break;
    }
  }
  if (last !== 'call') return null;
  // The first argument of the final call: up to the first top-level comma.
  let to = open + 1;
  while (to < close && tokens[to]?.text !== ',') {
    const t = tokens[to] as Token;
    to = t.text === '(' || t.text === '[' || t.text === '{' ? (match[to] as number) + 1 : to + 1;
  }
  const end = kind === 'test' && tokens[close + 1]?.text === ';' ? close + 1 : close;
  return {
    kind,
    start: i,
    end,
    open,
    close,
    title: titleOf(tokens, open + 1, to, each),
    head: joinTokens(tokens, i, to - 1, sep),
  };
}

export type TestBlock = {
  /** Matches the full names (describe > … > title) the block can produce. */
  pattern: RegExp;
  /** Readable title (wildcards shown as `*`), for notes. */
  title: string;
  /** Describe keys (position and header) and normalised text: equal keys are the same test. */
  key: string;
};

export type ParsedTestFile = {
  /** Normalised text of everything outside the test blocks. */
  shared: string;
  blocks: TestBlock[];
};

type Scanned = {
  tokens: Token[];
  match: number[];
  sep: Separator;
  suites: Call[];
  /** The outermost test calls, in source order (the order of ParsedTestFile.blocks). */
  tests: Call[];
};

/** Tokens and test / suite calls of a rule-test file; throws TestParseError. */
function scanTests(source: string): Scanned {
  const tokens = tokenize(source);
  const match = matchBrackets(tokens);
  const names = vitestNames(tokens);
  const sep = separators(source, tokens);
  const suites: Call[] = [];
  const tests: Call[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    const kind = t.kind === 'id' ? names.get(t.text) : undefined;
    if (kind === undefined) continue;
    const call = callAt(tokens, match, i, kind, sep);
    if (call === null) continue;
    if (kind === 'suite') {
      suites.push(call);
    } else {
      tests.push(call);
      i = call.end; // outermost test calls only
    }
  }
  return { tokens, match, sep, suites, tests };
}

/** Test blocks and shared rest of a rule-test file (see the header); throws TestParseError. */
export function parseTestFile(source: string): ParsedTestFile {
  const { tokens, sep, suites, tests } = scanTests(source);
  const inBlock = new Array<boolean>(tokens.length).fill(false);
  for (const c of tests) for (let k = c.start; k <= c.end; k += 1) inBlock[k] = true;
  let shared = '';
  let first = true;
  let pendingNl = false;
  // anchor[k]: how many shared tokens come before token k (where in the shared rest a block sits).
  const anchor = new Array<number>(tokens.length).fill(0);
  let sharedCount = 0;
  tokens.forEach((t, k) => {
    anchor[k] = sharedCount;
    if (inBlock[k]) {
      pendingNl ||= t.nl;
      return;
    }
    if (first) shared += t.text;
    else if (pendingNl || t.nl) shared += `\n${t.text}`;
    else shared += `${inBlock[k - 1] === true ? ' ' : sep(k)}${t.text}`;
    first = false;
    pendingNl = false;
    sharedCount += 1;
  });
  const blocks = tests.map((c) => {
    const around = suites.filter((s) => s.open < c.start && c.start < s.close);
    const show = (segments: readonly Segment[]): string =>
      segments.map((s) => (s === null ? '*' : s)).join('');
    return {
      pattern: patternOf(
        around.map((s) => s.title),
        c.title,
      ),
      title: [...around.map((s) => show(s.title)), show(c.title)].join(' > '),
      // Where the block sits in the shared rest (its anchor: the shared tokens before it), its
      // describes (position among the file's describes and header) and its text: a block moved
      // into another describe, loop, branch or function — also between two with the same
      // header — is a different block (Codex review r1 / r2, S2).
      key: [
        String(anchor[c.start]),
        around.map((s) => `${suites.indexOf(s)}:${s.head}`).join('\u0001'),
        joinTokens(tokens, c.start, c.end, sep),
      ].join('\u0000'),
    };
  });
  return { shared, blocks };
}

export type ComparedBlock = {
  pattern: RegExp;
  title: string;
  /** False only when the block is the same as at the base (see the header). */
  changed: boolean;
  /**
   * CT-06zzzd (D10-630, Codex review r1 S1; compareOutsideChanged only): the exact full names
   * (`describe > … > title`) of the tests the block certainly produces, each run once — the
   * static title of a plain test, or the titles Vitest formats for each row of an inline
   * `.each([…])` / `.for([…])` array whose rows are literals or arrays of literals
   * (formatEachTitle) or object literals whose fields named by `$name` are literals
   * (formatObjectTitle; other fields may be any code) — or null when they cannot be told for
   * certain (a title or describe title that is not a static literal, a table by name, a row with a
   * name, member, call, spread, `${…}` template or function where it reaches the title, a
   * placeholder the formatters do not know, a modifier such as `.skip` / `.only` / `.skipIf`, a loop, a
   * branch, a function or a parameterised describe around it). Absent from compareTestFile's.
   */
  names?: string[] | null;
  /**
   * CT-06zzze (D10-657): whether the block keeps rows of a base `.each` table (compareEachRows).
   * Set by red-check (ruleTestBaselines) for a file the ledger's red_exempt_rows name, absent
   * otherwise and for a block that is no `.each` / `.for` table call.
   */
  rows?: EachRows;
};

export type FileComparison =
  /** `outside` (CT-06zzzc): the file is judged as a whole because its shared rest differs. */
  { whole: true; reason: string; outside?: true } | { whole: false; blocks: ComparedBlock[] };

/** Positions (in `seq`) of one longest strictly increasing subsequence of `seq`. */
function longestIncreasing(seq: readonly number[]): Set<number> {
  const best = seq.map(() => 1);
  const from = seq.map(() => -1);
  let top = -1;
  for (let i = 0; i < seq.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (
        (seq[j] as number) < (seq[i] as number) &&
        (best[j] as number) + 1 > (best[i] as number)
      ) {
        best[i] = (best[j] as number) + 1;
        from[i] = j;
      }
    }
    if (top < 0 || (best[i] as number) > (best[top] as number)) top = i;
  }
  const keep = new Set<number>();
  for (let i = top; i >= 0; i = from[i] as number) keep.add(i);
  return keep;
}

/**
 * Compares the base and head text of a rule-test file that existed at the base (see the header):
 * either the whole file counts as changed (with the reason), or each head block says whether it
 * changed.
 */
export function compareTestFile(base: string, head: string): FileComparison {
  let before: ParsedTestFile;
  let after: ParsedTestFile;
  try {
    before = parseTestFile(base);
  } catch (err) {
    return { whole: true, reason: `the file at the base cannot be read as tests (${String(err)})` };
  }
  try {
    after = parseTestFile(head);
  } catch (err) {
    return { whole: true, reason: `the file cannot be read as tests (${String(err)})` };
  }
  if (before.shared !== after.shared) {
    return {
      whole: true,
      outside: true,
      reason:
        'code outside the tests changed (imports, helpers, hooks, top-level tables or describe titles)',
    };
  }
  const count = (blocks: readonly TestBlock[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const b of blocks) m.set(b.key, (m.get(b.key) ?? 0) + 1);
    return m;
  };
  const baseCount = count(before.blocks);
  const headCount = count(after.blocks);
  const baseIndex = new Map(before.blocks.map((b, i) => [b.key, i]));
  // Head blocks with exactly one counterpart, in head order, and their base positions.
  const paired: number[] = [];
  const pairedBase: number[] = [];
  after.blocks.forEach((b, i) => {
    if (baseCount.get(b.key) === 1 && headCount.get(b.key) === 1) {
      paired.push(i);
      pairedBase.push(baseIndex.get(b.key) as number);
    }
  });
  const inOrder = longestIncreasing(pairedBase);
  const unchanged = new Set(paired.filter((_, k) => inOrder.has(k)));
  return {
    whole: false,
    blocks: after.blocks.map((b, i) => ({
      pattern: b.pattern,
      title: b.title,
      changed: !unchanged.has(i),
    })),
  };
}

// Declared outside changes (CT-06zzzc; orchestrator ruling D10-623, after F1-02zzzb): a file
// whose shared rest changed is judged as a whole by compareTestFile. For a file the trusted ledger
// lists in `red_exempt_outside`, red-check compares it with compareOutsideChanged instead, so its
// declared exemptions (red_exempt) can apply to its unchanged tests:
// - The shared tokens of base and head (each with the separator before it, as in the shared rest)
//   are aligned by a shortest edit script (Myers; more than OUTSIDE_EDITS_MAX edits: the whole
//   file). The head lines of the inserted tokens, and the head lines around each removal, are the
//   changed lines outside the tests (`lines`, e.g. "L10-12, L33") the notes show the reviewer.
// - A test block is unchanged only when the same block — same text, same describes (position and
//   header), same enclosing brackets (each with the code that opens it back to the statement
//   start: a loop's head, a describe call, and the code that ends that statement after it closes:
//   a do-while condition, the arguments of `}).call(…)` / `})()`), same code leading to it in its statement (`if (x)`) —
//   occurs exactly once at the base and once at the head, sits between the same aligned shared
//   tokens (an edit elsewhere does not move it; moving it past an unchanged statement does), and
//   the unchanged blocks keep their relative order. Everything else counts as changed.
// - What the changed code outside means for the unchanged tests (an import, a table row group, a
//   fixture value) the comparison cannot tell: the rule-test reviewer confirms the listed lines.

/** A literal value of an `.each` row (CT-06zzzd; a bigint only in compareEachRows, CT-06zzzf). */
type Value = string | number | bigint | boolean | null | undefined;
/** A field of an object row: its literal value, or code (not a single literal). */
type Field = { literal: true; value: Value } | { literal: false };
/** A row of an `.each` / `.for` table: its items (a primitive is one item), or an object. */
type Row = { kind: 'items'; items: Value[] } | { kind: 'object'; fields: Map<string, Field> };

/**
 * The value-format truncation Vitest applies to `$name` attributes (CT-06zzzd). Basis: vitest
 * 5.0.5 dist/chunks/defaults.B1FCaFfh.js:85 `taskTitleValueFormatTruncate: 40`, merged under the
 * user options by resolveConfig (dist/chunks/index.1TqnEahn.js:8773 `deepMerge({}, configDefaults,
 * options)`) and handed to the runner (index.1TqnEahn.js:4030); no config of this repository sets
 * it (vitest.shared.ts, test/vitest.config.ts, test/vitest.integration.config.ts,
 * test/vitest.browser.config.ts, test/vitest.build-smoke.config.ts, test/vitest.longrun.config.ts:
 * none mentions taskTitleValueFormatTruncate). A config that sets it makes this value wrong: the
 * names then differ from the declared ones and the file simply stays expected (judged as before).
 */
export const TITLE_VALUE_TRUNCATE = 40;

/** @vitest/utils truncateString (vitest 5.0.5 dist/chunks/display.BlTmubjj.js:164-169). */
function truncateString(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max - 1;
  const c = value[end - 1];
  if (c !== undefined && c >= '\ud800' && c <= '\udbff') end -= 1;
  return `${value.slice(0, end)}…`;
}

/**
 * The title Vitest 5.0.5 gives an object row (CT-06zzzd, orchestrator follow-up of Codex review
 * r1 S1), or null when it is not certain. Basis: dist/chunks/run.BPv-BBRv.js formatTitle (from
 * line 3010): `%#` / `%$` are replaced first; any other `%` would format the object itself (null
 * here); then every `$key` of /\$([$\p{ID_Continue}.]+)/gu becomes objectAttr(row, key): a string
 * truncated by truncateString(TITLE_VALUE_TRUNCATE), anything else by inspect — for a number
 * pretty-format's printNumber (`-0` or String), for a boolean or null its text
 * (@vitest/pretty-format 5.0.5 dist/index.js:769-800; inspect, display.BlTmubjj.js:121, keeps a
 * text of at most 40 characters as is). Only a key naming a literal field of the row (a string, a
 * number, a boolean or null) is known; a missing field, a field of code, a path (`$a.b`), a key
 * with `$` or of digits: null.
 */
export function formatObjectTitle(
  title: string,
  fields: ReadonlyMap<string, Field>,
  idx: number,
): string | null {
  let template = '';
  for (let k = 0; k < title.length; k += 1) {
    const ch = title[k] as string;
    if (ch !== '%') {
      template += ch;
      continue;
    }
    const code = title[k + 1];
    k += 1;
    if (code === '#') template += String(idx);
    else if (code === '$') template += String(idx + 1);
    else return null;
  }
  let certain = true;
  const out = template.replace(/\$([$\p{ID_Continue}.]+)/gu, (_, key: string) => {
    const field = fields.get(key);
    if (/^\d+$/.test(key) || key.includes('.') || key.includes('$')) certain = false;
    if (field === undefined || !field.literal) certain = false;
    if (!certain || field === undefined || !field.literal) return '';
    const v = field.value;
    if (typeof v === 'string') return truncateString(v, TITLE_VALUE_TRUNCATE);
    if (typeof v === 'number') {
      const text = Object.is(v, -0) ? '-0' : String(v);
      if (text.length > TITLE_VALUE_TRUNCATE) certain = false;
      return text;
    }
    if (typeof v === 'bigint') {
      const text = `${v.toString()}n`; // printBigInt (pretty-format dist/index.js:772)
      if (text.length > TITLE_VALUE_TRUNCATE) certain = false;
      return text;
    }
    if (typeof v === 'boolean' || v === null) return String(v);
    certain = false; // undefined
    return '';
  });
  return certain ? out : null;
}

/**
 * The title Vitest 5 gives the row `items` (index `idx`) of an `.each` / `.for` table
 * (@vitest/runner formatTitle with format of @vitest/utils), or null when that is not certain
 * (CT-06zzzd, Codex review r1 S1). Only these are known: `%#` (the index), `%$` (the index + 1),
 * `%s` (a string as is; a number, boolean, null or undefined by String, -0 as "-0"), `%d` (a
 * number by Number(…).toString()) and `%i` (an integer number). Any other `%` (`%%`, `%f`,
 * `%j`, `%o`, `%O`, `%c`, a lone `%`), any `$` (Vitest's `$name` attributes, truncated by
 * configuration), and fewer row items than placeholders: null.
 */
export function formatEachTitle(
  title: string,
  items: readonly Value[],
  idx: number,
): string | null {
  if (title.replaceAll('%$', '').includes('$')) return null;
  let out = '';
  let i = 0;
  for (let k = 0; k < title.length; k += 1) {
    const ch = title[k] as string;
    if (ch !== '%') {
      out += ch;
      continue;
    }
    const code = title[k + 1];
    k += 1;
    if (code === '#') {
      out += String(idx);
    } else if (code === '$') {
      out += String(idx + 1);
    } else if (code === 's' || code === 'd' || code === 'i') {
      if (i >= items.length) return null;
      const v = items[i];
      i += 1;
      if (typeof v === 'bigint') {
        out += `${v.toString()}n`; // %s, %d and %i alike (@vitest/utils 5.0.5 dist/display.js:92-120)
      } else if (code === 's') {
        out += typeof v === 'number' && Object.is(v, -0) ? '-0' : String(v);
      } else if (typeof v !== 'number') {
        return null;
      } else if (code === 'd') {
        out += Number(v).toString();
      } else {
        if (!Number.isInteger(v)) return null;
        out += Number.parseInt(String(v)).toString();
      }
    } else {
      return null;
    }
  }
  return out;
}

/** The most shared-token edits compareOutsideChanged aligns (above it the whole file is judged). */
export const OUTSIDE_EDITS_MAX = 2000;

export type OutsideComparison =
  { whole: true; reason: string } | { whole: false; blocks: ComparedBlock[]; lines: string };

type OutsideView = {
  /** The shared tokens, normalised with the separator before them (as in the shared rest). */
  units: string[];
  /** The 1-based first and last source line of each shared token. */
  span: [number, number][];
  blocks: {
    pattern: RegExp;
    title: string;
    key: string;
    anchor: number;
    names: string[] | null;
    /** CT-06zzze (D10-657): the `.each` / `.for` table shape of the block, null when it has none. */
    each: EachShape | null;
  }[];
};

/**
 * The shape of a `<chain>.each(<table>)(<title>, <callback>…)` / `.for` test block (CT-06zzze,
 * D10-657; compareEachRows): `path` its describes (position among the file's describes and header),
 * `chain` the normalised call before the table (`it.each`, type arguments included), `args` the
 * normalised arguments of the final call (title template, callback with its parameters and body,
 * the `;` that ends it), `rows` the normalised text of each row of an inline array of literal rows
 * (as CT-06zzzd reads them; a literal followed by `as const` counts as that literal), null when
 * the table is anything else (a name, a call, a spread, a hole …), and `names` the exact full name
 * of each row as Vitest formats it (null entries: not certain), null when the title, the describes
 * or the block's place make no name certain (as ComparedBlock.names).
 */
type EachShape = {
  path: string;
  chain: string;
  args: string;
  rows: string[] | null;
  /** CT-06zzzf (D10-670): the `as const` after the table (its text), '' without one. */
  outer: string;
  names: (string | null)[] | null;
};

function outsideView(source: string): OutsideView {
  const { tokens, match, sep, suites, tests } = scanTests(source);
  const inBlock = new Array<boolean>(tokens.length).fill(false);
  for (const c of tests) for (let k = c.start; k <= c.end; k += 1) inBlock[k] = true;
  const breaks: number[] = [];
  for (const m of source.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) breaks.push(m.index ?? 0);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((breaks[mid] as number) < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  const units: string[] = [];
  const span: [number, number][] = [];
  const anchor = new Array<number>(tokens.length).fill(0);
  let pendingNl = false;
  tokens.forEach((t, k) => {
    anchor[k] = units.length;
    if (inBlock[k]) {
      pendingNl ||= t.nl;
      return;
    }
    const before =
      units.length === 0 ? '' : pendingNl || t.nl ? '\n' : inBlock[k - 1] === true ? ' ' : sep(k);
    units.push(`${before}${t.text}`);
    const start = t.start ?? 0;
    span.push([lineOf(start), lineOf(start + Math.max(t.text.length - 1, 0))]);
    pendingNl = false;
  });
  // The code back to the start of the statement before token `to` (exclusive): over bracketed
  // groups, up to `;`, `{`, `}`, an enclosing `(` / `[`, a test block or the start of the file.
  const lead = (to: number): string => {
    let k = to - 1;
    while (k >= 0) {
      const t = tokens[k] as Token;
      if (inBlock[k]) break;
      if (t.kind === 'punct') {
        if (t.text === ')' || t.text === ']') {
          k = (match[k] as number) - 1;
          continue;
        }
        if ([';', '{', '}', '(', '['].includes(t.text)) break;
      }
      k -= 1;
    }
    return k + 1 <= to - 1 ? joinTokens(tokens, k + 1, to - 1, sep) : '';
  };
  // The code after the closing bracket `close` up to the end of its statement (CT-06zzzc, Codex
  // review r1 S2): over bracketed groups (their content, test blocks included), up to and with a
  // `;`, or up to an enclosing closing bracket, a test block or the end of the file. The body of
  // a block statement (`{` after `)`, `do`, `else`, `try`, `finally`) ends its statement at a line
  // break, unless `while`, `else`, `catch` or `finally` follows. Otherwise, without a `;` (ASI),
  // it runs on into the next statements: more blocks count as changed, never fewer.
  const BLOCK_HEAD = new Set([')', 'do', 'else', 'try', 'finally']);
  const CONTINUES = new Set(['while', 'else', 'catch', 'finally']);
  const trail = (close: number): string => {
    const t0 = tokens[close] as Token;
    const blockBody =
      t0.text === '}' && BLOCK_HEAD.has(tokens[(match[close] as number) - 1]?.text ?? '');
    let k = close + 1;
    let end = close; // last token of the trail
    while (k < tokens.length) {
      const t = tokens[k] as Token;
      if (inBlock[k]) break;
      if (k === close + 1 && blockBody && t.nl && !CONTINUES.has(t.text)) break;
      if (t.kind === 'punct') {
        if (t.text === '(' || t.text === '[' || t.text === '{') {
          end = match[k] as number;
          k = end + 1;
          continue;
        }
        if (t.text === ')' || t.text === ']' || t.text === '}') break;
        if (t.text === ';') {
          end = k;
          break;
        }
      }
      end = k;
      k += 1;
    }
    return end > close ? joinTokens(tokens, close + 1, end, sep) : '';
  };
  const stack: number[] = [];
  const enclosing = new Map<number, number[]>();
  const starts = new Set(tests.map((c) => c.start));
  tokens.forEach((t, k) => {
    if (starts.has(k)) enclosing.set(k, [...stack]);
    if (inBlock[k] || t.kind !== 'punct') return;
    if (t.text === '(' || t.text === '[' || t.text === '{') stack.push(k);
    else if (t.text === ')' || t.text === ']' || t.text === '}') stack.pop();
  });
  // CT-06zzzd (D10-630; Codex review r1 S1): the exact full names a call certainly produces
  // (ComparedBlock.names), or null.
  const UNSURE = new Set(['skip', 'todo', 'only', 'fails', 'skipIf', 'runIf']);
  const plainChain = (from: number, open: number): boolean => {
    for (let k = from; k < open; k += 1) {
      const t = tokens[k] as Token;
      if (t.kind === 'id' && UNSURE.has(t.text)) return false;
    }
    return true;
  };
  // The title argument: one string literal, or a template without `${…}`, then `,` or `)`.
  const staticTitle = (c: Call): string | null => {
    const t = tokens[c.open + 1];
    const after = tokens[c.open + 2]?.text;
    if (t === undefined || (after !== ',' && c.open + 2 !== c.close)) return null;
    if (t.kind === 'str' && typeof t.value === 'string') return t.value;
    if (t.kind === 'tpl' && t.parts?.length === 1 && typeof t.parts[0] === 'string') {
      return t.parts[0];
    }
    return null;
  };
  // `.each(` / `.for(` at p: exactly one inline array whose rows are literal values, arrays of
  // them (literalList) or object literals (objectRow). With `eachRows` (compareEachRows only;
  // CT-06zzzf, D10-670) the array may be followed by `as const` (outerAsConst); whether it is,
  // compareEachRows asks the base and the head to agree on (EachShape.outer).
  const rows = (p: number, eachRows = false): Row[] | null => {
    if (tokens[p]?.text !== '(' || tokens[p + 1]?.text !== '[') return null;
    const close = match[p + 1] as number;
    if (close + 1 !== match[p] && !(eachRows && outerAsConst(close, match[p] as number))) {
      return null;
    }
    const out: Row[] = [];
    let k = p + 2;
    while (k < close) {
      const end = valueEnd(k, close);
      if (end === k) return null; // a hole
      if (tokens[k]?.text === '{' && match[k] === end - 1) {
        const fields = objectRow(k + 1, end - 1, eachRows);
        if (fields === null) return null;
        out.push({ kind: 'object', fields });
      } else {
        const items = literalList(k, end, 0, eachRows);
        if (items === null || items.length !== 1) return null;
        const item = items[0] as Value | Value[];
        out.push({ kind: 'items', items: Array.isArray(item) ? item : [item] });
      }
      k = end;
      if (k === close) break;
      k += 1; // the comma (a trailing one ends the list)
    }
    return out;
  };
  // CT-06zzzf (D10-670): whether exactly `as const` stands between the table's `]` at `close` and
  // the call's `)` at `paren`.
  const outerAsConst = (close: number, paren: number): boolean =>
    close + 3 === paren &&
    tokens[close + 1]?.kind === 'id' &&
    tokens[close + 1]?.text === 'as' &&
    tokens[close + 2]?.kind === 'id' &&
    tokens[close + 2]?.text === 'const';
  // The end (exclusive) of the expression starting at k: the next `,` at its level, or `to`.
  const valueEnd = (k: number, to: number): number => {
    let j = k;
    while (j < to && tokens[j]?.text !== ',') {
      const t = tokens[j] as Token;
      j = t.text === '(' || t.text === '[' || t.text === '{' ? (match[j] as number) + 1 : j + 1;
    }
    return j;
  };
  // The fields of an object literal in tokens [from, to): `key: value` with a plain or string
  // key; a field's value is kept only when it is one literal (primitiveAt), else marked as code
  // (it may be anything: the title must not name it). A spread, a computed key, a method, an
  // accessor, `__proto__` or a key given twice: null.
  const objectRow = (from: number, to: number, eachRows = false): Map<string, Field> | null => {
    const fields = new Map<string, Field>();
    let k = from;
    while (k < to) {
      const t = tokens[k] as Token;
      const key =
        t.kind === 'id' ? t.text : t.kind === 'str' && typeof t.value === 'string' ? t.value : null;
      if (key === null || key === '__proto__' || fields.has(key)) return null;
      const next = tokens[k + 1]?.text;
      if (k + 1 === to || next === ',') {
        if (t.kind !== 'id') return null;
        fields.set(key, { literal: false }); // shorthand: a name
        k += 2;
        continue;
      }
      if (next !== ':') return null;
      const end = valueEnd(k + 2, to);
      if (end === k + 2) return null;
      const one = primitiveAt(k + 2, eachRows);
      fields.set(
        key,
        one !== null && one.next === end ? { literal: true, value: one.value } : { literal: false },
      );
      k = end + 1;
    }
    return fields;
  };
  // A comma-separated list of literal values in tokens [from, to): a primitive or an array of
  // primitives; anything else (a name, a member, a call, a spread, a template with `${…}`, a
  // function, an object, a deeper array, a hole) is null.
  const literalList = (
    from: number,
    to: number,
    depth = 0,
    eachRows = false,
  ): (Value | Value[])[] | null => {
    const out: (Value | Value[])[] = [];
    let k = from;
    while (k < to) {
      let value: Value | Value[] | undefined;
      const t = tokens[k] as Token;
      if (t.text === '[' && depth === 0) {
        const end = match[k] as number;
        const inner = literalList(k + 1, end, 1, eachRows);
        if (inner === null || inner.some(Array.isArray)) return null;
        value = inner as Value[];
        k = end + 1;
      } else {
        const one = primitiveAt(k, eachRows);
        if (one === null) return null;
        value = one.value;
        k = one.next;
      }
      out.push(value);
      if (k === to) break;
      if (tokens[k]?.text !== ',') return null;
      k += 1; // a trailing comma ends the list
    }
    return out;
  };
  // CT-06zzze (D10-657): with `eachRows`, a literal followed by `as const` (a type assertion only:
  // the value is the literal's) counts as that literal; CT-06zzzf (D10-670): so does a BigInt
  // literal (primitive). Only compareEachRows asks for it; the names of CT-06zzzd keep reading a
  // literal alone, without BigInt.
  const primitiveAt = (k: number, eachRows = false): { value: Value; next: number } | null => {
    const one = primitive(k, eachRows);
    if (one === null || !eachRows) return one;
    return tokens[one.next]?.text === 'as' && tokens[one.next + 1]?.text === 'const'
      ? { value: one.value, next: one.next + 2 }
      : one;
  };
  const primitive = (k: number, bigint = false): { value: Value; next: number } | null => {
    const t = tokens[k] as Token;
    if (t.kind === 'str' && typeof t.value === 'string') return { value: t.value, next: k + 1 };
    if (t.kind === 'tpl' && t.parts?.length === 1 && typeof t.parts[0] === 'string') {
      return { value: t.parts[0], next: k + 1 };
    }
    const number = (u: Token | undefined): number | null =>
      u?.kind === 'num' && /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(u.text)
        ? Number(u.text)
        : null;
    // A decimal BigInt literal (`789n`, `0n`): its value by BigInt, never through Number (no
    // precision lost); the rows themselves compareEachRows compares by their text.
    const big = (u: Token | undefined): bigint | null =>
      bigint && u?.kind === 'num' && /^(?:0|[1-9]\d*)n$/.test(u.text)
        ? BigInt(u.text.slice(0, -1))
        : null;
    if (t.kind === 'num') {
      const b = big(t);
      if (b !== null) return { value: b, next: k + 1 };
      const n = number(t);
      return n === null ? null : { value: n, next: k + 1 };
    }
    if (t.text === '-' && t.kind === 'punct') {
      const b = big(tokens[k + 1]);
      if (b !== null) return { value: -b, next: k + 2 };
      const n = number(tokens[k + 1]);
      return n === null ? null : { value: -n, next: k + 2 };
    }
    if (t.kind === 'id') {
      const known: Record<string, Value> = { true: true, false: false, null: null };
      if (Object.hasOwn(known, t.text)) return { value: known[t.text] as Value, next: k + 1 };
      if (t.text === 'undefined') return { value: undefined, next: k + 1 };
    }
    return null;
  };
  const namesOf = (c: Call, prefix: string): string[] | null => {
    if (!plainChain(c.start, c.open)) return null;
    const title = staticTitle(c);
    if (title === null) return null;
    for (let k = c.start; k < c.open; k += 1) {
      const t = tokens[k] as Token;
      if (t.kind !== 'id' || (t.text !== 'each' && t.text !== 'for')) continue;
      if (tokens[k - 1]?.text !== '.') continue;
      const table = rows(k + 1);
      if (table === null) return null;
      const names: string[] = [];
      for (const [idx, row] of table.entries()) {
        const name =
          row.kind === 'items'
            ? formatEachTitle(title, row.items, idx)
            : formatObjectTitle(title, row.fields, idx);
        if (name === null) return null;
        names.push(`${prefix}${name}`);
      }
      return names;
    }
    return [`${prefix}${title}`];
  };
  // Only describes (without `.each` / `.for` / modifiers) and their callback bodies around it.
  const plainSuite = (s: Call): boolean => {
    if (!plainChain(s.start, s.open)) return false;
    for (let k = s.start; k < s.open; k += 1) {
      const t = tokens[k] as Token;
      if (t.kind === 'id' && (t.text === 'each' || t.text === 'for')) return false;
    }
    return true;
  };
  const surely = (c: Call): boolean => {
    if (lead(c.start) !== '') return false;
    const chain = enclosing.get(c.start) ?? [];
    return chain.every((o, i) => {
      const suite = suites.find((s) => s.open === o);
      if (suite !== undefined) return plainSuite(suite);
      const outer = chain[i - 1];
      const t = tokens[o] as Token;
      return (
        t.text === '{' &&
        outer !== undefined &&
        suites.some((s) => s.open === outer) &&
        ['=>', ')'].includes(tokens[o - 1]?.text ?? '')
      );
    });
  };
  // CT-06zzze (D10-657): the `.each` / `.for` table shape of a test call (EachShape), or null.
  const eachOf = (c: Call, around: readonly Call[]): EachShape | null => {
    let k = c.start;
    while (k < c.open) {
      const t = tokens[k] as Token;
      if (t.kind === 'id' && (t.text === 'each' || t.text === 'for') && tokens[k - 1]?.text === '.')
        break;
      k += 1;
    }
    if (k >= c.open) return null;
    let p = k + 1;
    if (tokens[p]?.text === '<') {
      const after = skipTypeArgs(tokens, match, p);
      if (after === null) return null;
      p = after;
    }
    // The table call, then at once the final call: `<chain>.each(<table>)(<title>, …)`.
    if (tokens[p]?.text !== '(' || (match[p] as number) + 1 !== c.open) return null;
    let texts: string[] | null = null;
    let table: Row[] | null = null;
    let outer = '';
    if (tokens[p + 1]?.text === '[') {
      table = rows(p, true);
      if (table !== null) {
        const close = match[p + 1] as number;
        if (close + 1 !== match[p]) outer = joinTokens(tokens, close + 1, close + 2, sep);
        texts = [];
        let j = p + 2;
        while (j < close) {
          const end = valueEnd(j, close);
          texts.push(joinTokens(tokens, j, end - 1, sep));
          j = end;
          if (j === close) break;
          j += 1;
        }
        if (texts.length !== table.length) texts = null;
      }
    }
    const title = staticTitle(c);
    const certain =
      texts !== null &&
      table !== null &&
      title !== null &&
      plainChain(c.start, c.open) &&
      surely(c) &&
      around.every((x) => !x.title.includes(null));
    const prefix = around.map((x) => `${(x.title as string[]).join('')} > `).join('');
    return {
      path: around.map((s) => `${suites.indexOf(s)}:${s.head}`).join('\u0001'),
      chain: joinTokens(tokens, c.start, p - 1, sep),
      args: joinTokens(tokens, c.open, c.end, sep),
      rows: texts,
      outer,
      names:
        !certain || table === null
          ? null
          : table.map((row, idx) => {
              const name =
                row.kind === 'items'
                  ? formatEachTitle(title as string, row.items, idx)
                  : formatObjectTitle(title as string, row.fields, idx);
              return name === null ? null : `${prefix}${name}`;
            }),
    };
  };
  const blocks = tests.map((c) => {
    const around = suites.filter((s) => s.open < c.start && c.start < s.close);
    const show = (segments: readonly Segment[]): string =>
      segments.map((x) => (x === null ? '*' : x)).join('');
    // Each enclosing bracket with the code that opens it and the code that ends its statement
    // after it closes (Codex review r1 S2: the condition of `do { … } while (n < 2)`, the
    // arguments of `}).call(…)` or `})()`).
    const enclosure = (enclosing.get(c.start) ?? [])
      .map(
        (o) => `${lead(o)}${sep(o)}${(tokens[o] as Token).text}\u0002${trail(match[o] as number)}`,
      )
      .join('\u0001');
    return {
      pattern: patternOf(
        around.map((s) => s.title),
        c.title,
      ),
      title: [...around.map((s) => show(s.title)), show(c.title)].join(' > '),
      key: [
        around.map((s) => `${suites.indexOf(s)}:${s.head}`).join('\u0001'),
        enclosure,
        lead(c.start),
        joinTokens(tokens, c.start, c.end, sep),
        // A block that does not end its statement (`do it(…) while (c)`): the rest of it.
        (tokens[c.end] as Token).text === ';' ? '' : trail(c.end),
      ].join('\u0000'),
      anchor: anchor[c.start] as number,
      names:
        surely(c) && around.every((x) => !x.title.includes(null))
          ? namesOf(c, around.map((x) => `${(x.title as string[]).join('')} > `).join(''))
          : null,
      each: eachOf(c, around),
    };
  });
  return { units, span, blocks };
}

/**
 * A shortest edit script between `a` and `b` (Myers): for each element of `b` the index of the
 * element of `a` it is aligned with (-1: inserted), and the positions in `b` before which
 * elements of `a` were removed. Null when more than `max` edits are needed.
 */
function alignUnits(
  a: readonly string[],
  b: readonly string[],
  max: number,
): { matchB: Int32Array; removedAt: Set<number> } | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(max, n + m);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let done = -1;
  for (let d = 0; d <= limit && done < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number))
          ? (v[off + k + 1] as number)
          : (v[off + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        done = d;
        break;
      }
    }
  }
  if (done < 0) return null;
  const matchB = new Int32Array(m).fill(-1);
  const removedAt = new Set<number>();
  let x = n;
  let y = m;
  for (let d = done; d >= 0; d -= 1) {
    const w = trace[d] as Int32Array;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && (w[off + k - 1] as number) < (w[off + k + 1] as number))
        ? k + 1
        : k - 1;
    const prevX = d === 0 ? 0 : (w[off + prevK] as number);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      matchB[y] = x;
    }
    if (d > 0) {
      if (x > prevX) removedAt.add(y); // a[prevX] removed before b[y]
      x = prevX;
      y = prevY;
    }
  }
  return { matchB, removedAt };
}

/** "L3-5, L9": sorted 1-based line numbers as ranges. */
function lineRanges(lines: ReadonlySet<number>): string {
  const sorted = [...lines].sort((p, q) => p - q);
  const out: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j += 1;
    out.push(i === j ? `L${sorted[i]}` : `L${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/**
 * Compares a rule-test file whose code outside the tests may have changed (CT-06zzzc, D10-623;
 * see the comment above OUTSIDE_EDITS_MAX): each head block says whether it is the same block as
 * at the base, and `lines` lists the head lines of the changes outside the tests.
 */
export function compareOutsideChanged(base: string, head: string): OutsideComparison {
  let before: OutsideView;
  let after: OutsideView;
  try {
    before = outsideView(base);
  } catch (err) {
    return { whole: true, reason: `the file at the base cannot be read as tests (${String(err)})` };
  }
  try {
    after = outsideView(head);
  } catch (err) {
    return { whole: true, reason: `the file cannot be read as tests (${String(err)})` };
  }
  const aligned = alignUnits(before.units, after.units, OUTSIDE_EDITS_MAX);
  if (aligned === null) {
    return {
      whole: true,
      reason: `the code outside the tests changed in more than ${OUTSIDE_EDITS_MAX} tokens`,
    };
  }
  const { matchB, removedAt } = aligned;
  const changedLines = new Set<number>();
  matchB.forEach((i, j) => {
    if (i >= 0) return;
    const [from, to] = after.span[j] as [number, number];
    for (let l = from; l <= to; l += 1) changedLines.add(l);
  });
  // A removal is shown at the lines of the head tokens around it (the last line of the one before,
  // the first line of the one after): the alignment may place it anywhere among equal tokens.
  for (const j of removedAt) {
    const prev = after.span[j - 1];
    const next = after.span[j];
    if (prev !== undefined) changedLines.add(prev[1]);
    if (next !== undefined) changedLines.add(next[0]);
    if (prev === undefined && next === undefined) changedLines.add(1);
  }
  // The base positions around each head position: the aligned shared tokens before and after.
  const m = after.units.length;
  const prevBase = new Int32Array(m + 1).fill(-1);
  for (let j = 0; j < m; j += 1) {
    const i = matchB[j] as number;
    prevBase[j + 1] = i >= 0 ? i : (prevBase[j] as number);
  }
  const nextBase = new Int32Array(m + 1).fill(before.units.length);
  for (let j = m - 1; j >= 0; j -= 1) {
    const i = matchB[j] as number;
    nextBase[j] = i >= 0 ? i : (nextBase[j + 1] as number);
  }
  const count = (keys: readonly string[]): Map<string, number> => {
    const c = new Map<string, number>();
    for (const k of keys) c.set(k, (c.get(k) ?? 0) + 1);
    return c;
  };
  const baseCount = count(before.blocks.map((b) => b.key));
  const headCount = count(after.blocks.map((b) => b.key));
  const baseIndex = new Map(before.blocks.map((b, i) => [b.key, i]));
  const paired: number[] = [];
  const pairedBase: number[] = [];
  after.blocks.forEach((b, j) => {
    if (baseCount.get(b.key) !== 1 || headCount.get(b.key) !== 1) return;
    const i = baseIndex.get(b.key) as number;
    const ab = (before.blocks[i] as { anchor: number }).anchor;
    // Between the same aligned shared tokens: base anchor in (prev aligned, next aligned].
    if ((prevBase[b.anchor] as number) + 1 <= ab && ab <= (nextBase[b.anchor] as number)) {
      paired.push(j);
      pairedBase.push(i);
    }
  });
  const inOrder = longestIncreasing(pairedBase);
  const unchanged = new Set(paired.filter((_, k) => inOrder.has(k)));
  return {
    whole: false,
    blocks: after.blocks.map((b, j) => ({
      pattern: b.pattern,
      title: b.title,
      changed: !unchanged.has(j),
      names: b.names,
    })),
    lines: lineRanges(changedLines),
  };
}

// Rows kept from a split `.each` table (CT-06zzze; orchestrator ruling D10-657 ②, after B1-05zc,
// whose frozen [AC-B1-05e#8], [AC-B1-05i#10] tables lost the rows whose expectation D10-641
// changed, moved to new tests): the block of such a table counts as changed (its text differs),
// so the rows left in it, the base's own cases with the base's own callback, were held to the red
// rule. compareEachRows tells, for each head block, whether it is such a table; red-check lets a
// kept row pass on the old code only when the trusted ledger declares it (`red_exempt_rows`).
// A head `.each` / `.for` block qualifies only when all three hold, mechanically:
// ① its title template and callback (the whole argument list of the final call: async, the
//    parameters, the body, every token) and the call before the table (`it.each`, type arguments
//    and modifiers included) are those of exactly one base `.each` / `.for` block, under the same
//    describes (position and header), and no other head block has them;
// ② both tables are inline arrays of literal rows (CT-06zzzd's reading: literals, arrays of
//    literals, object rows whose fields named in the title are literals; a literal `as const`
//    counts as the literal; CT-06zzzf, D10-670: a decimal BigInt literal such as `789n` or
//    `-1n` is a literal like a number, compared by its text, named as Vitest names it, `789n`),
//    the whole array may be followed by `as const` only when both tables are, written alike
//    (stripped, then the rows read; one side only refuses), and the title of every kept row is certain (the block stands directly
//    in plain describes, with a static title, without a modifier) and is the title that row had
//    at the base (`%#` / `%$` moving with the index make it differ);
// ③ the head rows are the base rows, token for token, with at least one row removed and none
//    changed, added or moved (a subsequence); and the block keeps its place among the blocks
//    whose text is the base's.
// Anything else says which of the three does not hold (`reason`). The table's meaning — that the
// removed rows were taken out for the task's reason, that the kept ones still hold — the
// comparison cannot tell: the rule-test reviewer confirms every declared row.

/** Whether a head block is a base `.each` table with rows removed only (CT-06zzze, see above). */
export type EachRows =
  /** `names`: the exact full names of the kept rows, `removed`: how many base rows are gone. */
  { ok: true; names: string[]; removed: number } | { ok: false; reason: string };

/**
 * For each head test block (in the order of compareTestFile's and compareOutsideChanged's
 * blocks), whether it keeps rows of a base `.each` / `.for` table (EachRows), or null when it is
 * not a `<chain>.each(<table>)(…)` block; null as a whole when a side cannot be read as tests.
 */
export function compareEachRows(base: string, head: string): (EachRows | null)[] | null {
  let before: OutsideView;
  let after: OutsideView;
  try {
    before = outsideView(base);
    after = outsideView(head);
  } catch {
    return null;
  }
  const count = (keys: readonly string[]): Map<string, number> => {
    const c = new Map<string, number>();
    for (const k of keys) c.set(k, (c.get(k) ?? 0) + 1);
    return c;
  };
  // The blocks whose text is the base's (one on each side): the place a kept table must keep.
  const baseKeys = count(before.blocks.map((b) => b.key));
  const headKeys = count(after.blocks.map((b) => b.key));
  const baseIndex = new Map(before.blocks.map((b, i) => [b.key, i]));
  const same: [number, number][] = [];
  after.blocks.forEach((b, j) => {
    if (baseKeys.get(b.key) === 1 && headKeys.get(b.key) === 1) {
      same.push([baseIndex.get(b.key) as number, j]);
    }
  });
  const fail = (reason: string): EachRows => ({ ok: false, reason });
  const one = (e: EachShape, f: EachShape): boolean => e.path === f.path && e.args === f.args;
  return after.blocks.map((h, j): EachRows | null => {
    const e = h.each;
    if (e === null) return null;
    const bases = before.blocks
      .map((b, i) => [b, i] as const)
      .filter(([b]) => b.each !== null && one(b.each, e));
    if (bases.length === 0) {
      return fail(
        '① no .each / .for block of the base has the same title template and callback under the same describes',
      );
    }
    const twins = after.blocks.filter((b) => b.each !== null && one(b.each, e)).length;
    if (bases.length > 1 || twins > 1) {
      return fail(
        `① ${bases.length} block(s) of the base and ${twins} of the head have this title template and callback under the same describes: not one to one`,
      );
    }
    const [b, i] = bases[0] as readonly [OutsideView['blocks'][number], number];
    const f = b.each as EachShape;
    if (f.chain !== e.chain) {
      return fail(
        `① the call before the table differs from the base's (${JSON.stringify(f.chain)} → ${JSON.stringify(e.chain)})`,
      );
    }
    if (f.rows === null) {
      return fail('② the base table is not an inline array of literal rows');
    }
    if (e.rows === null) {
      return fail('② the head table is not an inline array of literal rows');
    }
    if (f.outer !== e.outer) {
      return fail(
        `② the table is followed by \`as const\` on one side only, or written differently (base ${JSON.stringify(f.outer)}, head ${JSON.stringify(e.outer)})`,
      );
    }
    // ③ The head rows are base rows in the base's order: a subsequence (each to its first match).
    const from: number[] = [];
    let at = 0;
    for (const row of e.rows) {
      while (at < f.rows.length && f.rows[at] !== row) at += 1;
      if (at === f.rows.length) {
        return fail(
          `③ the head table is not the base table with rows removed: row ${JSON.stringify(row)} is changed, added or moved`,
        );
      }
      from.push(at);
      at += 1;
    }
    if (e.rows.length === f.rows.length) {
      return fail('③ no row of the base table was removed (the block changed elsewhere)');
    }
    for (const [bi, hj] of same) {
      const beforeAtBase = bi < i;
      const beforeAtHead = hj < j;
      if (beforeAtBase !== beforeAtHead) {
        return fail('③ the block moved among the blocks whose text is as at the base');
      }
    }
    if (e.names === null || f.names === null) {
      return fail(
        '② the full names of the rows are not certain (a title, describe or placement Vitest names in a way not read here, or a modifier)',
      );
    }
    const names: string[] = [];
    for (const [k, name] of e.names.entries()) {
      const was = f.names[from[k] as number];
      if (name === null || was === null || was === undefined) {
        return fail(`② the full name of row ${k} is not certain`);
      }
      if (name !== was) {
        return fail(
          `② row ${k} is named ${JSON.stringify(name)}, at the base ${JSON.stringify(was)} (a title that follows the index)`,
        );
      }
      names.push(name);
    }
    if (new Set(names).size !== names.length) {
      return fail('② two kept rows have the same full name');
    }
    return { ok: true, names, removed: f.rows.length - e.rows.length };
  });
}

/**
 * Whether a report test (its full name) is exempt from the red requirement: exactly one block's
 * pattern matches it and that block is unchanged.
 */
export function unchangedTest(fullName: string, blocks: readonly ComparedBlock[]): boolean {
  if (fullName === '') return false;
  const hits = blocks.filter((b) => b.pattern.test(fullName));
  return hits.length === 1 && hits[0]?.changed === false;
}

// Registered expected values (CT-06zxe; orchestrator ruling D10-371 after B2-15l): a task may
// change an expected value inside a top-level helper of a frozen rule-test file (`diff_fen:
// AMOUNT` → `diff_fen: -AMOUNT` in `onlyAnomaly`), registered entry by entry in its trusted ledger
// (`expected_values`: file / helper / from / to; tools/lib/task-file.ts). The functions below
// serve tools/guard/lib/red-check.ts (valueSkeleton and valueChangeRefusal tools/lib/task-file.ts
// too):
// - valueSkeleton: a source text with its number and string literals (untagged templates without
//   `${…}`; a tagged one such as sql`…` is kept as written) replaced by one placeholder and its unary minus signs dropped, whitespace and comments kept
//   exactly. An entry's `from` and `to`, and the helper around it before and after the change,
//   must have the same skeleton: only the value of an expectation may change, never an
//   assertion, a call, a name or the structure.
// - valueChangeRefusal: where the differing values stand — only an object property value inside
//   an expectation or the expected argument of an expect chain's matcher, never inside a query
//   call (`.where(`, `sql(` …), a fixture's input, a ternary branch or a type annotation.
// - helperNamedInLiteral: whether a literal outside the changed helpers names one of them or
//   their callers (a call by a string: the whole file is judged).
// - topLevelHelpers: the helpers a file declares at its top level — `[export] [async] function
//   name(…) {…}` and `[export] const name = [async] (…) => {…}` / `= [async] function (…) {…}`
//   (a block body only) — with their source ranges; a name declared twice is in `twice`.
// - helperImpact: which test blocks a change of the named helpers affects. A block is affected
//   when its text names one of them, or a top-level helper that names one of them (transitively:
//   the closure of helpers calling helpers). A name that occurs anywhere else outside the test
//   blocks (a hook, a describe body, a top-level table or statement, an export list) cannot be
//   bounded: the impact is refused and the caller judges the whole file. Any occurrence of the
//   identifier counts (a property of the same name too, one inside a template's `${…}` too,
//   where the template stands): more tests affected, never fewer.

/** Whether a `-` at tokens[k] is a unary minus: no operand before it. */
function unaryMinus(tokens: readonly Token[], k: number): boolean {
  const t = tokens[k] as Token;
  if (t.kind !== 'punct' || t.text !== '-') return false;
  const prev = tokens[k - 1];
  if (prev === undefined) return true;
  if (prev.kind === 'id' || prev.kind === 'num' || prev.kind === 'str') return false;
  if (prev.kind === 'tpl' || prev.kind === 're') return false;
  return !(prev.text === ')' || prev.text === ']' || prev.text === '}');
}

/** Keywords a template may follow without being tagged by them (`return \`…\``). */
const UNTAGGING = new Set([
  'return',
  'typeof',
  'void',
  'await',
  'yield',
  'case',
  'in',
  'of',
  'instanceof',
  'throw',
  'new',
  'delete',
  'else',
  'do',
]);

/**
 * Whether the template at tokens[k] is tagged (CT-06zxe review r1 S2-1 ①): it follows an
 * identifier (`sql\`…\``, a `.` chain's last name), a `)`, a `]` or a `>` (type arguments, a
 * comparison counted too: refused more, never less).
 */
function taggedTemplate(tokens: readonly Token[], k: number): boolean {
  const prev = tokens[k - 1];
  if (prev === undefined) return false;
  if (prev.kind === 'id') return !UNTAGGING.has(prev.text);
  return prev.kind === 'punct' && [')', ']', '>'].includes(prev.text);
}

/**
 * Whether tokens[k] is a value literal: a number, a string, or a template without `${…}` that is
 * not tagged (a tagged template is a query or a call, its text is kept in the skeleton).
 */
function valueLiteral(tokens: readonly Token[], k: number): boolean {
  const t = tokens[k] as Token;
  if (t.kind === 'num' || t.kind === 'str') return true;
  return t.kind === 'tpl' && (t.inner ?? []).length === 0 && !taggedTemplate(tokens, k);
}

/**
 * The value skeleton of a source text (see above), or null when it cannot be tokenized. Brackets
 * need not balance (an entry is one line of a larger expression).
 */
export function valueSkeleton(source: string): string | null {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch {
    return null;
  }
  let out = '';
  let gap = '';
  tokens.forEach((t, k) => {
    gap += t.gap ?? '';
    if (unaryMinus(tokens, k)) return;
    out += `${gap}${valueLiteral(tokens, k) ? '\u0000' : t.text}`;
    gap = '';
  });
  return out + gap + source.slice(sourceEnd(tokens));
}

/**
 * Calls whose arguments are a query, not an expectation (CT-06zxe review r1 S2-1 ③): a literal
 * changed anywhere inside their parentheses is refused.
 */
const QUERY_CALLS = new Set([
  'where',
  'orWhere',
  'andWhere',
  'whereRef',
  'having',
  'on',
  'onRef',
  'select',
  'selectAll',
  'selectFrom',
  'insertInto',
  'updateTable',
  'deleteFrom',
  'set',
  'values',
  'from',
  'join',
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'orderBy',
  'groupBy',
  'limit',
  'offset',
  'returning',
  'with',
  'sql',
  'raw',
  'query',
  'execute',
]);

/** A matcher's name (`toBe`, `toEqual`, `toBeGreaterThanOrEqual`, …). */
const MATCHER = /^to[A-Z][A-Za-z]*$/;

/** Index of the identifier a call's `(` at tokens[k] follows (type arguments skipped), or -1. */
function calleeAt(tokens: readonly Token[], k: number): number {
  let j = k - 1;
  if (tokens[j]?.text === '>') {
    for (let depth = 0; j >= 0; j -= 1) {
      const text = tokens[j]?.text;
      if (text === '>') depth += 1;
      else if (text === '<') depth -= 1;
      if (depth === 0) break;
    }
    j -= 1;
  }
  return tokens[j]?.kind === 'id' ? j : -1;
}

/** The identifier a call's `(` at tokens[k] follows (type arguments skipped), or ''. */
function calleeOf(tokens: readonly Token[], k: number): string {
  const j = calleeAt(tokens, k);
  return j < 0 ? '' : (tokens[j] as Token).text;
}

/** Links of an expect chain between `expect(…)` and the matcher (`.not`, `.resolves`, …). */
const CHAIN_MODIFIERS = new Set(['not', 'resolves', 'rejects']);

/** Asymmetric matchers on `expect.` that are an actual value, not an expectation. */
const EXPECT_ACTUAL = new Set(['soft', 'poll']);

type Chain = 'expect' | 'other' | 'unknown';

/**
 * Whether the call named at tokens[m] (a matcher's name) ends an expect chain (CT-06zxh, review
 * r2 S2-2 ②): back along `.` (`.not`, `.resolves`, `.rejects` skipped) to the `)` of `expect(…)`,
 * `expect.soft(…)` or `expect.poll(…)`. 'unknown' when the fragment begins before that (an entry
 * is one line; red-check checks the whole helper, where it does not).
 */
function expectChain(tokens: readonly Token[], m: number, openOf: readonly number[]): Chain {
  if (tokens[m - 1]?.text !== '.') return m === 0 ? 'unknown' : 'other';
  for (let j = m - 2; ;) {
    const t = tokens[j];
    if (t === undefined) return 'unknown';
    if (t.kind === 'id' && CHAIN_MODIFIERS.has(t.text)) {
      if (j === 0) return 'unknown';
      if (tokens[j - 1]?.text !== '.') return 'other';
      j -= 2;
      continue;
    }
    if (t.kind !== 'punct' || t.text !== ')') return 'other';
    const open = openOf[j] ?? -1;
    if (open < 0) return 'unknown';
    const c = calleeAt(tokens, open);
    if (c < 0) return 'other';
    const name = (tokens[c] as Token).text;
    if (name === 'expect') return tokens[c - 1]?.text === '.' ? 'other' : 'expect';
    const onExpect =
      EXPECT_ACTUAL.has(name) &&
      tokens[c - 1]?.text === '.' &&
      tokens[c - 2]?.text === 'expect' &&
      tokens[c - 3]?.text !== '.';
    return onExpect ? 'expect' : 'other';
  }
}

/** Whether the call whose name is at tokens[c] is an asymmetric matcher (`expect.objectContaining(`). */
function asymmetricMatcher(tokens: readonly Token[], c: number): boolean {
  if (EXPECT_ACTUAL.has((tokens[c] as Token).text) || tokens[c - 1]?.text !== '.') return false;
  let j = c - 2;
  if (tokens[j]?.text === 'not' && tokens[j - 1]?.text === '.') j -= 2;
  return tokens[j]?.text === 'expect' && tokens[j - 1]?.text !== '.';
}

/** Keywords an object literal may follow (`return {…}`); after any other identifier `{` opens a block. */
const OBJECT_AFTER = new Set([
  'return',
  'typeof',
  'void',
  'await',
  'yield',
  'in',
  'of',
  'instanceof',
  'throw',
  'new',
  'delete',
  'case',
]);

/**
 * Whether the `{` at tokens[o] opens a block (a function's or a method's body, a statement's),
 * not an object literal (CT-06zxi, D10-388): it follows `=>`, `)` (parameters, `if (…)`), an
 * identifier other than OBJECT_AFTER (`else`, a return type), `]`, `}` or `>`.
 */
function blockBrace(tokens: readonly Token[], o: number): boolean {
  const prev = tokens[o - 1];
  if (prev === undefined) return false;
  if (prev.kind === 'id') return !OBJECT_AFTER.has(prev.text);
  return prev.kind === 'punct' && ['=>', ')', ']', '}', '>'].includes(prev.text);
}

/**
 * Whether tokens[inner] (a token or a bracket directly inside the bracket at tokens[o]) stands in
 * the body of an arrow function begun inside that bracket (CT-06zxi, D10-388): a `=>` at the
 * bracket's top level after its last `,` / `;` before `inner` (`(() => ({ a: 1 }))()`,
 * `[(v) => 1]`; `{ f: () => x, b: 1 }` is not).
 */
function inArrowBody(tokens: readonly Token[], o: number, inner: number): boolean {
  let depth = 0;
  let arrow = false;
  for (let k = o + 1; k < inner; k += 1) {
    const t = tokens[k] as Token;
    if (t.kind !== 'punct') continue;
    if (['(', '[', '{'].includes(t.text)) depth += 1;
    else if ([')', ']', '}'].includes(t.text)) depth -= 1;
    else if (depth === 0 && t.text === '=>') arrow = true;
    else if (depth === 0 && (t.text === ',' || t.text === ';')) arrow = false;
  }
  return arrow;
}

/**
 * Why the literals / unary minus signs that differ between `before` and `after` (same value
 * skeleton) are not all in an allowed place, or null when they are (CT-06zxe review r1 S2-1 ③,
 * tightened by CT-06zxh after review r2 S2-2). Allowed:
 * - a matcher's expected argument (`.toBe(<value>)`, inside `[ ]` / `{ }` of it too), the matcher
 *   at the end of an expect chain (`expect(…)` / `expect.soft(…)` / `expect.poll(…)`, through
 *   `.not` / `.resolves` / `.rejects`; `n.toString(16)`, `n.toFixed(2)` are no matchers);
 * - an object property value (`key: <value>` with `{` or `,` before the key, inside `{ }`: no
 *   ternary branch, no type annotation) whose object stands, through `{ }` / `[ ]` / grouping
 *   parentheses only, in a matcher's argument or an asymmetric matcher's
 *   (`expect.objectContaining(`): one in a fixture's or a query's input (`insertOrder(db, {…})`,
 *   `expect(f({…}))`), in a variable (`const q = {…}`) or a returned object is refused.
 * Never inside the parentheses of a query call (QUERY_CALLS: `.where(`, `.selectFrom(`, `sql(` …),
 * never inside a function body between the value and the matcher (CT-06zxi, D10-388: a block body
 * `=> {…}` / `function (…) {…}` / a method's, an arrow's expression body `=> ({…})` / `=> [<value>]`,
 * called at once or not: a local input or a fixture's, `expect(x).toEqual((() => { const input =
 * { amount: 1 }; return make(input); })())`).
 * Brackets need not balance (an entry is one line): what the fragment begins before (no bracket
 * or key before it, an unmatched `)`) is let through here, and red-check checks the whole helper
 * before and after with this same function, where nothing is unknown.
 */
export function valueChangeRefusal(before: string, after: string): string | null {
  let a: Token[];
  let b: Token[];
  try {
    a = tokenize(before);
    b = tokenize(after);
  } catch {
    return 'it cannot be tokenized';
  }
  const operands = (tokens: Token[]): { at: number; minus: number }[] => {
    const out: { at: number; minus: number }[] = [];
    let minus = 0;
    tokens.forEach((_, k) => {
      if (unaryMinus(tokens, k)) minus += 1;
      else {
        out.push({ at: k, minus });
        minus = 0;
      }
    });
    return out;
  };
  const oa = operands(a);
  const ob = operands(b);
  if (oa.length !== ob.length) return 'the value skeletons differ';
  // The open brackets around every token of `a`, and the open bracket every close one matches
  // (-1: opened before the fragment).
  const open: number[][] = [];
  const openOf: number[] = [];
  const stack: number[] = [];
  a.forEach((t, k) => {
    if (t.kind === 'punct' && [')', ']', '}'].includes(t.text)) openOf[k] = stack.pop() ?? -1;
    open[k] = [...stack];
    if (t.kind === 'punct' && ['(', '[', '{'].includes(t.text)) stack.push(k);
  });
  // Whether the bracket at `o` holding `inner` makes it a function body's (D10-388).
  const inBody = (o: number, inner: number): boolean =>
    (a[o]?.text === '{' && blockBrace(a, o)) || inArrowBody(a, o, inner);
  const BODY = 'inside a function body (a local or a fixture input, not an expectation; D10-388)';
  // Where an object stands whose innermost open brackets are `around` (outermost first); a
  // function body passed on the way turns what would be let through into a refusal.
  const objectPlace = (around: readonly number[], first: number): 'ok' | 'unknown' | string => {
    let inner = first;
    let body = false;
    const through = (place: 'ok' | 'unknown'): string => (body ? BODY : place);
    for (const o of [...around].reverse()) {
      body ||= inBody(o, inner);
      inner = o;
      if (a[o]?.text !== '(') continue;
      const c = calleeAt(a, o);
      if (c < 0) {
        const prev = a[o - 1];
        // Grouping parentheses (`=> ({…})`), not a call.
        if (prev === undefined || !(prev.kind === 'punct' && [')', ']'].includes(prev.text)))
          continue;
        return 'the argument of a call';
      }
      const name = (a[c] as Token).text;
      if (MATCHER.test(name)) {
        const chain = expectChain(a, c, openOf);
        if (chain === 'expect') return through('ok');
        if (chain === 'unknown') return through('unknown');
      } else if (asymmetricMatcher(a, c)) return through('ok');
      return `the argument of a ${name}( call (a fixture or query input, not an expectation)`;
    }
    return (around[0] ?? first) === 0 ? through('unknown') : 'outside any expectation';
  };
  for (let n = 0; n < oa.length; n += 1) {
    const x = oa[n] as { at: number; minus: number };
    const y = ob[n] as { at: number; minus: number };
    const t = a[x.at] as Token;
    if (t.text === (b[y.at] as Token).text && x.minus === y.minus) continue;
    const shown = JSON.stringify(t.text);
    const around = open[x.at] ?? [];
    for (const o of around) {
      const callee = a[o]?.text === '(' ? calleeOf(a, o) : '';
      if (QUERY_CALLS.has(callee))
        return `${shown} is changed inside a ${callee}( call (a query, not an expectation)`;
    }
    const k = x.at - x.minus - 2;
    const colon = a[k + 1];
    const key = a[k];
    const keyPrev = a[k - 1];
    const keyIn = open[k]?.at(-1);
    if (
      colon?.text === ':' &&
      (key?.kind === 'id' || key?.kind === 'str' || key?.kind === 'num') &&
      (keyPrev === undefined || (keyPrev.kind === 'punct' && ['{', ','].includes(keyPrev.text))) &&
      (keyIn === undefined || a[keyIn]?.text === '{')
    ) {
      const place = objectPlace(open[k] ?? [], k);
      if (place === 'ok' || place === 'unknown') continue;
      return `${shown} is changed in an object property value that stands ${place}`;
    }
    // The innermost `(` around it (only `[ ]` / `{ }` between): a matcher's at the end of an
    // expect chain (or the fragment begins before the chain; the whole helper then shows it).
    // A function body between it and that `(` refuses it (D10-388).
    const paren = [...around].reverse().find((o) => a[o]?.text === '(');
    const m = paren === undefined ? -1 : calleeAt(a, paren);
    if (m >= 0 && MATCHER.test((a[m] as Token).text) && expectChain(a, m, openOf) !== 'other') {
      let inner = x.at - x.minus;
      const body = [...around].reverse().some((o) => {
        if (inner === paren) return false;
        const hit = inBody(o, inner);
        inner = o;
        return hit;
      });
      if (!body) continue;
      return `${shown} is changed in a matcher's argument but ${BODY}`;
    }
    return `${shown} is changed outside an object property value inside an expectation ({ key: <value> }) and a matcher's expected argument (expect(…).toBe(<value>))`;
  }
  return null;
}

/** Offset just after the last token (what follows is whitespace or comments). */
function sourceEnd(tokens: readonly Token[]): number {
  const last = tokens[tokens.length - 1];
  return last === undefined ? 0 : (last.start ?? 0) + last.text.length;
}

/** A top-level helper: its name and source range [start, end). */
export type TopLevelHelper = { name: string; start: number; end: number };

type HelperDecl = { name: string; from: number; to: number };

/** End (index of the body's `}`) of a function whose parameter list closes at `close`, or -1. */
function functionBody(tokens: readonly Token[], match: readonly number[], close: number): number {
  for (let k = close + 1; k < tokens.length; k += 1) {
    const t = tokens[k] as Token;
    if (t.kind !== 'punct') continue;
    if (t.text === '{') {
      const prev = tokens[k - 1]?.text ?? '';
      // An object type in the return annotation (`): { a: number } {`) is not the body.
      if (![':', '<', '|', '&', ',', '(', '=>'].includes(prev)) return match[k] as number;
      k = match[k] as number;
    } else if (t.text === '(' || t.text === '[') {
      k = match[k] as number;
    } else if (t.text === ';' || t.text === ')' || t.text === ']' || t.text === '}') {
      return -1;
    }
  }
  return -1;
}

/** End of an arrow function whose parameters close at `close`: its block body's `}`, or -1. */
function arrowBody(tokens: readonly Token[], match: readonly number[], close: number): number {
  for (let k = close + 1; k < tokens.length; k += 1) {
    const t = tokens[k] as Token;
    if (t.text === '=>') return tokens[k + 1]?.text === '{' ? (match[k + 1] as number) : -1;
    if (t.kind !== 'punct') continue;
    if (t.text === '(' || t.text === '[' || t.text === '{') k = match[k] as number;
    else if ([';', ')', ']', '}', '='].includes(t.text)) return -1;
  }
  return -1;
}

/** The top-level helper declarations (token ranges), see topLevelHelpers. */
function helperDecls(tokens: readonly Token[], match: readonly number[]): HelperDecl[] {
  const out: HelperDecl[] = [];
  const at = (k: number, text: string): boolean =>
    tokens[k]?.text === text && tokens[k]?.kind === 'id';
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind === 'punct' && (t.text === '(' || t.text === '[' || t.text === '{')) {
      i = match[i] as number; // top level only
      continue;
    }
    const prev = tokens[i - 1];
    if (prev !== undefined && !(prev.text === ';' || prev.text === '}' || t.nl)) continue;
    let j = i;
    if (at(j, 'export')) j += 1;
    if (at(j, 'async') && at(j + 1, 'function')) j += 1;
    if (at(j, 'function')) {
      j += 1;
      if (tokens[j]?.text === '*') j += 1;
      const name = tokens[j];
      if (name?.kind !== 'id') continue;
      j += 1;
      if (tokens[j]?.text === '<') j = skipTypeArgs(tokens, match, j) ?? -1;
      if (j < 0 || tokens[j]?.text !== '(') continue;
      const end = functionBody(tokens, match, match[j] as number);
      if (end < 0) continue;
      out.push({ name: name.text, from: i, to: end });
      i = end;
      continue;
    }
    if (!at(j, 'const')) continue;
    const name = tokens[j + 1];
    if (name?.kind !== 'id') continue;
    j += 2;
    // A type annotation, up to the `=` (brackets skipped).
    while (j < tokens.length && tokens[j]?.text !== '=') {
      const u = tokens[j] as Token;
      if (u.text === ';') break;
      j = u.text === '(' || u.text === '[' || u.text === '{' ? (match[j] as number) + 1 : j + 1;
    }
    if (tokens[j]?.text !== '=') continue;
    j += 1;
    if (at(j, 'async')) j += 1;
    let end = -1;
    if (at(j, 'function')) {
      j += 1;
      if (tokens[j]?.text === '*') j += 1;
      if (tokens[j]?.kind === 'id') j += 1;
      if (tokens[j]?.text === '(') end = functionBody(tokens, match, match[j] as number);
    } else {
      if (tokens[j]?.text === '<') j = skipTypeArgs(tokens, match, j) ?? -1;
      if (j >= 0 && tokens[j]?.text === '(') end = arrowBody(tokens, match, match[j] as number);
      else if (j >= 0 && tokens[j]?.kind === 'id') end = arrowBody(tokens, match, j);
    }
    if (end < 0) continue;
    out.push({ name: name.text, from: i, to: end });
    i = end;
  }
  return out;
}

/** The top-level helpers of a source (see above); throws TestParseError. */
export function topLevelHelpers(source: string): {
  helpers: Map<string, TopLevelHelper>;
  twice: Set<string>;
} {
  const tokens = tokenize(source);
  const match = matchBrackets(tokens);
  const helpers = new Map<string, TopLevelHelper>();
  const twice = new Set<string>();
  for (const d of helperDecls(tokens, match)) {
    if (helpers.has(d.name)) twice.add(d.name);
    const last = tokens[d.to] as Token;
    helpers.set(d.name, {
      name: d.name,
      start: tokens[d.from]?.start ?? 0,
      end: (last.start ?? 0) + last.text.length,
    });
  }
  for (const name of twice) helpers.delete(name);
  return { helpers, twice };
}

export type HelperImpact =
  /** `closure`: the helpers whose change reaches a test; `affected[i]`: block i is affected. */
  { ok: true; closure: string[]; affected: boolean[] } | { ok: false; reason: string };

/** Which test blocks of `source` a change of `changed` (top-level helpers) affects; see above. */
export function helperImpact(source: string, changed: readonly string[]): HelperImpact {
  let scanned: Scanned;
  try {
    scanned = scanTests(source);
  } catch (err) {
    return { ok: false, reason: `the file cannot be read as tests (${String(err)})` };
  }
  const { tokens, match, tests } = scanned;
  const decls = helperDecls(tokens, match);
  const blockOf = new Array<number>(tokens.length).fill(-1);
  tests.forEach((c, b) => {
    for (let k = c.start; k <= c.end; k += 1) blockOf[k] = b;
  });
  const declOf = new Array<number>(tokens.length).fill(-1);
  decls.forEach((d, n) => {
    for (let k = d.from; k <= d.to; k += 1) if (blockOf[k] === -1) declOf[k] = n;
  });
  const closure = new Set(changed);
  const affected = tests.map(() => false);
  // The identifiers at every top-level token: itself, or those inside a template's `${…}`
  // (CT-06zxe review r1 S1-1), which belong where the template stands.
  const names = tokens.map((t) =>
    t.kind === 'id'
      ? [t.text]
      : flatten(t.inner ?? []).flatMap((u) => (u.kind === 'id' ? [u.text] : [])),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (let k = 0; k < tokens.length; k += 1) {
      const name = (names[k] as string[]).find((x) => closure.has(x));
      if (name === undefined) continue;
      const b = blockOf[k] as number;
      if (b >= 0) {
        affected[b] = true;
        continue;
      }
      const n = declOf[k] as number;
      const decl = n >= 0 ? decls[n] : undefined;
      if (decl === undefined) {
        return {
          ok: false,
          reason: `"${name}" is used outside the test blocks and the top-level helpers (a hook, a describe body, a top-level statement or table): its impact cannot be bounded`,
        };
      }
      if (!closure.has(decl.name)) {
        closure.add(decl.name);
        grew = true;
      }
    }
  }
  return { ok: true, closure: [...closure], affected };
}

/**
 * Why a helper change cannot be bounded because a literal names one of `names` (CT-06zxh, review
 * r2 S2-1), or null: a string, a template's static text or a regular expression anywhere in
 * `source` outside the declarations of the `changed` top-level helpers that holds one of `names`
 * (the changed helpers and their callers, helperImpact's closure) as a whole word — an
 * `eval('h()')`, a `m['h']()` after a dynamic import, a test title too. The caller then judges
 * the whole file: more tests, never fewer.
 */
export function helperNamedInLiteral(
  source: string,
  names: readonly string[],
  changed: readonly string[],
): string | null {
  let tokens: Token[];
  let match: number[];
  try {
    tokens = tokenize(source);
    match = matchBrackets(tokens);
  } catch (err) {
    return `the file cannot be read (${String(err)})`;
  }
  const inChanged = new Array<boolean>(tokens.length).fill(false);
  for (const d of helperDecls(tokens, match)) {
    if (!changed.includes(d.name)) continue;
    for (let k = d.from; k <= d.to; k += 1) inChanged[k] = true;
  }
  const words = names.map((n) => ({
    name: n,
    re: new RegExp(`(?<![\\w$])${escapeRegex(n)}(?![\\w$])`, 'u'),
  }));
  for (let k = 0; k < tokens.length; k += 1) {
    if (inChanged[k]) continue;
    for (const t of flatten([tokens[k] as Token])) {
      const texts =
        t.kind === 'str'
          ? [t.text, t.value ?? '']
          : t.kind === 're'
            ? [t.text]
            : t.kind === 'tpl'
              ? (t.parts ?? []).map((p) => p ?? t.text)
              : [];
      const hit = words.find((w) => texts.some((x) => w.re.test(x)));
      if (hit !== undefined) {
        return `a literal names "${hit.name}" (${JSON.stringify(t.text.slice(0, 60))}): a call by a string (eval, a key after a dynamic import) cannot be bounded`;
      }
    }
  }
  return null;
}

const CODE_FILE = /\.[cm]?[jt]sx?$/;

function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Repo-relative POSIX path of `spec` (./ or ../) seen from the module at `from`, or null. */
function resolveRelative(from: string, spec: string): string | null {
  const parts = dirOf(from) === '' ? [] : dirOf(from).split('/');
  for (const p of spec.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(p);
    }
  }
  return parts.join('/');
}

/** The tokens with those inside template expressions, depth first. */
function flatten(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    out.push(t);
    if (t.inner !== undefined) out.push(...flatten(t.inner));
  }
  return out;
}

/** Calls that load files / modules by a computed name (never resolved: always dynamic). */
const DYNAMIC_ACCESS = new Set(['glob', 'globSync', 'require', 'createRequire']);
/** Calls that list a directory: resolved statically when they can be (listedDirectories). */
const LISTING = new Set(['readdir', 'readdirSync', 'opendir', 'opendirSync']);

/** The reason a module may load files it does not name, or null (directory listings aside). */
function dynamicAccess(code: readonly Token[]): string | null {
  const tokens = flatten(code);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind !== 'id') continue;
    if (DYNAMIC_ACCESS.has(t.text)) return `it uses ${t.text}`;
    if (t.text === 'glob' && tokens[i - 1]?.text === '.') return 'it uses import.meta.glob';
    if (t.text === 'import' && tokens[i + 1]?.text === '(') {
      const arg = tokens[i + 2];
      const literal =
        arg !== undefined &&
        (arg.kind === 'str' || (arg.kind === 'tpl' && (arg.parts?.length ?? 0) === 1)) &&
        (tokens[i + 3]?.text === ')' || tokens[i + 3]?.text === ',');
      if (!literal) return 'it imports a module by a computed name';
    }
  }
  return null;
}

/** Repo-relative normalised path of `dir` + `spec` (POSIX segments), or null when it escapes. */
function joinPath(dir: string, spec: string): string | null {
  const parts = dir === '' ? [] : dir.split('/');
  for (const p of spec.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(p);
    }
  }
  return parts.join('/');
}

/** Index of the bracket that closes the one at `open`, or -1. */
function closeOf(ts: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < ts.length; i += 1) {
    const text = ts[i]?.kind === 'punct' ? (ts[i] as Token).text : '';
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The top-level arguments between ts[open] === '(' and its close: [start, end) index pairs. */
function argsOf(ts: readonly Token[], open: number): [number, number][] | null {
  const close = closeOf(ts, open);
  if (close < 0) return null;
  const out: [number, number][] = [];
  let start = open + 1;
  let depth = 0;
  for (let i = open + 1; i < close; i += 1) {
    const text = ts[i]?.kind === 'punct' ? (ts[i] as Token).text : '';
    if (text === '(' || text === '[' || text === '{') depth += 1;
    else if (text === ')' || text === ']' || text === '}') depth -= 1;
    else if (text === ',' && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  if (start < close) out.push([start, close]);
  return out;
}

/**
 * A path value resolved statically: `url` marks `new URL(…)` / import.meta.url semantics; `raw`
 * keeps the literal text a parameter was called with, for `new URL(p, base)` and join segments.
 * A bare literal has no `path`: a file-system path is relative to the working directory, which
 * is not known (Codex review r1, S2), so it resolves only as a URL spec or a join segment.
 */
type PathValue = { path: string | null; url: boolean; raw?: string };

/** The static string of a literal or expression-free template token, or null. */
function staticString(t: Token | undefined): string | null {
  if (t === undefined) return null;
  if (t.kind === 'str') return typeof t.value === 'string' ? t.value : null;
  if (t.kind === 'tpl' && t.parts?.length === 1) return t.parts[0] ?? null;
  return null;
}

/**
 * Resolves the path expression at ts[i] (CT-06r), given the module's path and the constants
 * already resolved: a literal (only its text: as a file-system path it is relative to the
 * working directory, which is unknown, so it resolves only as a URL spec or a join segment),
 * `__dirname`,
 * `import.meta.dirname`, `import.meta.url`, a known constant, `path.join` / `join` /
 * `path.resolve` / `resolve` of a resolved first argument and literal segments, `path.dirname` /
 * `dirname` of a resolved value, `fileURLToPath(…)`, `new URL(literal, resolved)`, and
 * parentheses around any of these. Anything else is null (not resolved). `end` is the index after
 * the expression when resolved.
 */
function resolveExpr(
  ts: readonly Token[],
  i: number,
  modulePath: string,
  env: ReadonlyMap<string, PathValue>,
): { value: PathValue | null; end: number } {
  const none = { value: null, end: i };
  const t = ts[i];
  if (t === undefined) return none;
  const after = (value: PathValue | null, end: number) => {
    // `.href` / `.pathname` of a URL value: the same path.
    if (
      value !== null &&
      ts[end]?.text === '.' &&
      /^(href|pathname)$/.test(ts[end + 1]?.text ?? '')
    ) {
      return { value, end: end + 2 };
    }
    return { value, end };
  };
  const literal = staticString(t);
  if (literal !== null) return { value: { path: null, url: false, raw: literal }, end: i + 1 };
  // The literal text a parameter or constant stands for (a call like list('./x')).
  const rawOf = (k: number): string | null =>
    staticString(ts[k]) ??
    (ts[k]?.kind === 'id' ? (env.get((ts[k] as Token).text)?.raw ?? null) : null);
  if (t.kind === 'punct' && t.text === '(') {
    const inner = resolveExpr(ts, i + 1, modulePath, env);
    if (inner.value === null || ts[inner.end]?.text !== ')') return none;
    return after(inner.value, inner.end + 1);
  }
  if (t.kind !== 'id') return none;
  if (t.text === '__dirname') return { value: { path: dirOf(modulePath), url: false }, end: i + 1 };
  if (t.text === 'import' && ts[i + 1]?.text === '.' && ts[i + 2]?.text === 'meta') {
    if (ts[i + 3]?.text === '.' && ts[i + 4]?.text === 'dirname') {
      return { value: { path: dirOf(modulePath), url: false }, end: i + 5 };
    }
    if (ts[i + 3]?.text === '.' && ts[i + 4]?.text === 'url') {
      return { value: { path: modulePath, url: true }, end: i + 5 };
    }
    return none;
  }
  // `new URL(literal, base)`: the literal is resolved against the directory of the base file (or
  // the base directory when it ends with "/").
  if (t.text === 'new' && ts[i + 1]?.text === 'URL' && ts[i + 2]?.text === '(') {
    const args = argsOf(ts, i + 2);
    if (args === null || args.length !== 2) return none;
    const [specArg, baseArg] = args as [[number, number], [number, number]];
    const spec = specArg[1] - specArg[0] === 1 ? rawOf(specArg[0]) : null;
    const base = resolveExpr(ts, baseArg[0], modulePath, env);
    if (spec === null || base.value?.path == null || base.end !== baseArg[1]) return none;
    if (spec.startsWith('/') || /^[a-z]+:/i.test(spec)) return none;
    const from = base.value.path.endsWith('/')
      ? base.value.path.slice(0, -1)
      : dirOf(base.value.path);
    const joined = joinPath(from, spec.replace(/[?#].*$/, ''));
    if (joined === null) return none;
    return after(
      { path: spec.endsWith('/') ? `${joined}/` : joined, url: true },
      closeOf(ts, i + 2) + 1,
    );
  }
  // `path.x(…)` or a bare `x(…)` (x = join, resolve, dirname); `fileURLToPath(…)`.
  let fn = t.text;
  let open = i + 1;
  if ((fn === 'path' || fn === 'node') && ts[i + 1]?.text === '.' && ts[i + 2]?.kind === 'id') {
    fn = (ts[i + 2] as Token).text;
    open = i + 3;
  }
  if (
    ts[open]?.text === '(' &&
    (fn === 'join' || fn === 'resolve' || fn === 'dirname' || fn === 'fileURLToPath')
  ) {
    const args = argsOf(ts, open);
    if (args === null || args.length === 0) return none;
    const end = closeOf(ts, open) + 1;
    const first = args[0] as [number, number];
    const head = resolveExpr(ts, first[0], modulePath, env);
    if (head.value?.path == null || head.end !== first[1]) return none;
    const headPath = head.value.path.endsWith('/') ? head.value.path.slice(0, -1) : head.value.path;
    if (fn === 'fileURLToPath') {
      return args.length === 1 ? after({ path: headPath, url: false }, end) : none;
    }
    if (fn === 'dirname') {
      return args.length === 1 ? after({ path: dirOf(headPath), url: false }, end) : none;
    }
    let path: string | null = headPath;
    for (const [s, e] of args.slice(1)) {
      const segment = e - s === 1 ? rawOf(s) : null;
      if (segment === null || segment.startsWith('/')) return none;
      path = joinPath(path, segment);
      if (path === null) return none;
    }
    return after({ path, url: false }, end);
  }
  const known = env.get(t.text);
  if (known !== undefined && ts[i + 1]?.text !== '(') return after(known, i + 1);
  return none;
}

/** A function of the module: its name, parameter names (null: not a plain name) and body range. */
type Fn = { name: string; params: (string | null)[]; bodyStart: number; bodyEnd: number };

/** Parameter names of the list between ts[open] === '(' and its close. */
function paramNames(ts: readonly Token[], open: number): (string | null)[] | null {
  const args = argsOf(ts, open);
  if (args === null) return null;
  return args.map(([s]) => (ts[s]?.kind === 'id' ? (ts[s] as Token).text : null));
}

/** The named functions of the module (declarations and `const f = (…) => {…}`). */
function functionsOf(ts: readonly Token[]): Fn[] {
  const out: Fn[] = [];
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i] as Token;
    if (t.kind !== 'id') continue;
    let name: string | null = null;
    let open = -1;
    if (t.text === 'function' && ts[i + 1]?.kind === 'id' && ts[i + 2]?.text === '(') {
      name = (ts[i + 1] as Token).text;
      open = i + 2;
    } else if (
      (t.text === 'const' || t.text === 'let' || t.text === 'var') &&
      ts[i + 1]?.kind === 'id' &&
      ts[i + 2]?.text === '='
    ) {
      let j = i + 3;
      if (ts[j]?.text === 'async') j += 1;
      if (ts[j]?.text === 'function') {
        j += 1;
        if (ts[j]?.kind === 'id') j += 1;
      }
      if (ts[j]?.text === '(') {
        name = (ts[i + 1] as Token).text;
        open = j;
      }
    }
    if (name === null || open < 0) continue;
    const close = closeOf(ts, open);
    if (close < 0) continue;
    const params = paramNames(ts, open);
    if (params === null) continue;
    // The body: `{` after the parameters (past a return type or `=>`), or an expression body.
    let j = close + 1;
    while (j < ts.length && ts[j]?.text !== '{' && ts[j]?.text !== '=>' && !(ts[j] as Token).nl)
      j += 1;
    if (ts[j]?.text === '=>') j += 1;
    if (ts[j]?.text !== '{') continue;
    const bodyEnd = closeOf(ts, j);
    if (bodyEnd < 0) continue;
    out.push({ name, params, bodyStart: j, bodyEnd });
  }
  return out;
}

/**
 * The directories a module lists (readdir, readdirSync, opendir, opendirSync; CT-06r, after
 * B1-12g): each listing's directory is resolved statically (resolveExpr) through the module's
 * constants; a listing inside a named function whose directory comes from a parameter is
 * resolved at every call of that function outside its own body (a recursive call inside it
 * walks the same tree). `dirs` are repo-relative; `unresolved` says why a listing could not be
 * resolved (the module is then treated as able to read anything, as before).
 */
export function listedDirectories(
  code: readonly Token[],
  modulePath: string,
): { dirs: string[]; unresolved: string | null } {
  const ts = code;
  // Constants: `const NAME = <path expression>` whose initialiser is the whole expression (a
  // `.replace(…)`, an operator or anything else after it leaves the name unknown; Codex review
  // r1, S2); two passes for a forward reference.
  const env = new Map<string, PathValue>();
  const initialiserEnds = (k: number): boolean =>
    k >= ts.length || ts[k]?.text === ';' || ts[k]?.text === ',' || (ts[k] as Token).nl;
  // A name declared twice (a same-named local in another scope) or assigned anywhere outside its
  // declaration is no constant: scopes are not tracked, so it stays unknown (Codex review r2 and
  // r3, S2).
  const declared = new Map<string, number>();
  const unknown = new Set<string>();
  for (let i = 0; i + 2 < ts.length; i += 1) {
    const t = ts[i] as Token;
    const name = ts[i + 1];
    if (name?.kind !== 'id') continue;
    if (t.kind === 'id' && (t.text === 'const' || t.text === 'let' || t.text === 'var')) {
      declared.set(name.text, (declared.get(name.text) ?? 0) + 1);
    }
  }
  for (const [name, count] of declared) if (count > 1) unknown.add(name);
  for (let i = 1; i < ts.length; i += 1) {
    const t = ts[i] as Token;
    if (t.kind !== 'id' || !declared.has(t.text) || ts[i + 1]?.text !== '=') continue;
    const before = ts[i - 1]?.text;
    if (before === 'const' || before === 'let' || before === 'var' || before === '.') continue;
    unknown.add(t.text);
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i + 3 < ts.length; i += 1) {
      const t = ts[i] as Token;
      if (t.kind !== 'id' || (t.text !== 'const' && t.text !== 'let' && t.text !== 'var')) continue;
      const name = ts[i + 1];
      if (name?.kind !== 'id' || ts[i + 2]?.text !== '=' || unknown.has(name.text)) continue;
      const r = resolveExpr(ts, i + 3, modulePath, env);
      if (r.value !== null && initialiserEnds(r.end)) env.set(name.text, r.value);
    }
  }
  const fns = functionsOf(ts);
  // The scope at a position: the constants minus the parameters of every function enclosing it
  // (a parameter shadows a same-named constant; Codex review r2, S2).
  const scopeAt = (k: number): Map<string, PathValue> => {
    const scope = new Map(env);
    for (const f of fns) {
      if (f.bodyStart < k && k < f.bodyEnd)
        for (const p of f.params) if (p !== null) scope.delete(p);
    }
    return scope;
  };
  const dirs = new Set<string>();
  let unresolved: string | null = null;
  const note = (what: string): void => {
    if (unresolved === null) unresolved = what;
  };
  // A listing inside a template expression is not followed.
  for (const t of flatten(ts)) {
    if (t.kind === 'tpl') {
      for (const x of flatten(t.inner ?? [])) {
        if (x.kind === 'id' && LISTING.has(x.text))
          note(`it uses ${x.text} inside a template expression`);
      }
    }
  }
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i] as Token;
    if (t.kind !== 'id' || !LISTING.has(t.text) || ts[i + 1]?.text !== '(') continue;
    const call = `${t.text}(…)`;
    const args = argsOf(ts, i + 1);
    const first = args?.[0];
    if (first === undefined) {
      note(`it uses ${call} without a directory`);
      continue;
    }
    const resolveWith = (scope: ReadonlyMap<string, PathValue>): string | null => {
      const r = resolveExpr(ts, first[0], modulePath, scope);
      if (r.value?.path == null || r.end !== first[1]) return null;
      return r.value.path.endsWith('/') ? r.value.path.slice(0, -1) : r.value.path;
    };
    const direct = resolveWith(scopeAt(i));
    if (direct !== null) {
      dirs.add(direct);
      continue;
    }
    // Inside a named function: resolve the directory at each call outside the function.
    const inside = fns.filter((f) => f.bodyStart < i && i < f.bodyEnd);
    const fn = inside.length === 0 ? undefined : inside[inside.length - 1];
    if (fn === undefined || fn.params.every((p) => p === null)) {
      note(`it uses ${call} on a directory that cannot be resolved statically`);
      continue;
    }
    // The parameter the listing reads (the listed expression must be that parameter itself, or
    // a resolvable expression over it is handled by resolveWith below).
    const listedParam =
      first[1] - first[0] === 1 && ts[first[0]]?.kind === 'id'
        ? (ts[first[0]] as Token).text
        : null;
    const paramIndex = listedParam === null ? -1 : fn.params.indexOf(listedParam);
    // A recursive call stays in the listed tree only when its argument is the parameter itself,
    // `join(param, …)` / `path.join(param, …)`, or a local const defined as one of those; anything
    // else (dirname(param), a sibling) may leave the tree and is not resolved (Codex review r3,
    // S2).
    const staysInside = (a: [number, number]): boolean => {
      if (paramIndex < 0) return false;
      const isJoinOfParam = (from: number, to: number): boolean => {
        let j = from;
        if (ts[j]?.text === 'path' && ts[j + 1]?.text === '.') j += 2;
        if (ts[j]?.text !== 'join' || ts[j + 1]?.text !== '(') return false;
        const inner = argsOf(ts, j + 1);
        const close = closeOf(ts, j + 1);
        if (inner === null || inner.length === 0 || close !== to - 1) return false;
        const head = inner[0] as [number, number];
        return head[1] - head[0] === 1 && ts[head[0]]?.text === listedParam;
      };
      if (a[1] - a[0] === 1 && ts[a[0]]?.kind === 'id') {
        const id = (ts[a[0]] as Token).text;
        if (id === listedParam) return true;
        // A local `const id = join(param, …)` inside the function body.
        for (let j = fn.bodyStart; j < fn.bodyEnd - 3; j += 1) {
          if (ts[j]?.text === 'const' && ts[j + 1]?.text === id && ts[j + 2]?.text === '=') {
            // The initialiser: up to a `;`, `,` or line break outside brackets.
            let end = j + 3;
            let depth = 0;
            while (end < fn.bodyEnd) {
              const text = ts[end]?.kind === 'punct' ? (ts[end] as Token).text : '';
              if (depth === 0 && end > j + 3 && initialiserEnds(end)) break;
              if (text === '(' || text === '[' || text === '{') depth += 1;
              else if (text === ')' || text === ']' || text === '}') depth -= 1;
              end += 1;
            }
            return isJoinOfParam(j + 3, end);
          }
        }
        return false;
      }
      return isJoinOfParam(a[0], a[1]);
    };
    let calls = 0;
    let failed = false;
    for (let k = 0; k < ts.length; k += 1) {
      const c = ts[k] as Token;
      if (c.kind !== 'id' || c.text !== fn.name || ts[k + 1]?.text !== '(') continue;
      if (ts[k - 1]?.text === 'function') continue; // the declaration itself
      if (fn.bodyStart <= k && k <= fn.bodyEnd) {
        const rarg = (argsOf(ts, k + 1) ?? [])[paramIndex];
        if (rarg !== undefined && staysInside(rarg)) continue; // a recursive walk of the same tree
        failed = true;
        break;
      }
      calls += 1;
      const cargs = argsOf(ts, k + 1) ?? [];
      const callScope = scopeAt(k);
      const scope = new Map(callScope);
      fn.params.forEach((p, idx) => {
        const a = cargs[idx];
        if (p === null || a === undefined) return;
        const r = resolveExpr(ts, a[0], modulePath, callScope);
        if (r.value !== null && r.end === a[1]) scope.set(p, r.value);
        else scope.delete(p);
      });
      const dir = resolveWith(scope);
      if (dir === null) {
        failed = true;
        break;
      }
      dirs.add(dir);
    }
    if (calls === 0 || failed) {
      note(`it uses ${call} in ${fn.name}() on a directory that cannot be resolved statically`);
    }
  }
  return { dirs: [...dirs].sort(), unresolved };
}

/** A string literal (or the static parts of a template) with its offsets in the module text. */
export type Literal = { text: string; start: number; end: number };

/**
 * An import of a module (CT-06w): the specifier as written, where its string literal sits in the
 * module text (the quotes included) and the repository file it names once resolved — or null with
 * `why` when it cannot be resolved (mayReadSupport then judges the literal as before).
 */
export type ModuleImport = {
  spec: string;
  start: number;
  end: number;
  resolved: string | null;
  why: string | null;
};

export type Module = {
  path: string;
  text: string;
  /** String contents (literals, static template parts); null when the text cannot be tokenized. */
  literals: Literal[] | null;
  /** Why the module may load files it does not name (dynamicAccess), or null. */
  dynamic: string | null;
  /** The directories it lists, resolved statically (CT-06r); [] when it lists none. */
  lists: string[];
  /** Its import specifiers resolved to repository paths (CT-06w); [] when it cannot be tokenized. */
  imports: ModuleImport[];
  /**
   * Why the module may read files in a way the rules here do not see (CT-06w, Codex review r4):
   * a file-system API, `import.meta`, a module mock, a listing, a dynamic load; null when none.
   */
  opaque: string | null;
  /** Why the module mocks modules (usesMocking): its own imports may be redirected; null when none. */
  mocking: string | null;
  /**
   * The module is closed (CT-06w): it is not opaque and every relative / `#` import of it
   * resolves to a closed module of the closure or to a file outside the test code. Only an
   * import of a closed module may be skipped by the name rules of mayReadSupport, and only when
   * every other module the rule-test file loads is closed too.
   */
  closed: boolean;
  /**
   * Why the module may reach a file in a way no rule here judges, not even on its own text
   * (CT-06w r6): it cannot be read as code, loads dynamically, executes code or a process, mocks,
   * loads by a template, or has an import that is neither a package nor resolved to a module of
   * the closure or to code outside the test code (or resolved to a module that is not closed).
   * Null when closed, or when its only openness is its own file-system reads, path helpers,
   * `import.meta` and listings resolved statically — those the name and listing rules judge on
   * its text, as before CT-06w. mayReadSupport looks at it for the rule-test file itself only:
   * any other module of the closure that is not closed disables the exemption outright.
   */
  unjudged: string | null;
};

type Reader = (path: string) => string | null;

/** The string literals of a module with their offsets (nested template parts too). */
function literalsOf(tokens: readonly Token[]): Literal[] {
  const out: Literal[] = [];
  for (const t of flatten(tokens)) {
    const start = t.start ?? 0;
    const end = start + t.text.length;
    if (t.kind === 'str' && typeof t.value === 'string') out.push({ text: t.value, start, end });
    if (t.kind === 'tpl')
      for (const p of t.parts ?? []) if (p !== null) out.push({ text: p, start, end });
  }
  return out;
}

/** A member access token (`.` or `?.`). */
const member = (t: Token | undefined): boolean => t?.text === '.' || t?.text === '?.';

/**
 * Identifiers of file-system reads and path helpers (fileAccess). In a module the rule-test file
 * imports they make it open; the rule-test file's own use of them is judged on its own text by the
 * name and listing rules, as before CT-06w (`unjudged` leaves them out; Codex review r5, rule 4).
 */
const FILE_READS = new Set([
  'readFileSync',
  'readFile',
  'readdirSync',
  'readdir',
  'opendirSync',
  'opendir',
  'createReadStream',
  'openSync',
  'statSync',
  'lstatSync',
  'existsSync',
  'accessSync',
  'realpathSync',
  'readlinkSync',
  'fileURLToPath',
  'pathToFileURL',
  '__dirname',
  '__filename',
  'cwd',
]);
/** The file-system modules (their own use by the rule-test file: as FILE_READS). */
const READ_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
/** Identifiers of file-system access, module loading by path and process state (fileAccess). */
const FILE_ACCESS = new Set([
  ...FILE_READS,
  'createRequire',
  'require',
  'glob',
  'globSync',
  // Code or process execution the rules cannot look into (Codex review r5).
  'eval',
  'Function',
  'execSync',
  'execFileSync',
  'spawnSync',
  'execFile',
  'spawn',
  'fork',
  'Worker',
  'getBuiltinModule',
  'runInThisContext',
  'runInNewContext',
  'runInContext',
  'compileFunction',
  'binding',
  'mainModule',
  'dlopen',
  // The Function constructor without its name (Codex review r6: a capability spelled another way).
  'getPrototypeOf',
  '__proto__',
  // Browser and network APIs: in browser mode Vite serves the work tree over HTTP (Codex review r6).
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  'SharedWorker',
  'navigator',
  'document',
  'WebAssembly',
  // Package APIs that read files on the caller's behalf (Codex review r9): Vitest's file snapshot
  // (any path, unlike the snapshot files named after the test that CT-06r judges) and Kysely's
  // migration loader.
  'toMatchFileSnapshot',
  'FileMigrationProvider',
  // Vitest's file attachments of a test (`context.annotate(…, { path })`, `recordArtifact`) and
  // Node's `process.loadEnvFile` (Codex review r10).
  'annotate',
  'recordArtifact',
  'loadEnvFile',
]);
/**
 * Objects whose properties give file access, a loader or code execution (CT-06w, Codex review r6):
 * any use of one other than reading a property by its plain name — a computed key, `?.[…]`, the
 * object passed on as a value (`Reflect.get(process, k)`, `const { x } = process`) — is a
 * capability. (`frames`, `top` and `parent` are left out: common local names, e.g. of stack frames.)
 */
const CAPABILITY_OBJECTS = new Set(['process', 'globalThis', 'global', 'window', 'self']);
/**
 * The properties of `process` a closed module may read (CT-06w, Codex review r10): state, events
 * and streams; any other property — `loadEnvFile` reads a file, `binding`, `dlopen`,
 * `getBuiltinModule` load code — is a capability. (`cwd` counts as a path helper, FILE_READS.)
 */
const PROCESS_PROPERTIES = new Set([
  'env',
  'pid',
  'ppid',
  'platform',
  'arch',
  'version',
  'versions',
  'release',
  'features',
  'title',
  'argv',
  'argv0',
  'execArgv',
  'execPath',
  'exitCode',
  'exit',
  'abort',
  'kill',
  'nextTick',
  'hrtime',
  'uptime',
  'memoryUsage',
  'cpuUsage',
  'resourceUsage',
  'umask',
  'chdir',
  'on',
  'once',
  'off',
  'addListener',
  'removeListener',
  'removeAllListeners',
  'listeners',
  'listenerCount',
  'emitWarning',
  'stdout',
  'stderr',
  'stdin',
  'send',
  'channel',
  'connected',
  'disconnect',
]);
const FILE_MODULES = new Set([
  ...READ_MODULES,
  'child_process',
  'node:child_process',
  'vm',
  'node:vm',
  'worker_threads',
  'node:worker_threads',
  'module',
  'node:module',
  'process',
  'node:process',
  'wasi',
  'node:wasi',
  // Code execution and the browser-mode server commands (Codex review r6).
  'inspector',
  'node:inspector',
  'cluster',
  'node:cluster',
  'repl',
  'node:repl',
  'vitest/browser',
  '@vitest/browser',
  '@vitest/browser/context',
]);
const MOCKING = new Set([
  'mock',
  'doMock',
  'unmock',
  'doUnmock',
  'importActual',
  'importMock',
  'hoisted',
]);

/**
 * Packages a closed module may import (CT-06w, Codex review r8): Node built-ins and npm packages
 * of this workspace that read no repository file and load no code on the caller's behalf (an
 * ordinary package API such as prettier's resolveConfig, typescript's program or an OpenAPI
 * parser's $ref resolution does — those, and every package not listed, keep a module open). The
 * capability built-ins (fs, child_process, vm …) are judged by fileAccess instead.
 */
const KNOWN_BUILTINS = new Set([
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'events',
  'http',
  'http2',
  'https',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'timers',
  'timers/promises',
  'tls',
  'tty',
  'url',
  'util',
  'util/types',
  'zlib',
]);
/**
 * npm specifiers, exactly as written: a subpath of a listed package is another entry (Codex review
 * r9: `kysely/migration` loads files) and is listed on its own or not at all.
 */
const KNOWN_PACKAGES = new Set([
  'vitest',
  'fast-check',
  'kysely',
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  '@testing-library/react',
  '@testing-library/user-event',
  'jose',
  'ajv',
  'ajv/dist/2020.js',
  'ajv-formats',
  'openapi-types',
  'reflect-metadata',
]);

function knownPackage(spec: string): boolean {
  if (KNOWN_BUILTINS.has(spec.startsWith('node:') ? spec.slice(5) : spec)) return true;
  return !spec.startsWith('node:') && KNOWN_PACKAGES.has(spec);
}

/**
 * The capability a module name names (CT-06w): one of FILE_MODULES, a subpath of one of their
 * built-ins (`node:inspector/promises`, `fs/promises`; Codex review r7), the Vitest browser
 * commands (`@vitest/browser…`, `vitest/browser…`) or `node:test` (its `mock.module`); `reads`
 * when it is the file system. Null for any other name.
 */
function capabilityModule(name: string): { reads: boolean } | null {
  const bare = name.startsWith('node:') ? name.slice(5) : name;
  const head = bare.split('/')[0] ?? bare;
  if (FILE_MODULES.has(name) || FILE_MODULES.has(head)) {
    return { reads: READ_MODULES.has(name) || head === 'fs' };
  }
  if (/^(@vitest\/browser|vitest\/browser)(\/|$)/.test(name)) return { reads: false };
  if (name === 'node:test' || name.startsWith('node:test/')) return { reads: false };
  return null;
}

/**
 * Why a module may read files in a way the rules of mayReadSupport do not see (CT-06w, Codex
 * review r4): a file-system API or a path built from `import.meta` / `__dirname`, a module mock
 * (Vitest redirects it to `__mocks__`), `require` / `glob`, code or process execution, a browser
 * or network API, a way to the Function constructor, a capability object (CAPABILITY_OBJECTS) used
 * by a computed key or as a value, a capability named by a string literal — also one built from
 * literals with `+` or `[…].join(…)` (Codex reviews r5, r6). Null when it uses none of them. This
 * is a list of spellings, not a proof: a name computed some other way is not seen.
 * With `reads` false, the file-system reads, path helpers and `import.meta` (FILE_READS,
 * READ_MODULES) do not count: what is left is what no rule here judges, even on the module's own
 * text (`Module.unjudged`, CT-06w r6).
 */
function fileAccess(code: readonly Token[], reads = true): string | null {
  const tokens = flatten(code);
  const listed = (name: string): string | null => {
    if (FILE_ACCESS.has(name) || name === 'constructor' || name === 'globalThis') {
      return reads || !FILE_READS.has(name) ? name : null;
    }
    const mod = capabilityModule(name);
    if (mod !== null) return reads || !mod.reads ? name : null;
    return null;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind === 'id' && FILE_ACCESS.has(t.text) && (reads || !FILE_READS.has(t.text))) {
      return `it uses ${t.text}`;
    }
    // A capability named by a string — a computed key (`process['getBuiltinModule']`, a
    // destructured 'readFileSync'), a module name — also when it is built from literals with `+`
    // or `[…].join(…)` (Codex review r6).
    for (const value of stringValues(tokens, i)) {
      const name = listed(value);
      if (name !== null) return `it uses ${name}`;
    }
    // The Function constructor in any spelling but a constructor definition (`constructor(…) {`):
    // `.constructor`, `{ constructor: C } = f`, `{ constructor }` (Codex reviews r6, r7).
    if (t.kind === 'id' && t.text === 'constructor') {
      const definition =
        !member(tokens[i - 1]) &&
        tokens[i + 1]?.text === '(' &&
        tokens[closeOf(tokens, i + 1) + 1]?.text === '{';
      if (!definition) return 'it uses constructor';
    }
    if (
      t.kind === 'id' &&
      CAPABILITY_OBJECTS.has(t.text) &&
      !member(tokens[i - 1]) &&
      !(tokens[i + 1]?.text === ':' && (tokens[i - 1]?.text === '{' || tokens[i - 1]?.text === ','))
    ) {
      const next = tokens[i + 1]?.text;
      const plain = (next === '.' || next === '?.') && tokens[i + 2]?.kind === 'id';
      if (!plain) return `it uses ${t.text} by a computed key or as a value`;
    }
    // `process.<name>` (also through a global object): only the listed properties; any other
    // (`process.loadEnvFile`, Codex review r10) is a capability.
    if (
      t.kind === 'id' &&
      t.text === 'process' &&
      (!member(tokens[i - 1]) || CAPABILITY_OBJECTS.has(tokens[i - 2]?.text ?? '')) &&
      member(tokens[i + 1]) &&
      tokens[i + 2]?.kind === 'id' &&
      !PROCESS_PROPERTIES.has((tokens[i + 2] as Token).text) &&
      (reads || !FILE_READS.has((tokens[i + 2] as Token).text))
    ) {
      return `it uses process.${(tokens[i + 2] as Token).text}`;
    }
    if (
      reads &&
      t.kind === 'id' &&
      t.text === 'meta' &&
      tokens[i - 1]?.text === '.' &&
      tokens[i - 2]?.text === 'import'
    ) {
      return 'it uses import.meta';
    }
    // A template specifier, or an import inside a template's expressions, is not in `imports`.
    if (t.kind === 'id' && t.text === 'import' && tokens[i + 1]?.text === '(') {
      if (tokens[i + 2]?.kind === 'tpl') return 'it imports a module by a template';
    }
    if (
      t.kind === 'tpl' &&
      flatten(t.inner ?? []).some((x) => x.kind === 'id' && x.text === 'import')
    ) {
      return 'it imports inside a template';
    }
  }
  return usesMocking(tokens);
}

/** The cooked value of a string literal or of a template without expressions; null otherwise. */
function literalValue(t: Token | undefined): string | null {
  if (t?.kind === 'str') return typeof t.value === 'string' ? t.value : null;
  if (t?.kind === 'tpl' && (t.inner ?? []).length === 0 && t.parts?.length === 1) {
    return t.parts[0] ?? null;
  }
  return null;
}

/**
 * The string values that start at token `i` (CT-06w, Codex review r6): the literal itself, the
 * literals joined by a chain of `+` that starts there, and `['a', 'b'].join(sep)` of literals when
 * `i` is that `[`. Folding is only what a capability name built in plain sight looks like; it is
 * no proof that a module cannot compute a name.
 */
function stringValues(tokens: readonly Token[], i: number): string[] {
  const out: string[] = [];
  const first = literalValue(tokens[i]);
  if (first !== null) {
    // Every literal counts on its own, also after a `+` (`empty + 'constructor'`; Codex review
    // r7), and so does every chain of literals that starts with it.
    out.push(first);
    let folded = first;
    for (let j = i + 1; tokens[j]?.text === '+'; j += 2) {
      const next = literalValue(tokens[j + 1]);
      if (next === null) break;
      folded += next;
      out.push(folded);
    }
  }
  if (tokens[i]?.text === '[') {
    const parts: string[] = [];
    let j = i + 1;
    for (; ; j += 2) {
      const v = literalValue(tokens[j]);
      if (v === null) break;
      parts.push(v);
      if (tokens[j + 1]?.text !== ',') {
        j += 1;
        break;
      }
    }
    if (
      parts.length > 0 &&
      tokens[j]?.text === ']' &&
      member(tokens[j + 1]) &&
      tokens[j + 2]?.text === 'join' &&
      tokens[j + 3]?.text === '('
    ) {
      const sep = tokens[j + 4]?.text === ')' ? ',' : literalValue(tokens[j + 4]);
      if (sep !== null) out.push(parts.join(sep));
    }
  }
  return out;
}

/**
 * Why a module mocks modules (CT-06w, Codex reviews r4, r5, r6): `vi.<mock…>` / `vitest.<mock…>`
 * (also with `?.`), a call of such a method on anything (`m.mock(…)`), a mock function under its
 * own name (destructured, imported), a mock name as a string (a computed key, also built from
 * literals), `vi[…]` or `vi` passed on as a value; Vitest hoists mocks (`doMock` at run time) and
 * redirects imports to `__mocks__` or a factory, which the rules here do not follow. `x.mock` read
 * as a property (a spy's `.mock.calls`) is no mock. Null when none.
 */
function usesMocking(tokens: readonly Token[]): string | null {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    // `vi[…]`, `vi?.[…]`, or `vi` passed on as a value (Codex review r6); an import or export
    // clause (`{ vi }`, `vi as v`) and an object shorthand are no use.
    if (t.kind === 'id' && (t.text === 'vi' || t.text === 'vitest') && !member(tokens[i - 1])) {
      const next = tokens[i + 1]?.text;
      if (next === '[' || (next === '?.' && tokens[i + 2]?.text === '[')) {
        return `it uses ${t.text}[…]`;
      }
      const prev = tokens[i - 1]?.text;
      const clause =
        (prev === '{' || prev === ',' || prev === 'import' || prev === 'as') &&
        (next === '}' || next === ',' || next === 'as' || next === 'from');
      if (!clause && next !== '.' && next !== '?.') return `it uses ${t.text} as a value`;
    }
    for (const value of stringValues(tokens, i)) {
      if (MOCKING.has(value)) return `it uses '${value}'`;
    }
    if (t.kind !== 'id' || !MOCKING.has(t.text)) continue;
    // Destructured or imported under its own name (`const { doMock } = vi`, `import { mock }`).
    if (!member(tokens[i - 1])) return `it uses ${t.text}`;
    // A member of any receiver (`v.doMock?.(…)` with `vi as v`; Codex review r7) — except a
    // property chain through `.mock` (a spy's `.mock.calls`), which is no mock call.
    const ns = tokens[i - 2]?.text;
    const next = tokens[i + 1]?.text;
    const called = next === '(' || (next === '?.' && tokens[i + 2]?.text === '(');
    const chain = (next === '.' || next === '?.') && tokens[i + 2]?.kind === 'id';
    if (t.text !== 'mock' || ns === 'vi' || ns === 'vitest' || called || !chain)
      return `it uses ${ns}.${t.text}`;
  }
  return null;
}

/**
 * The module specifiers of a module (CT-06w): the string of an import or export declaration —
 * read forward from an `import` / `export` keyword at the top level of the module's own token list
 * (`import 'x'`, `import <clause> from 'x'`, `export * [as n] from 'x'`, `export [type] { … } from
 * 'x'`; the clause is names, `*`, `,`, `as`, `type` and one `{ … }`, anything else ends it without
 * a specifier — so a `from` variable followed by a string on the next line is no import, Codex
 * review r6) — and the single literal of `import('x')`. The keyword is never a member
 * (`reader.import('x')` is a method call; Codex review r1); the expressions of a template are
 * lexed into one list and are not looked at (Codex review r2). A template specifier,
 * `vi.mock(import('x'))`, `new URL(…)` and `require` are not imports here: their literals keep the
 * name rules of mayReadSupport.
 */
function importSpecifiers(
  tokens: readonly Token[],
): { spec: string; start: number; end: number }[] {
  const out: { spec: string; start: number; end: number }[] = [];
  const str = (t: Token | undefined): t is Token =>
    t?.kind === 'str' && typeof t.value === 'string' && t.start !== undefined;
  const push = (t: Token): void => {
    out.push({
      spec: t.value as string,
      start: t.start as number,
      end: (t.start as number) + t.text.length,
    });
  };
  // The specifier of the declaration whose clause starts at `j`, or null — by the grammar of
  // import and export declarations only (Codex reviews r6, r7: `export { a }` followed by
  // `void from` and a string on later lines is no import):
  //   import [type] 'x' | import [type] <binding> from 'x'
  //     binding = name | name , * as name | name , { … } | * as name | { … }
  //   export [type] * [as name|'name'] from 'x' | export [type] { … } from 'x'
  const id = (t: Token | undefined): boolean => t?.kind === 'id';
  const braces = (k: number): number => {
    if (tokens[k]?.text !== '{') return -1;
    const close = closeOf(tokens, k);
    return close < 0 ? -1 : close + 1;
  };
  const fromAt = (k: number): Token | null =>
    tokens[k]?.text === 'from' && id(tokens[k]) && str(tokens[k + 1])
      ? (tokens[k + 1] as Token)
      : null;
  const declaration = (j: number, exported: boolean): Token | null => {
    // `type` is a modifier unless it is the default binding itself (`import type from 'x'`).
    if (tokens[j]?.text === 'type' && fromAt(j + 1) === null) {
      const next = tokens[j + 1];
      if (id(next) || next?.text === '{' || next?.text === '*') j += 1;
    }
    const namespace = (k: number): number =>
      tokens[k]?.text === '*' && tokens[k + 1]?.text === 'as' && id(tokens[k + 2]) ? k + 3 : -1;
    if (exported) {
      if (tokens[j]?.text === '*') {
        let k = j + 1;
        if (tokens[k]?.text === 'as' && (id(tokens[k + 1]) || str(tokens[k + 1]))) k += 2;
        return fromAt(k);
      }
      const k = braces(j);
      return k < 0 ? null : fromAt(k);
    }
    if (str(tokens[j])) return tokens[j] as Token;
    let k = j;
    if (id(tokens[k]) && tokens[k]?.text !== 'from') {
      k += 1;
    } else if (id(tokens[k]) && fromAt(k + 1) !== null) {
      k += 1; // import from from 'x'
    } else if (tokens[k]?.text !== '*' && tokens[k]?.text !== '{') {
      return null;
    }
    if (k > j && tokens[k]?.text === ',') k += 1;
    else if (k > j) return fromAt(k);
    const after = tokens[k]?.text === '*' ? namespace(k) : braces(k);
    return after < 0 ? null : fromAt(after);
  };
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as Token;
    if (t.kind === 'punct') {
      if (t.text === '(' || t.text === '[' || t.text === '{') depth += 1;
      else if (t.text === ')' || t.text === ']' || t.text === '}') depth -= 1;
      continue;
    }
    if (t.kind !== 'id' || member(tokens[i - 1])) continue;
    const next = tokens[i + 1];
    if (t.text === 'import' && next?.text === '(') {
      // `vi.mock(import('x'))` is a mock, not a load (Vitest redirects it; Codex review r4).
      const mocked =
        tokens[i - 1]?.text === '(' &&
        tokens[i - 2]?.kind === 'id' &&
        MOCKING.has((tokens[i - 2] as Token).text) &&
        member(tokens[i - 3]);
      const lit = tokens[i + 2];
      const after = tokens[i + 3]?.text;
      if (!mocked && str(lit) && (after === ')' || after === ',')) push(lit);
      continue;
    }
    if (depth !== 0) continue;
    if (t.text === 'import' && next !== undefined && next.text !== '.' && next.text !== ':') {
      const spec = declaration(i + 1, false);
      if (spec !== null) push(spec);
    } else if (t.text === 'export') {
      const spec = declaration(i + 1, true);
      if (spec !== null) push(spec);
    }
  }
  return out;
}

/** The files the closure follows for a relative literal (conservative: every spelling). */
function candidatesOf(target: string): string[] {
  return [target, target.replace(/\.js$/, '.ts'), `${target}.ts`, `${target}/index.ts`];
}

/**
 * What a repository path is (CT-06w): a regular file, a directory, absent, or `other` — a
 * symbolic link, a submodule, a path whose spelling is not the tree's (a directory link or a
 * case alias in a work tree), anything whose identity is not certain (Codex reviews r1, r2). An
 * import never resolves through `other`.
 */
export type PathKind = 'file' | 'dir' | 'absent' | 'other';

/** How the closure sees files: `read` the text of a path (null: none) and the kind of a path. */
type Files = { read: Reader; kind: (path: string) => PathKind };

/**
 * The nearest file called `name` at or above `dir`: its directory and text — or the reason it
 * cannot be told: a `name` on the way that is not a regular file (a symbolic link; Codex review
 * r2) stops the search, since the runtime would read it.
 */
function nearestFile(
  dir: string,
  name: string,
  files: Files,
): { dir: string; text: string } | { why: string } | null {
  for (let d = dir; ; d = dirOf(d)) {
    const path = d === '' ? name : `${d}/${name}`;
    const kind = files.kind(path);
    if (kind === 'file') {
      const text = files.read(path);
      if (text !== null) return { dir: d, text };
    }
    if (kind === 'other' || kind === 'dir') return { why: `${path} is not a regular file` };
    if (d === '') return null;
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The key of `keys` that matches `spec`: the key itself, or the single key with one `*` whose
 * prefix and suffix enclose a non-empty rest — and that rest. Undecided (`ambiguous`): two
 * matching patterns (Node and Vite's resolver rank them differently; Codex review r2), a folder
 * key (`#x/`) that covers the specifier, a pattern with a regular-expression character (Vite's
 * resolver builds an unescaped RegExp from the key, so `#k.t.*` also matches `#kit.ts`; Codex
 * review r3), or a pattern that such a RegExp matches although its prefix and suffix do not.
 */
function matchKey(
  keys: readonly string[],
  spec: string,
): { key: string; star: string } | 'ambiguous' | null {
  const hits: { key: string; star: string }[] = [];
  let loose = 0;
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star < 0) {
      if (key === spec) return { key, star: '' };
      if (key.endsWith('/') && spec.startsWith(key)) return 'ambiguous';
      continue;
    }
    if (key.indexOf('*', star + 1) >= 0) return 'ambiguous';
    try {
      if (new RegExp(`^${key.replace('*', '(.*)')}$`).test(spec)) loose += 1;
    } catch {
      return 'ambiguous';
    }
    const pre = key.slice(0, star);
    const post = key.slice(star + 1);
    if (spec.length <= pre.length + post.length || !spec.startsWith(pre) || !spec.endsWith(post)) {
      continue;
    }
    if (/[.+?^${}()|[\]\\]/.test(key)) return 'ambiguous';
    hits.push({ key, star: spec.slice(pre.length, spec.length - post.length) });
  }
  if (hits.length > 1 || loose > hits.length) return 'ambiguous';
  return hits[0] ?? null;
}

type Resolution = { resolved: string | null; why: string | null };

const unresolved = (why: string): Resolution => ({ resolved: null, why });
const resolvedAs = (path: string): Resolution => ({ resolved: path, why: null });

/** Vite's `resolve.extensions`, in its order. */
const RESOLVE_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];

/**
 * The file a repository path stands for as a module (CT-06w; the rules Vite applies, and only
 * where one file is certain, Codex reviews r1 and r2): the path itself when it is a regular
 * file; else, for a `.js` path, the `.ts` file (TypeScript lets `./x.js` name it) when the `.js`
 * path is absent; else, for a path without an extension, the single file among path + Vite's
 * extensions, else the single `path/index` + extension when the path is a directory without a
 * package.json. A candidate of kind `other` on the way (a symbolic link the runtime may follow),
 * two candidates, a package directory or nothing at all are unresolved.
 */
function resolveModuleFile(target: string, files: Files): Resolution {
  const kind = files.kind(target);
  if (kind === 'file') return resolvedAs(target);
  if (kind === 'other') return unresolved(`${target} is not a regular file`);
  if (/\.[A-Za-z0-9]+$/.test(baseName(target))) {
    if (kind === 'dir') return unresolved(`${target} is a directory`);
    if (target.endsWith('.js')) {
      const ts = target.replace(/\.js$/, '.ts');
      const tsKind = files.kind(ts);
      if (tsKind === 'file') return resolvedAs(ts);
      if (tsKind !== 'absent') return unresolved(`${ts} is not a regular file`);
    }
    return unresolved(`no file at ${target}`);
  }
  const certain = (paths: string[]): string[] | string => {
    const found: string[] = [];
    for (const p of paths) {
      const k = files.kind(p);
      if (k === 'file') found.push(p);
      else if (k !== 'absent') return `${p} is not a regular file`;
    }
    return found;
  };
  const own = certain(RESOLVE_EXTENSIONS.map((e) => `${target}${e}`));
  if (typeof own === 'string') return unresolved(own);
  if (own.length > 1) return unresolved(`${target} is ambiguous (${own.join(', ')})`);
  if (kind === 'absent') {
    return own.length === 1 ? resolvedAs(own[0] as string) : unresolved(`no file at ${target}`);
  }
  // A directory: its package.json decides, else its index file — unless a file competes.
  const pkg = files.kind(`${target}/package.json`);
  if (pkg !== 'absent')
    return unresolved(`${target} is a package directory (${target}/package.json)`);
  const index = certain(RESOLVE_EXTENSIONS.map((e) => `${target}/index${e}`));
  if (typeof index === 'string') return unresolved(index);
  const all = [...own, ...index];
  if (all.length === 1) return resolvedAs(all[0] as string);
  if (all.length === 0) return unresolved(`no file at ${target}`);
  return unresolved(`${target} is ambiguous (${all.join(', ')})`);
}

/**
 * A `#…` specifier through the `imports` of the nearest package.json: a string entry that is a
 * plain `./` path — one `*` for a pattern key and none for an exact key, no trailing `/` (Vite's
 * resolver appends the rest to a folder value), no `?` / `#` (a query the loader would strip;
 * Codex review r3) — kept inside the package directory.
 */
function resolveSubpathImport(from: string, spec: string, files: Files): Resolution {
  const pkg = nearestFile(dirOf(from), 'package.json', files);
  if (pkg === null) return unresolved('no package.json above the module');
  if ('why' in pkg) return unresolved(pkg.why);
  const file = pkg.dir === '' ? 'package.json' : `${pkg.dir}/package.json`;
  const json = parseJson(pkg.text);
  if (json === null) return unresolved(`${file} cannot be parsed`);
  const imports = json['imports'];
  if (typeof imports !== 'object' || imports === null || Array.isArray(imports)) {
    return unresolved(`${file} has no imports map`);
  }
  const hit = matchKey(Object.keys(imports), spec);
  if (hit === null) return unresolved(`${file} maps no imports entry to ${spec}`);
  if (hit === 'ambiguous') return unresolved(`${file} cannot decide the imports entry for ${spec}`);
  const value = (imports as Record<string, unknown>)[hit.key];
  if (typeof value !== 'string') return unresolved(`${file} imports ${hit.key} is conditional`);
  const stars = value.split('*').length - 1;
  if (
    !value.startsWith('./') ||
    value.endsWith('/') ||
    /[?#]/.test(value) ||
    stars !== (hit.key.includes('*') ? 1 : 0)
  ) {
    return unresolved(`${file} imports ${hit.key} is not a plain ./ path`);
  }
  const target = joinPath(pkg.dir, value.replace('*', hit.star));
  if (target === null || (pkg.dir !== '' && !target.startsWith(`${pkg.dir}/`))) {
    return unresolved(`${file} imports ${hit.key} leaves the package`);
  }
  return resolveModuleFile(target, files);
}

/**
 * The repository file an import specifier names, seen from the module at `from` (CT-06w): `./`
 * and `../` against the module's directory (resolveModuleFile); `#…` through the nearest
 * package.json `imports` (a string entry, one `*`; the query and fragment after the first `#`
 * dropped). A bare specifier is a package: Vitest resolves it through node_modules, not through
 * tsconfig `paths` (`resolve.tsconfigPaths` is off here), so it stays unresolved — as does a
 * conditional entry, a config that cannot be parsed, a directory, a symbolic link, an ambiguous
 * or missing file.
 */
export function resolveImport(from: string, spec: string, files: Files): Resolution {
  const clean = spec.startsWith('#')
    ? `#${spec.slice(1).replace(/[?#].*$/, '')}`
    : spec.replace(/[?#].*$/, '');
  if (clean === '.' || clean === '..' || clean.startsWith('./') || clean.startsWith('../')) {
    const target = resolveRelative(from, clean);
    return target === null
      ? unresolved('it leaves the repository')
      : resolveModuleFile(target, files);
  }
  if (clean.startsWith('#')) return resolveSubpathImport(from, clean, files);
  return unresolved('a package (a bare specifier; tsconfig paths are not used by Vitest here)');
}

/**
 * The modules a rule-test file loads, itself first, at the head: every string literal of a module
 * that resolves through a relative specifier (./, ../) to a code file `read` finds is followed
 * (imports, re-exports, dynamic imports, vi.mock paths, new URL(…) of a module), and so is every
 * import that resolves through `#…` (CT-06w), as long as `follow` accepts its path (the caller
 * keeps the walk to test code: implementation modules do not read test-support files). `read`
 * returns null for a file that does not exist; `kindOf` says what a path is (PathKind; without
 * it, a path `read` finds is a file and any other is absent).
 */
export function relativeClosure(
  file: string,
  read: Reader,
  follow: (path: string) => boolean,
  kindOf?: (path: string) => PathKind,
): Module[] {
  const cache = new Map<string, string | null>();
  const cached: Reader = (p) => {
    let text = cache.get(p);
    if (text === undefined) {
      text = read(p);
      cache.set(p, text);
    }
    return text;
  };
  const kinds = new Map<string, PathKind>();
  const files: Files = {
    read: cached,
    kind: (p) => {
      let k = kinds.get(p);
      if (k === undefined) {
        k = kindOf === undefined ? (cached(p) !== null ? 'file' : 'absent') : kindOf(p);
        kinds.set(p, k);
      }
      return k;
    },
  };
  const out: Module[] = [];
  const seen = new Set<string>();
  const queue = [file];
  const enqueue = (c: string): void => {
    if (CODE_FILE.test(c) && !seen.has(c) && follow(c) && cached(c) !== null) queue.push(c);
  };
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = cached(path);
    if (text === null) continue;
    let tokens: Token[] | null;
    try {
      tokens = tokenize(text);
    } catch {
      tokens = null; // mayReadSupport: a module that cannot be read may read anything
    }
    const literals = tokens === null ? null : literalsOf(tokens);
    const listed =
      tokens === null ? { dirs: [], unresolved: null } : listedDirectories(tokens, path);
    const imports: ModuleImport[] =
      tokens === null
        ? []
        : importSpecifiers(tokens).map((s) => ({ ...s, ...resolveImport(path, s.spec, files) }));
    const dynamic = tokens === null ? null : (dynamicAccess(tokens) ?? listed.unresolved);
    out.push({
      path,
      text,
      literals,
      dynamic,
      lists: listed.dirs,
      imports,
      opaque:
        tokens === null
          ? 'it cannot be read as code'
          : (dynamic ??
            (listed.dirs.length > 0 ? `it lists ${listed.dirs.join(', ')}` : fileAccess(tokens))),
      mocking: tokens === null ? 'it cannot be read as code' : usesMocking(flatten(tokens)),
      closed: false,
      unjudged:
        tokens === null ? 'it cannot be read as code' : (dynamic ?? fileAccess(tokens, false)),
    });
    for (const { text: s } of literals ?? []) {
      if (!s.startsWith('./') && !s.startsWith('../')) continue;
      const target = resolveRelative(path, s.replace(/[?#].*$/, ''));
      if (target === null) continue;
      for (const c of candidatesOf(target)) enqueue(c);
    }
    for (const i of imports) if (i.resolved !== null) enqueue(i.resolved);
  }
  // Closed modules (a fixpoint: a module importing a module that is not closed is not closed).
  const byPath = new Map(out.map((m) => [m.path, m]));
  // A package that keeps a module closed (Codex reviews r5, r8): a bare name that is a known pure
  // package (KNOWN_PACKAGES: no file read or code load on the caller's behalf — a package such as
  // prettier's resolveConfig reads files, so an unknown package keeps the module open) or a
  // capability module whose use fileAccess judges (`node:fs` …). A workspace package of this
  // repository (`@couli/*` — test code the closure does not follow, e.g. packages/testing), an
  // absolute path, a URL or anything else is a load the rules here do not follow.
  const bare = (spec: string): boolean => {
    const clean = spec.replace(/[?#].*$/, '');
    if (clean.startsWith('@couli/')) return false;
    if (!/^(node:)?(@[\w-][\w.-]*\/)?[\w-][\w.-]*(\/[\w.-]+)*$/.test(clean)) return false;
    return knownPackage(clean) || capabilityModule(clean) !== null;
  };
  // An import that is neither a package nor resolved to a module of the closure or to code outside
  // the test code, and why (null when there is none).
  const openImport = (m: Module): string | null => {
    const open = m.imports.find((i) =>
      i.resolved === null ? !bare(i.spec) : !byPath.has(i.resolved) && follow(i.resolved),
    );
    if (open === undefined) return null;
    if (open.resolved !== null) return `it imports ${open.resolved}, which is not read here`;
    return open.spec.startsWith('@couli/')
      ? `it imports ${open.spec}, a workspace package not read here`
      : /^(node:)?(@[\w-][\w.-]*\/)?[\w-][\w.-]*(\/[\w.-]+)*$/.test(
            open.spec.replace(/[?#].*$/, ''),
          )
        ? `it imports ${open.spec}, a package not known to read no files`
        : `it imports ${open.spec}, which cannot be resolved`;
  };
  for (const m of out) {
    if (m.opaque !== null) continue;
    const open = openImport(m);
    if (open === null) m.closed = true;
    else m.opaque = open;
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const m of out) {
      if (!m.closed) continue;
      const open = m.imports.find((i) => {
        const dep = i.resolved === null ? undefined : byPath.get(i.resolved);
        return dep !== undefined && !dep.closed;
      });
      if (open !== undefined) {
        m.closed = false;
        m.opaque = `it imports ${open.resolved}, which is not closed`;
        changed = true;
      }
    }
  }
  // What no rule here judges, not even on a module's own text (CT-06w r6; mayReadSupport looks at
  // it for the rule-test file only): none for a closed module; otherwise its own ways (set by the
  // walk), else an open import, else an import of a module that is not closed.
  for (const m of out) {
    if (m.closed) {
      m.unjudged = null;
      continue;
    }
    if (m.unjudged !== null) continue;
    const dep = m.imports.find((i) => {
      const d = i.resolved === null ? undefined : byPath.get(i.resolved);
      return d !== undefined && !d.closed;
    });
    m.unjudged =
      openImport(m) ??
      (dep === undefined ? null : `it imports ${dep.resolved}, which is not closed`);
  }
  return out;
}

/**
 * CT-06zzz (D10-586): why a rule-test file may read another rule-test file the same task changed,
 * or null. A sibling rule-test file is not a helper, fixture or data file: it is judged on its own
 * (it is in the expected list). So only an explicit import counts: the sibling is one of the
 * modules the file loads, or one of them has an import specifier resolved to it, or one of them
 * cannot be tokenized (its imports cannot be read). The conservative
 * paths of mayReadSupport (a closure that is not closed, unresolved imports, the name rules, loading
 * by a computed name) do not apply; they stay as they are for every other support file.
 */
export function mayImportRuleTest(sibling: string, closure: readonly Module[]): string | null {
  if (closure.some((m) => m.path === sibling)) return `it loads ${sibling}`;
  for (const m of closure) {
    const imported = m.imports.find((i) => i.resolved === sibling);
    if (imported !== undefined) return `${m.path} imports ${sibling} (${imported.spec})`;
    // A module that cannot be tokenized has no readable imports: it may import the sibling.
    if (m.literals === null) return `${m.path} cannot be tokenized`;
  }
  return null;
}

/**
 * Why a rule-test file may read a test-support file the task changed (a helper, fixture or data
 * file inside its test_paths), or null when it cannot (CT-06p; conservative: the file is then
 * judged as a whole). `closure` is the file and the modules it loads (relativeClosure). It may
 * when: the support file is one of those modules; one of them imports it (CT-06w: an import
 * specifier resolved to the support file's repository path); its file name occurs anywhere in
 * their text; its name without the extension occurs as a word in their string literals — except
 * inside an import specifier that resolves to another, closed module of the closure while every
 * module the file loads is closed and the file itself has no `unjudged` way to files (CT-06w,
 * after B1-12g: `./kit.ts` of test/spec/platform/events is not
 * test/spec/identity/step-up-verify/kit.ts; a specifier that cannot be resolved, or resolved to a
 * file the closure does not follow or to a module that is not closed, and every specifier of a
 * closure with a module that is not closed, still counts, the reason says `unresolved import`);
 * one of them lists a
 * directory that holds the support file (CT-06r: readdir & co. resolved statically; a listing
 * whose directory cannot be resolved counts as reading anything, the reason says so) or loads by
 * a computed name (glob, require, a dynamic import of a computed specifier) or cannot be
 * tokenized; or the support file is named after the rule-test file (a snapshot or screenshot:
 * CT-06r, after B1-12g, only below the rule-test file's own directory — `__snapshots__/x.test.ts.snap`,
 * `__screenshots__/x.test.ts/…` — a same-named file in another directory is another test).
 */
export function mayReadSupport(
  file: string,
  support: string,
  closure: readonly Module[],
): string | null {
  const name = baseName(support);
  const own = baseName(file);
  const dir = dirOf(file);
  const below =
    dir === '' ? support : support.startsWith(`${dir}/`) ? support.slice(dir.length + 1) : null;
  if (below !== null && (below.split('/').includes(own) || name.startsWith(`${own}.`))) {
    return `${support} is named after it (a snapshot or screenshot file)`;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const word = new RegExp(`(?<![\\w$.-])${escapeRegex(stem)}(?![\\w$-])`, 'u');
  const byPath = new Map(closure.map((m) => [m.path, m]));
  if (byPath.has(support)) return `it loads ${support}`;
  // CT-06w r6 (orchestrator ruling of 2026-10-19): the exemption holds only for a closure of closed
  // modules. Any module the rule-test file loads that is not closed — or a way of the rule-test
  // file itself to reach files that no rule here judges, not even on its own text (`unjudged`:
  // execution, a mock, a dynamic or template load, an open import) — disables it for every
  // specifier of the closure: the name rules then apply exactly as before CT-06w.
  const loaded = closure.find((m) => m.path !== file && !m.closed);
  const self = closure.find((m) => m.path === file && m.unjudged !== null);
  const blocked =
    loaded !== undefined
      ? `${loaded.path} is not closed: ${loaded.opaque}`
      : self !== undefined
        ? `${file} is not closed: ${self.unjudged}`
        : null;
  for (const m of closure) {
    const imported = m.imports.find((i) => i.resolved === support);
    if (imported !== undefined) return `${m.path} imports ${support} (${imported.spec})`;
    // CT-06w: the name rules skip an import specifier that resolves to another, closed module of
    // the closure (read here, every read of it and of what it imports seen by these rules); a
    // specifier that cannot be resolved, that resolves to a file the closure does not follow
    // (data, a style sheet, a module outside the test code) or to a module that is not closed
    // (it uses a file-system API, import.meta, a mock, a listing, an import not read here — it
    // may reach the support file in a way not seen; Codex reviews r3, r4) counts as before
    // (`unresolved import`), and so does every specifier while the closure is blocked (above).
    const within = (start: number, end: number): ModuleImport | undefined =>
      m.imports.find((i) => i.start <= start && end <= i.end);
    const uncertain = (i: ModuleImport): string | null => {
      if (m.mocking !== null) return `${m.path} mocks modules (${m.mocking})`;
      if (i.resolved === null) return i.why;
      const dep = byPath.get(i.resolved);
      if (dep === undefined) return `${i.resolved} is not followed by the closure`;
      return dep.closed ? blocked : `${i.resolved} is not closed: ${dep.opaque}`;
    };
    const note = (what: string, i: ModuleImport, why: string): string =>
      `${m.path} names ${what} in an unresolved import ${i.spec} (${why})`;
    for (let at = m.text.indexOf(name); at >= 0; at = m.text.indexOf(name, at + 1)) {
      const i = within(at, at + name.length);
      if (i === undefined) return `${m.path} names ${name}`;
      const why = uncertain(i);
      if (why !== null) return note(name, i, why);
    }
    if (m.literals === null) return `${m.path} cannot be read as code, so it may read ${support}`;
    for (const l of m.literals) {
      if (!word.test(l.text)) continue;
      const i = within(l.start, l.end);
      if (i === undefined) return `${m.path} names ${stem}`;
      const why = uncertain(i);
      if (why !== null) return note(stem, i, why);
    }
    // The repository root is '' and holds every path (Codex review r2, S2).
    const listed = m.lists.find((d) => d === '' || support === d || support.startsWith(`${d}/`));
    if (listed !== undefined) return `${m.path} lists ${listed}, which holds ${support}`;
    if (m.dynamic !== null) return `${m.path} may read ${support}: ${m.dynamic}`;
  }
  return null;
}
