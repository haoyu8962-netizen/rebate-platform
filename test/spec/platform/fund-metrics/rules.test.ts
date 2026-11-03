// B1-01zzi brief B.3: infra/monitoring/rules/couli-fund.yaml, a Prometheus rule file next to
// B1-01zzh's couli.yaml (which stays as it is). Every fund rule carries labels fund: "true" (a
// string, for the night routing of fund alerts, 规划/02 §13) and a severity; for is the common 5m.
// Rules are found by the metrics their expressions read, not by alert name. The W6 ratio, repeated
// W6 and the corporate Alipay balance are not written yet (blocked on B2-06a / B2-06fz) and are not
// covered here. Parsed with the repository's strict YAML subset reader (tools/lib/yaml-lite).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { ROOT } from '../metrics/kit.ts';
import { FUND_METRIC_NAMES, PENDING_METRIC, SCALAR_METRICS } from './kit.ts';

const FUND_RULES = new URL('infra/monitoring/rules/couli-fund.yaml', ROOT);
const BASE_RULES = new URL('infra/monitoring/rules/couli.yaml', ROOT);

/** The two auto-payout daily gauges, also worker-exported (B1-01zzp, D10-393 ①(b)). */
const AUTO_PAYOUT_METRIC_NAMES: readonly string[] = [
  'couli_auto_payout_daily_total_fen',
  'couli_auto_payout_daily_cap_fen',
];

/** The review overdue gauge, also worker-exported (B2-05o, D10-475 ②(b)). */
const REVIEW_OVERDUE_METRIC_NAMES: readonly string[] = ['couli_withdrawals_review_overdue'];

interface Rule {
  readonly alert: string;
  readonly expr: string;
  readonly for: string;
  readonly labels: Readonly<Record<string, unknown>>;
  readonly summary: unknown;
}

function record(value: unknown, where: string): Record<string, unknown> {
  expect(value, `${where} is a mapping`).toEqual(expect.any(Object));
  expect(Array.isArray(value), `${where} is a mapping`).toBe(false);
  return value as Record<string, unknown>;
}

function rules(file: URL): Rule[] {
  expect(existsSync(file), `${file.pathname} exists`).toBe(true);
  const doc = record(parseYamlLite(readFileSync(file, 'utf8')), 'document');
  expect(Array.isArray(doc['groups']), 'groups is a list').toBe(true);
  const groups = doc['groups'] as unknown[];
  expect(groups.length).toBeGreaterThan(0);
  const out: Rule[] = [];
  groups.forEach((value, g) => {
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
        alert: rule['alert'] as string,
        expr: (rule['expr'] as string).trim(),
        for: rule['for'] as string,
        labels: record(rule['labels'], `${where}.labels`),
        summary: record(rule['annotations'], `${where}.annotations`)['summary'],
      });
    });
  });
  return out;
}

/** Every rule whose expression reads `metric` (a whole metric name). */
function readers(all: readonly Rule[], metric: string): Rule[] {
  return all.filter((rule) => new RegExp(`\\b${metric}\\b`).test(rule.expr));
}

/** The one rule whose expression reads `metric`. */
function ruleOf(all: readonly Rule[], metric: string): Rule {
  const found = readers(all, metric);
  expect(
    found.map((rule) => rule.alert),
    `exactly one rule reads ${metric}`,
  ).toHaveLength(1);
  return found[0]!;
}

/** The expression ends with `> 0` (strictly greater). */
function expectAboveZero(rule: Rule): void {
  expect(rule.expr, rule.alert).toMatch(/(^|[^<>=!])>\s*0\s*$/);
}

