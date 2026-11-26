// beforeSend allowlist of crash reporting (QA-13d ⑤; 01 F-OBS-01, 02 §12.6): the outgoing event is
// rebuilt from allowlisted fields only. No request / response body, no headers or cookies, no query
// string; the URL is at most a path template. extra, breadcrumb data and caller contexts keep only
// link_id / platform / step / result, at every depth (a nested object is filtered the same way).
// Free text (exception messages, breadcrumb messages, kept values) loses credentials written into
// it (authorization / cookie header values, Bearer / Basic tokens, token=… pairs), goes through
// redaction.ts's redactText and loses promotion URLs, 口令 and 推广位 ids. The user is at most a
// one-way hash of its id. Exception types, stack frames, level, environment and release stay
// readable.
import { createHash } from 'node:crypto';
import type { Breadcrumb, Event, Exception, StackFrame } from '@sentry/core';
import { REDACTED, redactPath, redactText } from '../logging/redaction.ts';

/** 02 §12.6: extra, breadcrumb data and contexts record only these. */
export const ALLOWED_DATA_KEYS: readonly string[] = Object.freeze([
  'link_id',
  'platform',
  'step',
  'result',
]);

/** Tags that may leave: the entry, where the report came from, the log message, §12.6 keys. */
const ALLOWED_TAG_KEYS: readonly string[] = Object.freeze([
  'entry',
  'source',
  'log_message',
  ...ALLOWED_DATA_KEYS,
]);

const LEVELS = new Set(['fatal', 'error', 'warning', 'log', 'info', 'debug']);
const MAX_DEPTH = 8;
const MAX_TEXT = 8_192;

