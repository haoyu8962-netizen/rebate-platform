// B1-01zzo brief B.3: in infra/monitoring/rules/couli.yaml the Redis write refusal alert reads
// increase(...[10m]) instead of [5m] (one scrape gap no longer hides a short refusal), still
// compares with > 0 and holds for 5m; every other rule of the file stays exactly as B1-01zzh wrote
// it. Expressions are compared with whitespace collapsed. Parsed with the repository's strict YAML
// subset reader (tools/lib/yaml-lite).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { ROOT } from '../metrics/kit.ts';

const RULES = new URL('infra/monitoring/rules/couli.yaml', ROOT);

interface Rule {
  readonly group: string;
  readonly alert: string;
  readonly expr: string;
  readonly for: string;
  readonly labels: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<Record<string, unknown>>;
}

/** The refusal rule after this task. */
const REFUSAL = {
  group: 'couli-redis',
  alert: 'CouliRedisWritesRejected',
  expr: 'sum by (instance) (increase(redis_errors_total{err=~"OOM|MISCONF|READONLY"}[10m])) > 0',
  for: '5m',
  labels: { severity: 'critical' },
} as const;

/** Every rule of the file in order, as B1-01zzh wrote them, the refusal rule as above. */
const EXPECTED = [
  {
    group: 'couli-queue',
    alert: 'CouliQueueFailedJobs',
    expr: 'couli_queue_failed_jobs > 0',
    for: '5m',
    labels: { severity: 'warning' },
  },
  {
    group: 'couli-queue',
    alert: 'CouliQueueDeadLetters',
    expr: 'couli_queue_dead_letters > 0',
    for: '5m',
    labels: { severity: 'critical' },
  },
  {
    group: 'couli-queue',
    alert: 'CouliEvtOldestDueCreatedJob',
    expr: 'couli_evt_oldest_due_created_age_seconds > 60',
    for: '1m',
    labels: { severity: 'warning' },
  },
  {
    group: 'couli-sync',
    alert: 'CouliSyncWatermarkLag',
    expr: 'couli_sync_watermark_lag_seconds > 1800',
    for: '5m',
    labels: { severity: 'warning' },
  },
  {
    group: 'couli-redis',
    alert: 'CouliRedisDown',
    expr: 'redis_up == 0',
    for: '5m',
    labels: { severity: 'critical' },
  },
  {
    group: 'couli-redis',
    alert: 'CouliRedisMemoryHigh',
    expr: 'redis_memory_used_bytes / redis_memory_max_bytes > 0.7',
    for: '5m',
    labels: { severity: 'warning' },
  },
  REFUSAL,
] as const;

function record(value: unknown, where: string): Record<string, unknown> {
  expect(value, `${where} is a mapping`).toEqual(expect.any(Object));
  expect(Array.isArray(value), `${where} is a mapping`).toBe(false);
  return value as Record<string, unknown>;
}

function collapse(expr: string): string {
  return expr.replace(/\s+/g, ' ').trim();
}

function rules(): Rule[] {
  expect(existsSync(RULES), 'infra/monitoring/rules/couli.yaml exists').toBe(true);
  const doc = record(parseYamlLite(readFileSync(RULES, 'utf8')), 'document');
  expect(Array.isArray(doc['groups']), 'groups is a list').toBe(true);
  const out: Rule[] = [];
  (doc['groups'] as unknown[]).forEach((value, g) => {
    const group = record(value, `groups[${g}]`);
    expect(group['name'], `groups[${g}].name`).toEqual(expect.any(String));
    expect(Array.isArray(group['rules']), `groups[${g}].rules is a list`).toBe(true);
    (group['rules'] as unknown[]).forEach((item, r) => {
      const where = `groups[${g}].rules[${r}]`;
      const rule = record(item, where);
      expect(rule['alert'], `${where}.alert`).toEqual(expect.any(String));
      expect(rule['expr'], `${where}.expr`).toEqual(expect.any(String));
      expect(rule['for'], `${where}.for`).toEqual(expect.any(String));
      out.push({
        group: group['name'] as string,
        alert: rule['alert'] as string,
        expr: collapse(rule['expr'] as string),
        for: rule['for'] as string,
        labels: record(rule['labels'], `${where}.labels`),
        annotations: record(rule['annotations'], `${where}.annotations`),
      });
    });
  });
  return out;
}

it('[AC-B1-01zzo#9] Redis 拒绝写入告警：唯一读 redis_errors_total 的规则，increase 窗口为 [10m]（不再有 [5m]），err 口径不变，> 0，for 5m，severity critical；描述不再写 5 分钟', () => {
  const all = rules();
  const refusal = all.filter((rule) => /\bredis_errors_total\b/.test(rule.expr));
  expect(
    refusal.map((rule) => rule.alert),
    'exactly one rule reads redis_errors_total',
  ).toEqual([REFUSAL.alert]);
  const rule = refusal[0]!;
  // Every range selector of the expression is the 10-minute window.
  expect(rule.expr.match(/\[[^\]]*\]/g), 'range windows').toEqual(['[10m]']);
  expect(rule.expr).toMatch(
    /\bincrease\(\s*redis_errors_total\{\s*err\s*=~\s*"OOM\|MISCONF\|READONLY"\s*\}\[10m\]\s*\)/,
  );
  expect(rule.expr).toMatch(/(^|[^<>=!])>\s*0$/);
  expect(rule.expr).toBe(REFUSAL.expr);
  expect(rule.for).toBe('5m');
  expect(rule.labels).toEqual(REFUSAL.labels);
  expect(rule.group).toBe(REFUSAL.group);
  expect(rule.annotations['summary']).toEqual(expect.any(String));
  // The description states the window; it must not keep the old 5 minutes.
  const description = rule.annotations['description'];
  expect(description, 'description').toEqual(expect.any(String));
  expect(description as string).not.toMatch(/\b5\s*(m\b|min|minute)/i);
});

it('[AC-B1-01zzo#10] couli.yaml 其余规则不变：分组、顺序、alert 名、表达式、for 与标签与 B1-01zzh 一致，只有拒绝写入一条的窗口变成 [10m]', () => {
  const all = rules();
  expect([...new Set(all.map((rule) => rule.group))]).toEqual([
    'couli-queue',
    'couli-sync',
    'couli-redis',
    'couli-union',
  ]);
  // B1-04zy adds the Taobao search fallback alert in a group of its own, after the others. Its
  // window, threshold and hold are not this file's: [AC-B1-04zy#58] pins the expression's shape.
  const fallbackAlert = {
    group: 'couli-union',
    alert: 'CouliTaobaoSearchFallbackHigh',
    expr: expect.stringContaining('couli_taobao_search_total'),
    for: expect.stringMatching(/^[1-9][0-9]*[smh]$/),
    labels: { severity: 'warning' },
  };
  expect(
    all.map(({ group, alert, expr, for: holdFor, labels }) => ({
      group,
      alert,
      expr,
      for: holdFor,
      labels,
    })),
  ).toEqual([...EXPECTED, fallbackAlert]);
  for (const rule of all) {
    const summary = rule.annotations['summary'];
    expect(summary, `${rule.alert}.annotations.summary`).toEqual(expect.any(String));
    expect((summary as string).trim().length, `${rule.alert} summary`).toBeGreaterThan(0);
  }
});
