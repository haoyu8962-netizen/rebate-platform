// B2-09j: infra/monitoring/rules/couli-fund.yaml gains the water level alert (BR-WDR-18「W < 1.5P
// 时告警财务」, D10-592). Exactly one rule reads couli_payout_water_low: its expression is the
// comparison `> 0` and nothing else, so each app_id alerts on its own and no sample (no conclusion)
// never fires; for 5m, severity warning (it only warns, payouts go on), labels fund 'true' (a string:
// fund alerts are pushed at night, 规划/02 §13), with a summary and a description. couli.yaml never
// reads it. Rules are found by the metric their expressions read, not by alert name. Parsed with the
// repository's strict YAML subset reader (tools/lib/yaml-lite).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../../tools/lib/yaml-lite.ts';
import { ROOT } from '../kit.ts';
import { WATER_LOW_METRIC } from './water-harness.ts';

const FUND_RULES = new URL('infra/monitoring/rules/couli-fund.yaml', ROOT);
const BASE_RULES = new URL('infra/monitoring/rules/couli.yaml', ROOT);

interface Rule {
  readonly alert: string;
  readonly expr: string;
  readonly for: string;
  readonly labels: Readonly<Record<string, unknown>>;
  readonly summary: unknown;
  readonly description: unknown;
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
  const out: Rule[] = [];
  (doc['groups'] as unknown[]).forEach((value, g) => {
    const group = record(value, `groups[${g}]`);
    expect(Array.isArray(group['rules']), `groups[${g}].rules is a list`).toBe(true);
    (group['rules'] as unknown[]).forEach((item, r) => {
      const where = `groups[${g}].rules[${r}]`;
      const rule = record(item, where);
      expect(rule['alert'], `${where}.alert`).toEqual(expect.any(String));
      expect(rule['expr'], `${where}.expr`).toEqual(expect.any(String));
      expect(rule['for'], `${where}.for`).toEqual(expect.any(String));
      const annotations = record(rule['annotations'], `${where}.annotations`);
      out.push({
        alert: rule['alert'] as string,
        expr: (rule['expr'] as string).trim(),
        for: rule['for'] as string,
        labels: record(rule['labels'], `${where}.labels`),
        summary: annotations['summary'],
        description: annotations['description'],
      });
    });
  });
  return out;
}

/** Every rule whose expression reads `metric` (a whole metric name). */
function readers(all: readonly Rule[], metric: string): Rule[] {
  return all.filter((rule) => new RegExp(`\\b${metric}\\b`).test(rule.expr));
}

/** The one rule of couli-fund.yaml reading the gauge. */
function waterLowRule(): Rule {
  const found = readers(rules(FUND_RULES), WATER_LOW_METRIC);
  expect(
    found.map((rule) => rule.alert),
    `exactly one rule of couli-fund.yaml reads ${WATER_LOW_METRIC}`,
  ).toHaveLength(1);
  return found[0]!;
}

/** Whether `value > 0` holds as Prometheus evaluates the rule. */
function fires(value: number): boolean {
  return value > 0;
}

it('[AC-B2-09j#22] couli-fund.yaml 有且只有一条读 couli_payout_water_low 的规则：expr 就是 couli_payout_water_low > 0、for 5m、severity warning、labels.fund 为字符串 "true"、有 summary 和 description；alert 名在两个文件里唯一', () => {
  const rule = waterLowRule();
  expect(rule.expr, `${rule.alert}.expr`).toBe(`${WATER_LOW_METRIC} > 0`);
  expect(rule.for, `${rule.alert}.for`).toBe('5m');
  expect(rule.labels['severity'], `${rule.alert}.labels.severity`).toBe('warning');
  expect(rule.labels['fund'], `${rule.alert}.labels.fund`).toBe('true');
  expect(rule.alert, 'alert name').toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  for (const [name, text] of [
    ['summary', rule.summary],
    ['description', rule.description],
  ] as const) {
    expect(text, `${rule.alert}.annotations.${name}`).toEqual(expect.any(String));
    expect((text as string).trim().length, `${rule.alert} ${name}`).toBeGreaterThan(0);
  }
  const names = [...rules(FUND_RULES), ...rules(BASE_RULES)].map((r) => r.alert);
  expect(new Set(names).size, 'alert names unique across both files').toBe(names.length);
});

it('[AC-B2-09j#23] 阈值边界：值 0（查过，不低）不触发，值 1 触发（严格大于 0，不是 >= 0、不是 > 1）', () => {
  const rule = waterLowRule();
  const match = new RegExp(`^${WATER_LOW_METRIC}\\s*>\\s*0$`).exec(rule.expr);
  expect(match, `${rule.alert}: expr is ${WATER_LOW_METRIC} > 0, got ${rule.expr}`).not.toBeNull();
  expect(fires(0)).toBe(false);
  expect(fires(1)).toBe(true);
});

it('[AC-B2-09j#24] couli.yaml 不读这个指标（夜间只推资金类）；couli-fund.yaml 里读它的只有这一条的这一处', () => {
  const rule = waterLowRule();
  expect(rule.labels['fund'], rule.alert).toBe('true');
  const named = rules(FUND_RULES).flatMap(
    (r) => r.expr.match(/\bcouli_payout_water_[a-z0-9_]+/g) ?? [],
  );
  expect(named).toEqual([WATER_LOW_METRIC]);
  const base = rules(BASE_RULES).flatMap((r) => r.expr.match(/\bcouli_[a-z0-9_]+/g) ?? []);
  expect(base.filter((name) => name === WATER_LOW_METRIC)).toEqual([]);
});
