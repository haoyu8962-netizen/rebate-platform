// JSON helper for the bash wrappers in tools/agent (bash cannot escape or parse JSON safely).
//
//   node meta.ts merge --file <json> [--new] [--copy-to <file>]
//                      [--str k=v]... [--num k=v]... [--bool k=true|false]... [--null k]...
//                      [--list k=a,b,c]... [--lines k=<file>]... [--json k=<json text>]...
//       Writes (with --new) or updates a flat JSON object atomically.
//   node meta.ts events [--engine codex|claude-independent] --events <file> [--err <file>]
//                       [--capacity-text]
//       Prints shell-readable facts about a `codex exec --json` event stream:
//       last_type=<type of the last non-empty line | none | invalid>, thread_id=<id or empty>,
//       capacity=<0|1> (model capacity error or Codex usage limit, CODEX_QUOTA, reported by an
//       error / turn.failed event or on stderr). With --capacity-text (codex only) one more line
//       capacity_text=<short printable note, e.g. `usage limit, try again at <time>`, or empty>.
//       claude-independent (ops/approvals.yaml id 36): a `claude -p --output-format stream-json`
//       stream; last_type is result.success / result.error for its final `result` event (else
//       the type of the last line), thread_id the session id, capacity also a usage limit.
//   node meta.ts claude-output --events <file> --out <file>
//       Writes the structured output of the final successful `result` event to <out>; nothing
//       when there is none.
//   node meta.ts edit-rules --globs <glob,glob>...
//       Prints one Claude permission rule `Edit(/<glob>)` per glob, braces expanded.
//   node meta.ts get --file <json> <key>
//       Prints one scalar (empty line when missing or null); `a.b` reads a nested key. An array
//       of scalars is printed comma-separated (empty line when it is empty).
//   node meta.ts emit [--str k=v]... (same value flags as merge)
//       Prints one compact JSON object on stdout.
//
// Exit codes: 0 ok, 2 usage or internal error.
import { existsSync, readFileSync } from 'node:fs';
import { readJsonFile, writeFileAtomic } from '../lib/fsx.ts';
import { expandBraces, splitTopLevelCommas } from '../lib/glob.ts';

export const CAPACITY_TEXT = 'Selected model is at capacity';

/**
 * What Codex reports when the account is out of its usage window (CT-06zzzz, D10-993). Source: the
 * real text of a `codex exec` run on 2026-11-07 (codex-cli 0.154.0), in an `error` and a
 * `turn.failed` event: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
 * to purchase more credits or try again at Nov 15th, 2026 12:25 AM." Mapped to exit 11 like
 * CAPACITY_TEXT, and like it matched only in error / turn.failed events and on stderr, never in
 * ordinary items (file contents). A bare `try again` or `limit` is not enough: other failures
 * (context window, tool errors) say that too.
 */
export const CODEX_QUOTA =
  /you['\u2019]ve hit your usage limit|purchase more credits|usage limit[^\n]*?try again at/i;

/**
 * What a Claude run reports when the model is overloaded or the account is out of its usage
 * window (claude-independent; mapped to exit 11 like Codex's capacity error). Matched only in the
 * final `result` event's error text and on stderr, never in ordinary messages (file contents).
 */
export const CLAUDE_CAPACITY =
  /usage limit|hit your limit|rate limit|rate_limit|overloaded|at capacity|try again (?:at|in)/i;

export type EventFacts = { lastType: string; threadId: string; capacity: boolean };

type JsonObject = Record<string, unknown>;

class UsageError extends Error {}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The message texts of a Codex `error` / `turn.failed` event (the raw line as well). */
function failureTexts(line: string, event: JsonObject): string[] {
  const texts: string[] = [];
  if (typeof event['message'] === 'string') texts.push(event['message']);
  const error = event['error'];
  if (isObject(error) && typeof error['message'] === 'string') texts.push(error['message']);
  texts.push(line);
  return texts;
}

/** Whether one text says the model is at capacity or the Codex usage window is exhausted. */
function isCodexCapacity(text: string): boolean {
  return text.includes(CAPACITY_TEXT) || CODEX_QUOTA.test(text);
}

/** The error / turn.failed message texts and stderr of a Codex run, in that order. */
function codexFailureTexts(eventsText: string, stderrText: string): string[] {
  const texts: string[] = [];
  for (const line of eventsText.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event) || (event['type'] !== 'error' && event['type'] !== 'turn.failed')) {
      continue;
    }
    texts.push(...failureTexts(line, event));
  }
  texts.push(stderrText);
  return texts;
}

