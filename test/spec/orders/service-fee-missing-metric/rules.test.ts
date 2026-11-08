// B1-08zy（FU-TB-FEE-MISSING-METRIC，编排 D10-741 ⑤、D10-992 ①选 (a)）：infra/monitoring/rules/couli.yaml 加一条
// 按 platform 分组读 couli_service_fee_missing_total 的告警 CouliServiceFeeMissing（for、severity 照旧告警：5m、
// warning，不带 fund 标签），旧的 CouliPddServiceFeeMissing 原样保留（暂留双写，另记 FU-PDD-FEE-METRIC-RETIRE）。
// 计数器只经 increase() 读，窗口照旧 [1h]。YAML 用仓库的严格子集读取器（tools/lib/yaml-lite）。
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

const RULES = new URL('../../../../infra/monitoring/rules/couli.yaml', import.meta.url);
const METRIC = 'couli_service_fee_missing_total';
const OLD_METRIC = 'couli_pdd_service_fee_missing_total';

interface Rule {
  readonly group: string;
  readonly alert: string;
  readonly expr: string;
  readonly for: unknown;
  readonly labels: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<Record<string, unknown>>;
}

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
    expect(Array.isArray(group['rules']), `groups[${g}].rules is a list`).toBe(true);
    (group['rules'] as unknown[]).forEach((item, r) => {
      const where = `groups[${g}].rules[${r}]`;
      const rule = record(item, where);
      expect(rule['alert'], `${where}.alert`).toEqual(expect.any(String));
      expect(rule['expr'], `${where}.expr`).toEqual(expect.any(String));
      out.push({
        group: String(group['name']),
        alert: rule['alert'] as string,
        expr: collapse(rule['expr'] as string),
        for: rule['for'],
        labels: record(rule['labels'], `${where}.labels`),
        annotations: record(rule['annotations'], `${where}.annotations`),
      });
    });
  });
  return out;
}

/** 读 `metric`（整词）的规则。 */
function reading(all: readonly Rule[], metric: string): Rule[] {
  return all.filter((rule) => new RegExp(`\\b${metric}\\b`).test(rule.expr));
}

it('[AC-B1-08zy#7] couli.yaml 有且只有一条读 couli_service_fee_missing_total 的告警 CouliServiceFeeMissing：sum by (platform) 分组、increase(...[1h]) > 0，for 5m，warning，不带 fund 标签，summary 写出平台', () => {
  const found = reading(rules(), METRIC);
  expect(
    found.map((rule) => rule.alert),
    `exactly one rule reads ${METRIC}`,
  ).toEqual(['CouliServiceFeeMissing']);
  const rule = found[0]!;
  // 计数器只经 increase() 读、窗口 [1h]，按 platform 聚合，严格大于 0。
  expect(rule.expr).toContain(`increase(${METRIC}[1h])`);
  expect(rule.expr.match(/\[[^\]]*\]/g), 'range windows').toEqual(['[1h]']);
  expect(rule.expr).toMatch(/^sum\b/);
  expect(rule.expr).toMatch(/\bby\s*\(\s*platform\s*\)/);
  expect(rule.expr).not.toMatch(/\bwithout\s*\(/);
  expect(rule.expr).toMatch(/(^|[^<>=!])>\s*0$/);
  // 不读旧计数器：两条告警各读各的。
  expect(rule.expr).not.toContain(OLD_METRIC);
  expect(rule.for).toBe('5m');
  expect(rule.labels['severity']).toBe('warning');
  expect(rule.labels['fund']).toBeUndefined();
  const summary = rule.annotations['summary'];
  expect(summary).toEqual(expect.any(String));
  expect(summary as string).toMatch(/\$labels\.platform\b/);
});

it('[AC-B1-08zy#8] 旧告警暂留：CouliPddServiceFeeMissing 仍是唯一读 couli_pdd_service_fee_missing_total 的规则，表达式、for、severity 不变；告警名不重复', () => {
  const all = rules();
  // 新告警先得在（否则这条在骨架上什么也没证明）。
  expect(all.map((rule) => rule.alert)).toContain('CouliServiceFeeMissing');
  const old = reading(all, OLD_METRIC);
  expect(old.map((rule) => rule.alert)).toEqual(['CouliPddServiceFeeMissing']);
  expect(old[0]!.expr).toBe(`increase(${OLD_METRIC}[1h]) > 0`);
  expect(old[0]!.for).toBe('5m');
  expect(old[0]!.labels['severity']).toBe('warning');
  expect(new Set(all.map((rule) => rule.alert)).size).toBe(all.length);
});
