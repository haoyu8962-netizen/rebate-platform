// Pure helpers of the home page configuration page: endpoint paths (/admin/v1/pages*), the local
// check of the JSON text (valid JSON and an array, nothing else: content rules are the server's),
// the read-only block summary, gray percentage input, Beijing time and error classification.
import type { Schema } from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { homeConfigTexts as t } from '../../texts/home-config.ts';

export type PageConfig = Schema<'AdminPageConfig'>;
export type PageVersion = Schema<'AdminPageConfigVersion'>;
export type VersionSummary = Schema<'AdminPageConfigVersionSummary'>;
export type VersionList = Schema<'AdminPageConfigVersionList'>;
export type PageList = Schema<'AdminPageConfigList'>;
export type Section = PageVersion['sections'][number];
export type PreviewToken = Schema<'AdminPagePreviewToken'>;

export const HOME_KEY = 'home';
export const LIST_URL = '/admin/v1/pages';
export const LIST_PAGE_SIZE = 200;
export const VERSIONS_PAGE_SIZE = 20;

export function pageUrl(key: string): string {
  return `${LIST_URL}/${encodeURIComponent(key)}`;
}
export function versionsUrl(key: string): string {
  return `${pageUrl(key)}/versions`;
}
export function versionUrl(key: string, version: number): string {
  return `${versionsUrl(key)}/${version}`;
}
/** Write endpoints by operation; `adjust` is POST …/gray (gray percentage or full release). */
const ACTION_PATHS = {
  publish: '/publish',
  adjust: '/gray',
  rollback: '/rollback',
  preview: '/preview-tokens',
} as const;

export function actionUrl(key: string, action: keyof typeof ACTION_PATHS): string {
  return `${pageUrl(key)}${ACTION_PATHS[action]}`;
}

/** home first when it exists, else the first listed page, else home (not saved yet). */
export function defaultPageKey(pages: readonly PageConfig[]): string {
  if (pages.some((page) => page.page_key === HOME_KEY)) return HOME_KEY;
  return pages[0]?.page_key ?? HOME_KEY;
}

export function pageOptionLabel(key: string): string {
  return t.pageOption(key, Object.hasOwn(t.pageNames, key) ? t.pageNames[key] : undefined);
}

export function sectionsText(sections: readonly Section[]): string {
  return JSON.stringify(sections, null, 2);
}

export type ParsedSections =
  | { readonly ok: true; readonly sections: Section[] }
  | { readonly ok: false; readonly message: string };

/** Local check only: valid JSON and an array. Everything else is decided by the server. */
export function parseSections(text: string): ParsedSections {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return {
      ok: false,
      message: t.editor.invalidJson(cause instanceof Error ? cause.message : String(cause)),
    };
  }
  if (!Array.isArray(value)) return { ok: false, message: t.editor.notArray };
  return { ok: true, sections: value as Section[] };
}

export interface BlockSummary {
  readonly key: string;
  readonly type: string;
  readonly id: string;
  readonly audience: string;
  readonly everyone: boolean;
}

function plain(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? t.dash;
}

/** Read-only summary of each section: type, id and the audience condition as written. */
export function summarize(sections: readonly unknown[]): BlockSummary[] {
  return sections.map((section, index) => {
    const record =
      typeof section === 'object' && section !== null && !Array.isArray(section)
        ? (section as Record<string, unknown>)
        : {};
    const condition = record['condition'];
    const entries =
      typeof condition === 'object' && condition !== null && !Array.isArray(condition)
        ? Object.entries(condition as Record<string, unknown>)
        : [];
    return {
      key: `${index}`,
      type: record['type'] === undefined ? t.dash : plain(record['type']),
      id: record['id'] === undefined ? t.dash : plain(record['id']),
      audience:
        entries.length === 0
          ? t.blocks.everyone
          : entries
              .map(([key, value]) => t.blocks.condition(key, plain(value)))
              .join(t.blocks.separator),
      everyone: entries.length === 0,
    };
  });
}

export type PercentCheck =
  { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string };