/**
 * A short, printable note on the capacity error of a Codex run for the wrapper's log line, or ''
 * when there is none: `usage limit, try again at <time as Codex wrote it>` (the time only when
 * Codex gave one), or `model at capacity`. Read from the same places as eventFacts.
 */
export function codexCapacityText(eventsText: string, stderrText: string): string {
  const texts = codexFailureTexts(eventsText, stderrText);
  for (const text of texts) {
    if (!CODEX_QUOTA.test(text)) continue;
    // The time as Codex wrote it: up to the end of its sentence, at most 80 characters.
    const at = /try again at\s+([^"\\\n]{1,80})/i.exec(text);
    const sentence = (at?.[1] ?? '').split(/\.\s/)[0] ?? '';
    const when = [...sentence]
      .map((ch) => (/\p{Cc}/u.test(ch) ? ' ' : ch))
      .join('')
      .replace(/\s+/g, ' ')
      .replace(/[\s.]+$/, '')
      .trim();
    return when === '' ? 'usage limit' : `usage limit, try again at ${when}`;
  }
  return texts.some((text) => text.includes(CAPACITY_TEXT)) ? 'model at capacity' : '';
}

/** Reads the facts the wrapper needs from a `codex exec --json` event stream. */
export function eventFacts(eventsText: string, stderrText: string): EventFacts {
  let lastType = 'none';
  let threadId = '';
  let capacity = isCodexCapacity(stderrText);
  for (const line of eventsText.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      lastType = 'invalid';
      continue;
    }
    if (!isObject(event) || typeof event['type'] !== 'string') {
      lastType = 'invalid';
      continue;
    }
    lastType = event['type'];
    if (lastType === 'thread.started' && typeof event['thread_id'] === 'string') {
      threadId = event['thread_id'];
    }
    // Only error-type events count: file contents quoted in ordinary items are data.
    if (
      (lastType === 'error' || lastType === 'turn.failed') &&
      failureTexts(line, event).some(isCodexCapacity)
    ) {
      capacity = true;
    }
  }
  return { lastType, threadId: threadId.replace(/[^A-Za-z0-9_-]/g, ''), capacity };
}

/** The final `result` event of a `claude -p --output-format stream-json` stream, if any. */
function claudeResult(eventsText: string): JsonObject | null {
  let result: JsonObject | null = null;
  for (const line of eventsText.split('\n')) {
    if (!line.includes('"result"')) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (isObject(event) && event['type'] === 'result') result = event;
    } catch {
      // A damaged line is no result.
    }
  }
  return result;
}

/**
 * Facts of a Claude event stream (claude-independent, ops/approvals.yaml id 36). Success is a
 * final `result` event with subtype success and is_error false (`result.success`); a later
 * bookkeeping line (`system`) does not change that. Capacity: a rate-limit event that rejected
 * the call, an error result with HTTP 429 / 529 or a usage-limit text, or such a text on stderr.
 */
