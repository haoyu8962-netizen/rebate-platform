// Checks contracts/texts.default.json, the client's bundled default texts (规划/08 BR-TEXT-12
// dictionary fallback; keys and wording from BR-TEXT-14 tables A–D, BR-TEXT-01, BR-TEXT-03 and
// BR-TEXT-22). Run by codegen.ts in both modes, so `pnpm contracts:check` fails on a violation.
//
// Shape: { "version": 1, "texts": { key: text }, "fallbacks": { key: text } }.
//   texts      the default text; {name} placeholders are kept as 08 writes them
//   fallbacks  the text 08 gives for the case where a placeholder of that key has no value
//              (BR-TEXT-14 「包内默认（变量缺失时）」); only for keys whose text has a placeholder
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorCodeDef } from './catalog.ts';
import { contractsDir } from './paths.ts';

export const textsFile = join(contractsDir, 'texts.default.json');

/** Dotted key: a lower-case first segment, then segments that may hold upper-case codes or digits. */
export const TEXT_KEY = /^[a-z][a-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
const PLACEHOLDER = /\{([^{}]*)\}/g;
const PLACEHOLDER_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Codes that BR-TEXT-14 table A marks 「—」 (handled silently, no text): they must have no
 * error.<code> key. Every other code of error-codes.yaml that is neither deprecated nor P1 must
 * have one.
 */
export const SILENT_CODES: readonly number[] = [10002, 10402, 30505, 44003];

/**
 * Codes returned only by /admin/v1 (13 §13.11: 10008, 10009 appear only in the admin login).
 * Their text is admin copy, which stays in apps/admin and not in the app bundle (规划/03 §9,
 * contracts/README「后台文案不进这里」), so they have no error.<code> key here. CT-02f.
 * 30154 and 44004 appear only in the admin user operations (union binding reset / disable /
 * enable, risk-state), CT-02j. 30417 appears only in the admin export tasks (download, retry),
 * CT-24k. 30155 appears only in the admin PID activation (union-pids/{pid_id}/activate), CT-24h.
 * 30156 appears only in the admin manual order sync (POST /admin/v1/order-syncs), CT-24n.
 * 30147 appears only in the admin pool item add and update (product-pools/{pool_id}/items), CT-26zf.
 * 30417 also covers the WeCom-delivered personal information copy download, and 30419 appears
 * only in the admin real-name correction and copy registration (users/{user_id}/...), CT-24q.
 */
export const ADMIN_ONLY_CODES: readonly number[] = [
  10008, 10009, 30147, 30154, 30155, 30156, 30417, 30419, 44004,
];

/**
 * BR-TEXT-14 table B 场景子键 (08 BR-TEXT-14 表 B 表头说明, 规划/08 12_TEXT l.835; rows l.853, l.855,
 * l.875, 2026-10-21 W-15): not a server data.reason but picked by the client on one page, falling
 * back to the key named here when missing. Only these exact keys are let through; every other key
 * must still be error.<code> or error.<code>.<data.reason>. A new scene key needs a row in 08 first.
 */
export const ERROR_SCENE_KEYS: Readonly<Record<string, string>> = {
  'error.30101.auth_unavailable.auth_manage': 'error.30101.auth_unavailable',
  'error.30102.auth_unavailable.auth_manage': 'error.30102.auth_unavailable',
  'error.30151.auth_manage': 'error.30151',
  'error.30411.phone_change': 'error.30411',
};

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Property names of the members of each top-level object, in file order. JSON.parse keeps only
 * the last of duplicated names, so duplicates are found on the text (prettier layout: two-space
 * indent, one member per line).
 */
function memberNames(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of raw.split('\n')) {
    const top = /^ {2}"([^"\\]*)":/.exec(line);
    if (top !== null) {
      current = [];
      out.set(top[1] ?? '', current);
      continue;
    }
    const member = /^ {4}"((?:[^"\\]|\\.)*)":/.exec(line);
    if (member !== null && current !== null) current.push(JSON.parse(`"${member[1]}"`) as string);
  }
  return out;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '');
}