/** A gray percentage as typed: an integer 1–99, never rounded or turned into 100. */
export function checkGrayPercent(raw: string | null | undefined): PercentCheck {
  const text = (raw ?? '').trim();
  if (text === '') return { ok: false, message: t.validation.percentRequired };
  if (!/^\d+$/.test(text)) return { ok: false, message: t.validation.percentRange };
  const value = Number(text);
  if (value < 1 || value > 99) return { ok: false, message: t.validation.percentRange };
  return { ok: true, value };
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD HH:mm in Beijing time; unreadable input is shown as is. */
export function beijingTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

export type VersionRole = 'draft' | 'full' | 'graying' | 'replaced' | 'rolledBack';

export function roleOf(version: VersionSummary, page: PageConfig | null): VersionRole {
  if (version.status === 'draft') return 'draft';
  if (version.status === 'rolled_back') return 'rolledBack';
  if (page?.gray_version === version.version) return 'graying';
  if (page?.current_version === version.version) return 'full';
  return 'replaced';
}

/** Gray percentage of a version as the page detail states it: gray → its %, full → 100%. */
export function percentOf(version: VersionSummary, page: PageConfig | null): number | null {
  if (page === null) return null;
  if (page.gray_version === version.version) return page.gray_percent;
  if (page.current_version === version.version) return 100;
  return null;
}

/** Rollback is offered for the gray version, and for the full version only without a gray one. */
export function canRollback(version: VersionSummary, page: PageConfig | null): boolean {
  if (page === null || version.status !== 'published') return false;
  if (page.gray_version === version.version) return true;
  return page.gray_version === null && page.current_version === version.version;
}

/**
 * Whether a failed write may still have been applied: no readable answer (network, parse,
 * non-200 envelope), a server error (5xxxx) or an unexpected throw.
 */
export function writeOutcomeUnknown(cause: unknown): boolean {
  if (!(cause instanceof AdminApiError)) return true;
  if (cause.kind === 'request') return false;
  if (cause.kind !== 'api') return true;
  return cause.code >= 50000;
}

export function codeOf(cause: unknown): number | undefined {
  return cause instanceof AdminApiError ? cause.code : undefined;
}

/** Dotted field paths of a 20001 answer (`data.fields`), as the server sent them. */
export function fieldsOf(cause: unknown): string[] {
  if (!(cause instanceof AdminApiError)) return [];
  const data = cause.data;
  if (typeof data === 'object' && data !== null && 'fields' in data && Array.isArray(data.fields))
    return (data.fields as unknown[]).filter((field): field is string => typeof field === 'string');
  return [];
}

/** The server's own message of an answered refusal; empty for local errors (keys, not copy). */
export function serverMessage(cause: unknown): string {
  return cause instanceof AdminApiError && cause.kind === 'api' ? cause.msg : '';
}

/** HomePreview route of the App (contracts/routes.json): scheme `couli`, no host. */
const HOME_PREVIEW_DEEP_LINK = 'couli://r/HomePreview';

/** Content of the draft preview QR code: the HomePreview deep link with page_key and token only. */
export function previewDeepLink(preview: PreviewToken): string {
  const query = `page_key=${encodeURIComponent(preview.page_key)}&token=${encodeURIComponent(preview.token)}`;
  return `${HOME_PREVIEW_DEEP_LINK}?${query}`;
}

/**
 * error_count / render_count as a percentage, rounded half up to at most two decimals with
 * trailing zeros dropped (3/200 → "1.5%", 1/3 → "33.33%"); null when there are no renders.
 * Integer arithmetic only (BigInt, so large counts cannot lose precision): hundredths of a
 * percent = round(errors × 10000 / renders).
 */
export function errorRate(renders: number, errors: number): string | null {
  if (!Number.isSafeInteger(renders) || !Number.isSafeInteger(errors) || renders <= 0 || errors < 0)
    return null;
  const r = BigInt(renders);
  const hundredths = (BigInt(errors) * 20000n + r) / (r * 2n);
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return t.history.rate(fraction === '' ? whole.toString() : `${whole}.${fraction}`);
}