const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const WWW_TEXT = /\bwww\.[^\s"'<>]+/gi;
const TKL_MARK = '[￥¥$€£₤₳₴₸₹₱₲₵₡₮₭₦¢฿]';
const TKL_TEXT = new RegExp(`${TKL_MARK}\\s*[A-Za-z0-9]{4,32}\\s*${TKL_MARK}`, 'g');
const PID_TEXT = /\bmm_\d+_\d+_\d+\b/g;
// Credentials written into free text (an exception message such as `Authorization: Bearer …`):
// the whole value of an authorization / cookie header (to the line end or closing quote), then a Bearer token or Basic
// credentials standing on their own.
const AUTH_HEADER_TEXT =
  /\b((?:proxy-)?authorization|(?:set-)?cookie|x-api-key|x-auth-token)(["']?\s*[:=]\s*["']?)[^\r\n"'}]+/gi;
const BEARER_TEXT = /\b(Bearer\s+)[\w.~+/=:-]+/gi;
// Basic credentials are base64: a digit, `+` / `/` or mixed case (so `Basic validation` stays).
const BASIC_TEXT =
  /\b(Basic\s+)(?=[A-Za-z0-9+/]*(?:[0-9+/]|[A-Z][A-Za-z0-9+/]*[a-z]|[a-z][A-Za-z0-9+/]*[A-Z]))[A-Za-z0-9+/]{8,}={0,2}/g;

// Credentials written as key=value (`access_token=…`, `api_key=…`, `secret=…`, `token=…`, any case,
// also as the tail of a longer key such as refresh_token): the whole value, up to a blank or `&`.
const TOKEN_PAIR_TEXT = /(?<![A-Za-z0-9])(access_token|api_key|secret|token)=[^\s&]+/gi;
// The same keys written as JSON (`"access_token":"…"`, blanks around the colon, any case, also
// refresh_token / client_secret): the whole quoted value, escaped quotes included. A second form
// covers JSON quoted once more inside a string (`\"token\":\"…\"`).
const TOKEN_JSON_TEXT =
  /(?<![A-Za-z0-9])(access_token|api_key|secret|token)("\s*:\s*")(?:[^"\\]|\\.)*/gi;
const TOKEN_JSON_ESCAPED_TEXT =
  /(?<![A-Za-z0-9])(access_token|api_key|secret|token)(\\"\s*:\s*\\")(?:[^"\\]|\\(?!")[^"])*/gi;

/** Free text: no credential, promotion URL, 口令 or 推广位, then redaction.ts's personal-data net. */
export function scrubText(value: string): string {
  const text = value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
  return redactText(
    text
      .replace(AUTH_HEADER_TEXT, `$1$2${REDACTED}`)
      .replace(BEARER_TEXT, `$1${REDACTED}`)
      .replace(BASIC_TEXT, `$1${REDACTED}`)
      .replace(TOKEN_JSON_TEXT, `$1$2${REDACTED}`)
      .replace(TOKEN_JSON_ESCAPED_TEXT, `$1$2${REDACTED}`)
      .replace(TOKEN_PAIR_TEXT, `$1=${REDACTED}`)
      .replace(URL_TEXT, REDACTED)
      .replace(WWW_TEXT, REDACTED)
      .replace(TKL_TEXT, REDACTED)
      .replace(PID_TEXT, REDACTED),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scrubValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => scrubValue(item, depth + 1)).filter((x) => x !== undefined);
    return items;
  }
  if (isRecord(value)) return filterData(value, depth + 1);
  return undefined;
}

/** Only the allowlisted keys, at every depth; undefined when nothing is left. */
export function filterData(
  value: unknown,
  depth = 0,
  allowed: readonly string[] = ALLOWED_DATA_KEYS,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || depth > MAX_DEPTH) return undefined;
  const kept: Record<string, unknown> = {};
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) continue;
    const item = scrubValue(value[key], depth);
    if (item !== undefined) kept[key] = item;
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}|(?=.*\d)[A-Za-z0-9_-]{16,})$/i;

/**
 * A path template from a route or URL: no scheme, host, query string or fragment; id-like segments
 * become `:id` and any segment with personal data `[REDACTED]`.
 */
export function pathTemplate(value: string): string | undefined {
  let path = value;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path);
  if (scheme !== null) path = path.slice(scheme[0].length);
  path = path.split(/[?#]/)[0] ?? '';
  if (!path.startsWith('/')) return undefined;
  const template = path
    .split('/')
    .map((segment) => (segment.startsWith(':') || !ID_SEGMENT.test(segment) ? segment : ':id'))
    .join('/');
  return redactPath(template).slice(0, 512);
}

/** One-way hash of a user id (never the id or a reversible encoding of it). */
export function hashUserId(id: string): string {
  return createHash('sha256').update(`couli-crash-report-user:${id}`).digest('hex').slice(0, 32);
}

function shortToken(value: unknown, pattern = /^[\w.:-]{1,64}$/): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function scrubFrame(frame: StackFrame): StackFrame {
  const kept: StackFrame = {};
  if (typeof frame.filename === 'string') kept.filename = frame.filename;
  if (typeof frame.abs_path === 'string') kept.abs_path = frame.abs_path;
  if (typeof frame.module === 'string') kept.module = frame.module;
  if (typeof frame.function === 'string') kept.function = frame.function;
  if (typeof frame.lineno === 'number') kept.lineno = frame.lineno;
  if (typeof frame.colno === 'number') kept.colno = frame.colno;
  if (typeof frame.in_app === 'boolean') kept.in_app = frame.in_app;
  return kept;
}

function scrubException(exception: Exception): Exception {
  const kept: Exception = {};
  if (typeof exception.type === 'string') kept.type = scrubText(exception.type).slice(0, 256);
  if (typeof exception.value === 'string') kept.value = scrubText(exception.value);
  const frames = exception.stacktrace?.frames;
  if (Array.isArray(frames)) kept.stacktrace = { frames: frames.map(scrubFrame) };
  const mechanism = exception.mechanism;
  if (mechanism !== undefined) {
    kept.mechanism = { type: shortToken(mechanism.type) ?? 'generic' };
    if (typeof mechanism.handled === 'boolean') kept.mechanism.handled = mechanism.handled;
    if (typeof mechanism.synthetic === 'boolean') kept.mechanism.synthetic = mechanism.synthetic;
    if (typeof mechanism.exception_id === 'number') {
      kept.mechanism.exception_id = mechanism.exception_id;
    }
    if (typeof mechanism.parent_id === 'number') kept.mechanism.parent_id = mechanism.parent_id;
    const source = shortToken(mechanism.source);
    if (source !== undefined) kept.mechanism.source = source;
    if (typeof mechanism.is_exception_group === 'boolean') {
      kept.mechanism.is_exception_group = mechanism.is_exception_group;
    }
  }
  return kept;
}

function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  const kept: Breadcrumb = {};
  const type = shortToken(crumb.type);
  if (type !== undefined) kept.type = type;
  const category = shortToken(crumb.category);
  if (category !== undefined) kept.category = category;
  if (typeof crumb.level === 'string' && LEVELS.has(crumb.level)) kept.level = crumb.level;
  if (typeof crumb.message === 'string') kept.message = scrubText(crumb.message);
  if (typeof crumb.timestamp === 'number') kept.timestamp = crumb.timestamp;
  const data = filterData(crumb.data);
  if (data !== undefined) kept.data = data;
  return kept;
}

function scrubTags(tags: unknown): Record<string, string> | undefined {
  if (!isRecord(tags)) return undefined;
  const kept: Record<string, string> = {};
  for (const key of ALLOWED_TAG_KEYS) {
    const value = tags[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      kept[key] = scrubText(String(value)).slice(0, 200);
    }
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** SDK contexts keep their technical fields; any other context only the §12.6 keys. */
function scrubContexts(contexts: unknown): Event['contexts'] {
  if (!isRecord(contexts)) return undefined;
  const kept: Record<string, Record<string, unknown>> = {};
  for (const [name, context] of Object.entries(contexts)) {
    if (!isRecord(context)) continue;
    let value: Record<string, unknown> | undefined;
    if (name === 'trace') {
      value = {};
      for (const key of ['trace_id', 'span_id', 'parent_span_id']) {
        const id = shortToken(context[key], /^[0-9a-f]{8,64}$/i);
        if (id !== undefined) value[key] = id;
      }
    } else if (name === 'runtime') {
      value = {};
      for (const key of ['name', 'version']) {
        const item = shortToken(context[key], /^[\w.+-]{1,64}$/);
        if (item !== undefined) value[key] = item;
      }
    } else if (name === 'response') {
      const status = context['status_code'];
      value = typeof status === 'number' ? { status_code: status } : {};
    } else {
      value = filterData(context);
    }
    if (value !== undefined && Object.keys(value).length > 0) kept[name] = value;
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

function scrubRequest(request: unknown): Event['request'] {
  if (!isRecord(request)) return undefined;
  const kept: { method?: string; url?: string } = {};
  const method = shortToken(request['method'], /^[A-Za-z]{3,10}$/);
  if (method !== undefined) kept.method = method.toUpperCase();
  const url = typeof request['url'] === 'string' ? pathTemplate(request['url']) : undefined;
  if (url !== undefined) kept.url = url;
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** The beforeSend filter: a new event with allowlisted, scrubbed fields only. */
export function scrubEvent(event: Event): Event {
  const kept: Event = {};
  if (typeof event.event_id === 'string') kept.event_id = event.event_id;
  if (typeof event.timestamp === 'number') kept.timestamp = event.timestamp;
  if (typeof event.level === 'string' && LEVELS.has(event.level)) kept.level = event.level;
  if (typeof event.platform === 'string') kept.platform = event.platform;
  if (typeof event.environment === 'string') kept.environment = event.environment;
  if (typeof event.release === 'string') kept.release = event.release;
  if (typeof event.dist === 'string') kept.dist = event.dist;
  if (event.sdk !== undefined) kept.sdk = event.sdk;
  // Never serialized (removed when the envelope is built); kept for the envelope header.
  if (event.sdkProcessingMetadata !== undefined) {
    kept.sdkProcessingMetadata = event.sdkProcessingMetadata;
  }
  if (typeof event.message === 'string') kept.message = scrubText(event.message);
  if (Array.isArray(event.fingerprint)) {
    kept.fingerprint = event.fingerprint.filter((x) => typeof x === 'string').map(scrubText);
  }
  const values = event.exception?.values;
  if (Array.isArray(values)) kept.exception = { values: values.map(scrubException) };
  const tags = scrubTags(event.tags);
  if (tags !== undefined) kept.tags = tags;
  const extra = filterData(event.extra);
  if (extra !== undefined) kept.extra = extra;
  const contexts = scrubContexts(event.contexts);
  if (contexts !== undefined) kept.contexts = contexts;
  if (Array.isArray(event.breadcrumbs) && event.breadcrumbs.length > 0) {
    kept.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  }
  const request = scrubRequest(event.request);
  if (request !== undefined) kept.request = request;
  const id = event.user?.id;
  if (typeof id === 'string' || typeof id === 'number') {
    kept.user = { id: hashUserId(String(id)) };
  }
  return kept;
}