export function claudeEventFacts(eventsText: string, stderrText: string): EventFacts {
  let lastType = 'none';
  let threadId = '';
  let capacity = CLAUDE_CAPACITY.test(stderrText);
  for (const line of eventsText.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      lastType = 'invalid';
      continue;
    }
    if (!isObject(event) || typeof event['type'] !== 'string') {
      lastType = 'invalid';
      continue;
    }
    lastType = event['type'];
    if (threadId === '' && typeof event['session_id'] === 'string') threadId = event['session_id'];
    const info = event['rate_limit_info'];
    if (lastType === 'rate_limit_event' && isObject(info) && info['status'] === 'rejected') {
      capacity = true;
    }
  }
  const result = claudeResult(eventsText);
  if (result !== null) {
    const ok = result['subtype'] === 'success' && result['is_error'] !== true;
    lastType = ok ? 'result.success' : 'result.error';
    const status = result['api_error_status'];
    const text = typeof result['result'] === 'string' ? result['result'] : '';
    if (!ok && (status === 429 || status === 529 || CLAUDE_CAPACITY.test(text))) capacity = true;
  }
  return { lastType, threadId: threadId.replace(/[^A-Za-z0-9_-]/g, ''), capacity };
}

/** The structured output of the final successful result event, or null. */
export function claudeOutput(eventsText: string): JsonObject | null {
  const result = claudeResult(eventsText);
  if (result === null || result['subtype'] !== 'success' || result['is_error'] === true) {
    return null;
  }
  const output = result['structured_output'];
  return isObject(output) ? output : null;
}

/**
 * Claude permission rules for the paths a test phase may write: `Edit(/<glob>)` (rooted at the
 * working directory; Edit rules cover Write as well), braces expanded because the rule syntax has
 * no alternatives. Globs with `..`, a leading `/` or nothing in them are refused.
 */
export function editRules(globLists: readonly string[]): string[] {
  const rules: string[] = [];
  for (const list of globLists) {
    for (const glob of splitTopLevelCommas(list)) {
      if (glob === '') continue;
      if (glob.startsWith('/') || glob.split('/').includes('..')) {
        throw new UsageError(`edit-rules: not a repository-relative glob: ${glob}`);
      }
      for (const one of expandBraces(glob)) {
        const rule = `Edit(/${one})`;
        if (!rules.includes(rule)) rules.push(rule);
      }
    }
  }
  return rules;
}

function splitPair(flag: string, raw: string | undefined): [string, string] {
  const at = raw === undefined ? -1 : raw.indexOf('=');
  if (raw === undefined || at <= 0) throw new UsageError(`${flag} needs <key>=<value>`);
  return [raw.slice(0, at), raw.slice(at + 1)];
}

/** Applies the value flags shared by `merge` and `emit`; returns the arguments it did not use. */
export function applyValueFlags(target: JsonObject, args: readonly string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i] ?? '';
    const raw = args[i + 1];
    switch (flag) {
      case '--str': {
        const [key, value] = splitPair(flag, raw);
        target[key] = value;
        i += 1;
        break;
      }
      case '--num': {
        const [key, value] = splitPair(flag, raw);
        if (!/^-?\d+$/.test(value)) throw new UsageError(`--num ${key}: not an integer: ${value}`);
        target[key] = Number(value);
        i += 1;
        break;
      }
      case '--bool': {
        const [key, value] = splitPair(flag, raw);
        if (!['true', 'false', '1', '0'].includes(value)) {
          throw new UsageError(`--bool ${key}: expected true|false|1|0, got ${value}`);
        }
        target[key] = value === 'true' || value === '1';
        i += 1;
        break;
      }
      case '--null': {
        if (raw === undefined) throw new UsageError('--null needs <key>');
        target[raw] = null;
        i += 1;
        break;
      }
      case '--list': {
        const [key, value] = splitPair(flag, raw);
        target[key] = value === '' ? [] : value.split(',');
        i += 1;
        break;
      }
      case '--json': {
        const [key, value] = splitPair(flag, raw);
        try {
          target[key] = JSON.parse(value) as unknown;
        } catch {
          target[key] = value;
        }
        i += 1;
        break;
      }
      case '--lines': {
        const [key, file] = splitPair(flag, raw);
        target[key] = existsSync(file)
          ? readFileSync(file, 'utf8')
              .split('\n')
              .filter((line) => line !== '')
          : [];
        i += 1;
        break;
      }
      default:
        rest.push(flag);
    }
  }
  return rest;
}

