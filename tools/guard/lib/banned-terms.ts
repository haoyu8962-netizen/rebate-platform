// Banned terms (规划/11 §5.5): technology names superseded by ADR-0001 must not appear in the
// planning tree at SPEC_REF or in a task brief.
import { matchesAny } from '../../lib/glob.ts';

export type Term = { text: string; wholeWord: boolean; re: RegExp };
export type AllowEntry = { glob: string; re: RegExp };
export type TermHit = { file: string; line: number; term: string; excerpt: string };

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

/** One term per line; `#` starts a comment line; `word:` asks for a whole-word match. */
export function parseTerms(text: string): Term[] {
  const terms: Term[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const wholeWord = line.startsWith('word:');
    const term = (wholeWord ? line.slice('word:'.length) : line).trim();
    if (term === '') throw new Error(`banned-terms.txt: empty term in line "${raw}"`);
    const body = term.split(/\s+/).map(escapeRegExp).join('\\s+');
    const source = wholeWord ? `(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])` : body;
    terms.push({ text: term, wholeWord, re: new RegExp(source, 'i') });
  }
  return terms;
}

/** Lines of `<path glob><TAB><regular expression>`; `#` starts a comment line. */
export function parseAllow(text: string): AllowEntry[] {
  const entries: AllowEntry[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === '' || raw.startsWith('#')) return;
    const tab = raw.indexOf('\t');
    if (tab <= 0 || tab === raw.length - 1) {
      throw new Error(`banned-terms.allow.txt: line ${index + 1} must be "<glob><TAB><regex>"`);
    }
    const source = raw.slice(tab + 1);
    let re: RegExp;
    try {
      re = new RegExp(source, 'u');
    } catch (err) {
      throw new Error(
        `banned-terms.allow.txt: line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    entries.push({ glob: raw.slice(0, tab), re });
  });
  return entries;
}

// A repository path token (task briefs only): a maximal run of characters without whitespace,
// quotes, backticks, brackets or the Chinese punctuation below. It counts when it starts with
// (optionally `./` and) a repository top-level directory and a slash — then only its leading
// ASCII part is the path — or when it is an absolute path with at least two non-empty segments.
const TOKEN = /[^\s`'"()[\]<>，。；：、（）「」]+/g;
const REPO_DIR =
  /^(?:\.\/)?(?:apps|packages|test|tools|db|contracts|specs|ops|docs|infra|config|fixtures|lint|\.github)\//;

type Span = { start: number; end: number };

function asciiPrefixLength(text: string): number {
  let n = 0;
  while (n < text.length && text.charCodeAt(n) < 0x80) n += 1;
  return n;
}

/** Character ranges of the repository path tokens in one line. */
export function repoPathSpans(lineText: string): Span[] {
  const spans: Span[] = [];
  for (const m of lineText.matchAll(TOKEN)) {
    const token = m[0];
    const start = m.index;
    if (token.startsWith('/')) {
      if (token.split('/').filter((part) => part !== '').length >= 2) {
        spans.push({ start, end: start + token.length });
      }
    } else if (REPO_DIR.test(token)) {
      spans.push({ start, end: start + asciiPrefixLength(token) });
    }
  }
  return spans;
}

// An identifier token (task briefs only): a maximal run of ASCII letters, digits and hyphens that
// is all upper case with at least one hyphen, such as a follow-up or task id (FU-B316B-RELAY).
const ID_RUN = /[A-Za-z0-9-]+/g;
const ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;

/** Character ranges of the all-caps hyphenated identifiers in one line. */
export function identifierSpans(lineText: string): Span[] {
  const spans: Span[] = [];
  for (const m of lineText.matchAll(ID_RUN)) {
    if (ID.test(m[0])) spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

export type ScanOptions = {
  /**
   * Task briefs: an occurrence that lies wholly inside a repository path token or an all-caps
   * hyphenated identifier does not count.
   */
  ignoreRepoPaths?: boolean;
};

/** Start of the first occurrence of `term` in the line that counts, or -1 when none does. */
function countedAt(term: Term, lineText: string, spans: readonly Span[] | null): number {
  if (spans === null) return term.re.exec(lineText)?.index ?? 0;
  const all = new RegExp(term.re.source, `${term.re.flags.replace('g', '')}g`);
  for (const m of lineText.matchAll(all)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!spans.some((span) => span.start <= start && end <= span.end)) return start;
  }
  return -1;
}

/**
 * Hits in one text; a hit is dropped when an allow entry matches both the path and the line.
 * With `ignoreRepoPaths`, a term counts on a line only if one of its occurrences there lies
 * (at least partly) outside every repository path token and every all-caps hyphenated
 * identifier; the excerpt centres on that occurrence.
 */
export function scanText(
  file: string,
  content: string,
  terms: readonly Term[],
  allow: readonly AllowEntry[],
  options: ScanOptions = {},
): TermHit[] {
  const hits: TermHit[] = [];
  const applicable = allow.filter((entry) => matchesAny(file, [entry.glob]));
  content.split(/\r?\n/).forEach((lineText, index) => {
    const matched = terms.filter((term) => term.re.test(lineText));
    if (matched.length === 0) return;
    if (applicable.some((entry) => entry.re.test(lineText))) return;
    const spans =
      options.ignoreRepoPaths === true
        ? [...repoPathSpans(lineText), ...identifierSpans(lineText)]
        : null;
    for (const term of matched) {
      const at = countedAt(term, lineText, spans);
      if (at < 0) continue;
      const start = Math.max(0, at - 30);
      hits.push({
        file,
        line: index + 1,
        term: term.text,
        excerpt: lineText.slice(start, at + term.text.length + 30).trim(),
      });
    }
  });
  return hits;
}
