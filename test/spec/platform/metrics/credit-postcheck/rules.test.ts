// B2-02v: infra/monitoring/rules/couli-fund.yaml gains the post-credit confirmation alert (BR-FUND-19
// 末句; D10-1038, D10-1180, D10-1185). Exactly one rule reads couli_credit_postcheck_mismatch_open:
// alert CouliCreditPostcheckMismatch, its expression is the comparison `> 0` and nothing else, so each
// app_id alerts on its own; for exactly 1m (BR-FUND-19 alerts within 5 minutes; this one rule only,
// the other fund rules keep 5m); severity critical; labels fund 'true' (a string: fund alerts are
// pushed at night, 规划/02 §13). Its annotations name no person and say what to do: check the diff on
// the admin console; closing the diff releases that user's withdrawal hold. Rules are found by the
// metric their expressions read. Parsed with the repository's strict YAML subset reader
// (tools/lib/yaml-lite).
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../../tools/lib/yaml-lite.ts';
import { ROOT } from '../kit.ts';
import { CREDIT_POSTCHECK_METRIC } from './postcheck-harness.ts';

const FUND_RULES = new URL('infra/monitoring/rules/couli-fund.yaml', ROOT);
const BASE_RULES = new URL('infra/monitoring/rules/couli.yaml', ROOT);
const ALERT = 'CouliCreditPostcheckMismatch';

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
function postcheckRule(): Rule {
  const found = readers(rules(FUND_RULES), CREDIT_POSTCHECK_METRIC);
  expect(
    found.map((rule) => rule.alert),
    `exactly one rule of couli-fund.yaml reads ${CREDIT_POSTCHECK_METRIC}`,
  ).toHaveLength(1);
  return found[0]!;
}

it('[AC-B2-02v#19] couli-fund.yaml 有且只有一条读 couli_credit_postcheck_mismatch_open 的规则：alert CouliCreditPostcheckMismatch、expr 就是 couli_credit_postcheck_mismatch_open > 0（严格大于 0、不加聚合）、severity critical、labels.fund 为字符串 "true"；alert 名在两个文件里唯一', () => {
  const rule = postcheckRule();
  expect(rule.alert, 'alert name').toBe(ALERT);
  expect(rule.expr, `${rule.alert}.expr`).toBe(`${CREDIT_POSTCHECK_METRIC} > 0`);
  expect(rule.labels['severity'], `${rule.alert}.labels.severity`).toBe('critical');
  expect(rule.labels['fund'], `${rule.alert}.labels.fund`).toBe('true');
  const names = [...rules(FUND_RULES), ...rules(BASE_RULES)].map((r) => r.alert);
  expect(new Set(names).size, 'alert names unique across both files').toBe(names.length);
});

it("[AC-B2-02v#20] for 精确为 '1m'（D10-1185，BR-FUND-19 五分钟内告警；[AC-B1-25b#7] 要求 for > 0），只这一条例外：couli-fund.yaml 其余规则仍一律 '5m'", () => {
  const rule = postcheckRule();
  expect(rule.for, `${rule.alert}.for`).toBe('1m');
  const others = rules(FUND_RULES).filter((r) => r.alert !== ALERT);
  expect(others.length).toBeGreaterThan(0);
  expect(others.filter((r) => r.for !== '5m').map((r) => r.alert)).toEqual([]);
});

it('[AC-B2-02v#21] summary / description 非空、不含个人信息（不写用户标识、手机号、收款信息，模板变量只许 $labels.app_id 与 $value），写清处理路径：后台核对差错单，关闭差错单解除该用户的提现冻结', () => {
  const rule = postcheckRule();
  for (const [name, value] of [
    ['summary', rule.summary],
    ['description', rule.description],
  ] as const) {
    expect(value, `${rule.alert}.annotations.${name}`).toEqual(expect.any(String));
    const text = value as string;
    expect(text.trim().length, `${rule.alert} ${name}`).toBeGreaterThan(0);
    expect(text, `${name} names a person`).not.toMatch(
      /user_?id|phone|mobile|payee|openid|手机|姓名|身份证|银行卡号/i,
    );
    expect(text, `${name} carries a phone number`).not.toMatch(/(^|\D)1[3-9]\d{9}(\D|$)/);
    expect(text, `${name} templates another label`).not.toMatch(/\$labels\.(?!app_id\b)/);
  }
  const both = `${rule.summary as string} ${rule.description as string}`;
  for (const [step, pattern] of [
    ['the admin console', /后台|admin|console/i],
    ['the recon diff', /差错单|recon[ _-]?diff/i],
    ['closing it', /关闭|关单|\bclos(e|es|ed|ing)\b/i],
    ['releasing', /解除|releas/i],
    ['the hold', /冻结|\bhold/i],
    ['the withdrawals', /提现|withdraw/i],
  ] as const) {
    expect(both, `the annotations name ${step}`).toMatch(pattern);
  }
});

it('[AC-B2-02v#22] couli.yaml 不读这个指标（夜间只推资金类）；couli-fund.yaml 里读它的只有这一条的这一处', () => {
  const rule = postcheckRule();
  expect(rule.labels['fund'], rule.alert).toBe('true');
  const named = rules(FUND_RULES).flatMap(
    (r) => r.expr.match(new RegExp(`\\b${CREDIT_POSTCHECK_METRIC}\\b`, 'g')) ?? [],
  );
  expect(named).toEqual([CREDIT_POSTCHECK_METRIC]);
  const base = rules(BASE_RULES).flatMap((r) => r.expr.match(/\bcouli_[a-z0-9_]+/g) ?? []);
  expect(base.filter((name) => name === CREDIT_POSTCHECK_METRIC)).toEqual([]);
});