function takeOption(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined) throw new UsageError(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function takeSwitch(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
}

function requireEmpty(rest: readonly string[]): void {
  if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);
}

function main(argv: readonly string[]): number {
  const [command, ...tail] = argv;
  const args = [...tail];
  if (command === 'merge') {
    const file = takeOption(args, '--file');
    const copyTo = takeOption(args, '--copy-to');
    const fresh = takeSwitch(args, '--new');
    if (file === undefined) throw new UsageError('merge needs --file');
    let doc: JsonObject = {};
    if (!fresh) {
      const current = readJsonFile(file);
      if (!isObject(current)) throw new Error(`${file}: not a JSON object`);
      doc = current;
    }
    requireEmpty(applyValueFlags(doc, args));
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    writeFileAtomic(file, text);
    if (copyTo !== undefined) writeFileAtomic(copyTo, text);
    return 0;
  }
  if (command === 'events') {
    const engine = takeOption(args, '--engine') ?? 'codex';
    const eventsFile = takeOption(args, '--events');
    const errFile = takeOption(args, '--err');
    const withText = takeSwitch(args, '--capacity-text');
    requireEmpty(args);
    if (eventsFile === undefined) throw new UsageError('events needs --events');
    if (engine !== 'codex' && engine !== 'claude-independent') {
      throw new UsageError(`events: unknown engine ${engine}`);
    }
    const read = (file: string | undefined): string =>
      file !== undefined && existsSync(file) ? readFileSync(file, 'utf8') : '';
    const eventsText = read(eventsFile);
    const stderrText = read(errFile);
    const facts = (engine === 'codex' ? eventFacts : claudeEventFacts)(eventsText, stderrText);
    const lastType = /^[A-Za-z0-9._-]+$/.test(facts.lastType) ? facts.lastType : 'invalid';
    process.stdout.write(
      `last_type=${lastType}\nthread_id=${facts.threadId}\ncapacity=${facts.capacity ? 1 : 0}\n`,
    );
    if (withText) {
      const text =
        engine === 'codex' && facts.capacity ? codexCapacityText(eventsText, stderrText) : '';
      process.stdout.write(`capacity_text=${text}\n`);
    }
    return 0;
  }
  if (command === 'claude-output') {
    const eventsFile = takeOption(args, '--events');
    const out = takeOption(args, '--out');
    requireEmpty(args);
    if (eventsFile === undefined || out === undefined) {
      throw new UsageError('claude-output needs --events and --out');
    }
    const output = existsSync(eventsFile) ? claudeOutput(readFileSync(eventsFile, 'utf8')) : null;
    if (output !== null) writeFileAtomic(out, `${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }
  if (command === 'edit-rules') {
    const lists: string[] = [];
    for (let value = takeOption(args, '--globs'); value !== undefined;) {
      lists.push(value);
      value = takeOption(args, '--globs');
    }
    requireEmpty(args);
    for (const rule of editRules(lists)) process.stdout.write(`${rule}\n`);
    return 0;
  }
  if (command === 'get') {
    const file = takeOption(args, '--file');
    const [key, ...extra] = args;
    requireEmpty(extra);
    if (file === undefined || key === undefined) throw new UsageError('get needs --file and <key>');
    let value: unknown = readJsonFile(file);
    for (const part of key.split('.')) value = isObject(value) ? value[part] : undefined;
    const isScalar = (v: unknown): boolean => ['string', 'number', 'boolean'].includes(typeof v);
    let scalar = isScalar(value) ? String(value) : '';
    if (Array.isArray(value) && value.every(isScalar)) scalar = value.map(String).join(',');
    process.stdout.write(`${scalar.replace(/\n/g, ' ')}\n`);
    return 0;
  }
  if (command === 'emit') {
    const doc: JsonObject = {};
    requireEmpty(applyValueFlags(doc, args));
    process.stdout.write(`${JSON.stringify(doc)}\n`);
    return 0;
  }
  throw new UsageError('usage: meta.ts merge|events|claude-output|edit-rules|get|emit ...');
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`meta.ts: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