export function checkTexts(codes: readonly ErrorCodeDef[], file: string = textsFile): string[] {
  const where = 'contracts/texts.default.json';
  let raw: string;
  let doc: unknown;
  try {
    raw = readFileSync(file, 'utf8');
    doc = JSON.parse(raw);
  } catch (err) {
    return [`${where}: ${err instanceof Error ? err.message : String(err)}`];
  }
  const problems: string[] = [];
  if (!isObj(doc)) return [`${where}: top level must be an object`];
  const extra = Object.keys(doc).filter((k) => !['version', 'texts', 'fallbacks'].includes(k));
  if (extra.length > 0) problems.push(`${where}: unknown top-level keys ${extra.join(', ')}`);
  if (doc['version'] !== 1) problems.push(`${where}: version must be 1`);
  const texts = doc['texts'];
  const fallbacks = doc['fallbacks'];
  if (!isObj(texts) || Object.keys(texts).length === 0) {
    return [...problems, `${where}: texts must be a non-empty object`];
  }
  if (!isObj(fallbacks)) return [...problems, `${where}: fallbacks must be an object`];

  const names = memberNames(raw);
  for (const section of ['texts', 'fallbacks']) {
    const list = names.get(section) ?? [];
    if (list.length !== Object.keys(section === 'texts' ? texts : fallbacks).length) {
      problems.push(`${where}: ${section}: duplicate key or layout not prettier-formatted`);
    }
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1] ?? '';
      const b = list[i] ?? '';
      if (a === b) problems.push(`${where}: ${section}: duplicate key ${b}`);
      else if (a > b) problems.push(`${where}: ${section}: ${b} is not in alphabetical order`);
    }
  }

  for (const [key, value] of Object.entries(texts)) {
    const at = `${where}: texts.${key}`;
    if (!TEXT_KEY.test(key)) problems.push(`${at}: key does not match ${TEXT_KEY.source}`);
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${at}: must be a non-empty string`);
      continue;
    }
    if (value !== value.trim()) problems.push(`${at}: leading or trailing whitespace`);
    const stripped = value.replace(PLACEHOLDER, '');
    if (stripped.includes('{') || stripped.includes('}')) problems.push(`${at}: unbalanced brace`);
    for (const name of placeholders(value)) {
      if (!PLACEHOLDER_NAME.test(name)) problems.push(`${at}: bad placeholder {${name}}`);
    }
  }

  for (const [key, value] of Object.entries(fallbacks)) {
    const at = `${where}: fallbacks.${key}`;
    const text = texts[key];
    if (typeof text !== 'string') {
      problems.push(`${at}: no such key in texts`);
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${at}: must be a non-empty string`);
      continue;
    }
    if (placeholders(text).length === 0) problems.push(`${at}: texts.${key} has no placeholder`);
    if (/[{}]/.test(value)) problems.push(`${at}: a fallback has no placeholder`);
    if (value === text) problems.push(`${at}: same as texts.${key}`);
  }

  // error.<code>, error.<code>.<reason> and the scene keys against contracts/error-codes.yaml.
  const byCode = new Map(codes.map((c) => [c.code, c]));
  problems.push(...checkErrorKeys(texts, codes, where));
  for (const silent of SILENT_CODES) {
    if (!byCode.has(silent)) problems.push(`${where}: SILENT_CODES: ${silent} is not a code`);
  }
  for (const admin of ADMIN_ONLY_CODES) {
    if (!byCode.has(admin)) problems.push(`${where}: ADMIN_ONLY_CODES: ${admin} is not a code`);
  }
  for (const c of codes) {
    const has = `error.${c.code}` in texts;
    if (SILENT_CODES.includes(c.code)) {
      if (has) problems.push(`${where}: texts.error.${c.code}: code is silent (BR-TEXT-14 「—」)`);
    } else if (ADMIN_ONLY_CODES.includes(c.code)) {
      if (has) problems.push(`${where}: texts.error.${c.code}: admin-only code (规划/03 §9)`);
    } else if (!c.deprecated && c.phase === null && !has) {
      problems.push(`${where}: texts: missing error.${c.code}`);
    }
  }
  return problems;
}

/**
 * The error.* keys of texts: error.<code> or error.<code>.<reason> with a live code and a listed
 * data.reason, or one of ERROR_SCENE_KEYS whose fallback key is present.
 */
export function checkErrorKeys(
  texts: Readonly<Record<string, unknown>>,
  codes: readonly ErrorCodeDef[],
  where = 'contracts/texts.default.json',
): string[] {
  const problems: string[] = [];
  const byCode = new Map(codes.map((c) => [c.code, c]));
  for (const key of Object.keys(texts)) {
    if (!key.startsWith('error.')) continue;
    if (Object.hasOwn(ERROR_SCENE_KEYS, key)) {
      const base = ERROR_SCENE_KEYS[key] ?? '';
      if (!Object.hasOwn(texts, base)) {
        problems.push(`${where}: texts.${key}: scene key without its fallback texts.${base}`);
      }
      continue;
    }
    const m = /^error\.(\d{5})(?:\.([A-Za-z0-9_]+))?$/.exec(key);
    if (m === null) {
      problems.push(`${where}: texts.${key}: error keys are error.<code> or error.<code>.<reason>`);
      continue;
    }
    const code = byCode.get(Number(m[1]));
    if (code === undefined) {
      problems.push(`${where}: texts.${key}: code not in contracts/error-codes.yaml`);
      continue;
    }
    if (code.deprecated) problems.push(`${where}: texts.${key}: code is deprecated`);
    const reason = m[2];
    if (reason !== undefined) {
      const reasons = code.data['reason'];
      if (!Array.isArray(reasons) || !reasons.includes(reason)) {
        problems.push(`${where}: texts.${key}: "${reason}" is not a listed data.reason value`);
      }
    }
  }
  return problems;
}