it('[AC-B1-01zzi#4] couli-fund.yaml 结构：每条规则 alert 唯一（也不与 couli.yaml 重名）、有 expr、for、severity（critical / warning）、summary，且 labels.fund 为字符串 "true"；couli.yaml 的规则不带 fund', () => {
  const fund = rules(FUND_RULES);
  expect(fund.length).toBeGreaterThanOrEqual(5);
  const base = rules(BASE_RULES);
  const names = [...fund, ...base].map((rule) => rule.alert);
  expect(new Set(names).size, 'alert names unique across both files').toBe(names.length);
  for (const rule of fund) {
    expect(rule.alert, 'alert name').toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    expect(['critical', 'warning'], `${rule.alert}.labels.severity`).toContain(
      rule.labels['severity'],
    );
    expect(rule.labels['fund'], `${rule.alert}.labels.fund`).toBe('true');
    expect(rule.summary, `${rule.alert}.annotations.summary`).toEqual(expect.any(String));
    expect((rule.summary as string).trim().length, `${rule.alert} summary`).toBeGreaterThan(0);
    expect(rule.for, `${rule.alert}.for`).toBe('5m');
  }
  // Night routing pages only fund alerts: B1-01zzh's queue / sync / Redis rules are not fund.
  for (const rule of base) expect(rule.labels['fund'], rule.alert).toBeUndefined();
});

it('[AC-B1-01zzi#5] 五条资金告警：映射表外状态码（pending open 且 reason="UNMAPPED_STATUS"）、账单生成失败、批次 PARTIAL、受益人 held 满 30 天、打款结果未知需人工，阈值均为 > 0', () => {
  const all = rules(FUND_RULES);

  const unmapped = readers(all, PENDING_METRIC).filter((rule) =>
    /\breason\s*=\s*"UNMAPPED_STATUS"/.test(rule.expr),
  );
  expect(
    unmapped.map((rule) => rule.alert),
    'exactly one rule reads the UNMAPPED_STATUS series',
  ).toHaveLength(1);
  const pending = unmapped[0]!;
  // An exact matcher on the one reason inside the selector of the pending gauge.
  expect(pending.expr).toMatch(
    new RegExp(`${PENDING_METRIC}\\{[^}]*\\breason\\s*=\\s*"UNMAPPED_STATUS"[^}]*\\}`),
  );
  expectAboveZero(pending);

  const scalar = [
    SCALAR_METRICS.billJobsFailed,
    SCALAR_METRICS.partialBatches,
    SCALAR_METRICS.beneficiariesHeldOver30Days,
    SCALAR_METRICS.payingNeedsManual,
  ].map((metric) => ruleOf(all, metric));
  for (const rule of scalar) expectAboveZero(rule);

  expect(new Set([pending, ...scalar].map((rule) => rule.alert)).size).toBe(5);
  for (const rule of [pending, ...scalar]) {
    expect(rule.labels['fund'], rule.alert).toBe('true');
    expect(rule.for, rule.alert).toBe('5m');
  }
});

it('[AC-B1-01zzi#6] couli-fund.yaml 只读 worker 导出的五个资金指标：不读 B1-01zzh 的队列 / 同步指标，也不先写 W6 / 水位等未落地的指标', () => {
  const all = rules(FUND_RULES);
  const named = all.flatMap((rule) => rule.expr.match(/\bcouli_[a-z0-9_]+/g) ?? []);
  expect(named.length).toBeGreaterThanOrEqual(5);
  const allowed = [
    ...FUND_METRIC_NAMES,
    ...AUTO_PAYOUT_METRIC_NAMES,
    ...REVIEW_OVERDUE_METRIC_NAMES,
    'couli_payout_water_low',
  ];
  expect(named.filter((name) => !allowed.includes(name))).toEqual([]);
  for (const metric of FUND_METRIC_NAMES) {
    expect(named, `some rule reads ${metric}`).toContain(metric);
  }
  expect(named, 'some rule reads couli_payout_water_low').toContain('couli_payout_water_low');
  // The fund gauges are read only by the fund file, never by couli.yaml.
  const base = rules(BASE_RULES).flatMap((rule) => rule.expr.match(/\bcouli_[a-z0-9_]+/g) ?? []);
  expect(base.filter((name) => FUND_METRIC_NAMES.includes(name))).toEqual([]);
});
