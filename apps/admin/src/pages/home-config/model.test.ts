import { expect, it } from 'vitest';
import { homeConfigTexts as t } from '../../texts/home-config.ts';
import {
  beijingTime,
  canRollback,
  checkGrayPercent,
  defaultPageKey,
  errorRate,
  pageUrl,
  parseSections,
  percentOf,
  previewDeepLink,
  summarize,
  type PageConfig,
  type VersionSummary,
} from './model.ts';

function page(patch: Partial<PageConfig> = {}): PageConfig {
  return {
    page_key: 'home',
    current_version: 6,
    gray_version: 7,
    gray_percent: 15,
    revision: 3,
    latest_version: 8,
    updated_by: null,
    updated_at: null,
    ...patch,
  };
}

function version(n: number, status: VersionSummary['status'] = 'published'): VersionSummary {
  return {
    version: n,
    status,
    render_count: 0,
    error_count: 0,
    publish_at: null,
    publisher: null,
    created_by: 'ops',
    created_at: '2026-10-18T02:00:00Z',
  };
}

it('[F1-09l] 灰度比例只收 1–99 的整数，不取整也不转全量', () => {
  expect(checkGrayPercent('1')).toEqual({ ok: true, value: 1 });
  expect(checkGrayPercent('99')).toEqual({ ok: true, value: 99 });
  for (const raw of ['0', '100', '1.5', '-3', 'abc'])
    expect(checkGrayPercent(raw)).toEqual({ ok: false, message: t.validation.percentRange });
  expect(checkGrayPercent('')).toEqual({ ok: false, message: t.validation.percentRequired });
  expect(checkGrayPercent(null)).toEqual({ ok: false, message: t.validation.percentRequired });
});

it('[F1-09l] 本地只校验合法 JSON 与数组', () => {
  expect(parseSections('[{"id":"a"}]')).toEqual({ ok: true, sections: [{ id: 'a' }] });
  expect(parseSections('{oops').ok).toBe(false);
  expect(parseSections('null')).toEqual({ ok: false, message: t.editor.notArray });
  expect(parseSections('{"sections":[]}')).toEqual({ ok: false, message: t.editor.notArray });
});

it('[F1-09l] 区块摘要：type、id 与人群条件，无条件为全部用户', () => {
  const [first, second] = summarize([
    { id: 'hero', type: 'banner' },
    { id: 'grid', type: 'product_grid', condition: { login: 'yes', has_order: 'no' } },
  ]);
  expect(first).toMatchObject({ type: 'banner', id: 'hero', audience: t.blocks.everyone });
  expect(second?.audience).toBe('login=yes · has_order=no');
});

it('[F1-09l] 默认页、路径编码、北京时间', () => {
  expect(defaultPageKey([page({ page_key: 'custom:a' }), page()])).toBe('home');
  expect(defaultPageKey([page({ page_key: 'custom:a' })])).toBe('custom:a');
  expect(defaultPageKey([])).toBe('home');
  expect(pageUrl('custom:a')).toBe('/admin/v1/pages/custom%3Aa');
  expect(beijingTime('2026-10-18T02:40:00Z')).toBe('2026-10-18 10:40');
});

it('[F1-09l] 回滚只对灰度版本，或无灰度时的全量版本；比例来自页详情', () => {
  expect(canRollback(version(7), page())).toBe(true);
  expect(canRollback(version(6), page())).toBe(false);
  expect(canRollback(version(6), page({ gray_version: null, gray_percent: 0 }))).toBe(true);
  expect(canRollback(version(8, 'draft'), page())).toBe(false);
  expect(percentOf(version(7), page())).toBe(15);
  expect(percentOf(version(6), page())).toBe(100);
  expect(percentOf(version(5), page())).toBeNull();
});

it('[AC-F1-09u-RATE#1] errorRate: at most two decimals, half up, trailing zeros dropped; none without renders', () => {
  expect(errorRate(200, 3)).toBe('1.5%');
  expect(errorRate(3, 1)).toBe('33.33%');
  expect(errorRate(3, 2)).toBe('66.67%');
  expect(errorRate(8, 1)).toBe('12.5%');
  expect(errorRate(20000, 1)).toBe('0.01%');
  expect(errorRate(40000, 2)).toBe('0.01%');
  expect(errorRate(40001, 2)).toBe('0%');
  expect(errorRate(4, 4)).toBe('100%');
  expect(errorRate(0, 0)).toBeNull();
  expect(errorRate(0, 2)).toBeNull();
});

it('[AC-F1-09u-QR#1] previewDeepLink: HomePreview route with the query-encoded page key and token', () => {
  const link = previewDeepLink({
    page_key: 'custom:activity_618',
    token: 'pv_a&b',
    version: 3,
    expire_at: '2026-10-18T02:40:00Z',
  });
  expect(link.endsWith('r/HomePreview?page_key=custom%3Aactivity_618&token=pv_a%26b')).toBe(true);
});
