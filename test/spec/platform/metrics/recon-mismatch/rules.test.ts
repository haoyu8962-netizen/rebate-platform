import { expect, it } from 'vitest';
import { rules, yaml } from '../../alerting-eval/kit.ts';
import { list, record, string } from '../../../infra/staging/kit.ts';
import { BILL_GENERATED, BILL_MISMATCH, CHANNEL_OPEN, METRICS } from './kit.ts';

function references(rule: Record<string, unknown>, metric: string): boolean {
  return new RegExp(`\\b${metric}\\b`).test(string(rule['expr']));
}

function fundRules() {
  const doc = yaml('infra/monitoring/rules/couli-fund.yaml');
  return list(doc['groups'])
    .map(record)
    .flatMap((group) =>
      list(group['rules'])
        .map(record)
        .map((rule) => ({ group: string(group['name']), rule })),
    );
}

function ruleFor(metric: string) {
  const matches = fundRules().filter(({ rule }) => references(rule, metric));
  expect(matches, `one fund rule reads ${metric}`).toHaveLength(1);
  return matches[0]!;
}

function expectCriticalFundAlert(rule: Record<string, unknown>): string {
  expect(rule['for']).toBe('5m');
  expect(rule['labels']).toMatchObject({ severity: 'critical', fund: 'true' });
  const annotations = record(rule['annotations']);
  expect(string(annotations['summary']).trim()).not.toBe('');
  const description = string(annotations['description']).trim();
  expect(description).not.toBe('');
  return description;
}

it('[AC-B2-09zn#16] 通道差错单只有一条资金告警，在 payout 组，数量大于零持续 5 分钟触发 critical', () => {
  const { group, rule } = ruleFor(CHANNEL_OPEN);
  expect(group).toBe('couli-fund-payout');
  expect(rule['alert']).toBe('CouliPayoutReconDiffOpen');
  expect(string(rule['expr']).replace(/\s+/g, '')).toBe(`${CHANNEL_OPEN}>0`);
  expectCriticalFundAlert(rule);
});

it('[AC-B2-09zn#17] 账单告警在 settlement 组，按 app_id 关联出账时间，出账后 3 天内大于零持续 5 分钟触发 critical', () => {
  const match = ruleFor(BILL_MISMATCH);
  const { group, rule } = match;
  expect(group).toBe('couli-fund-settlement');
  expect(rule['alert']).toBe('CouliSettleBillAmountMismatch');
  const expr = string(rule['expr']);
  expect(expr).toBe(`${BILL_MISMATCH} > 0 and on (app_id) (time() - ${BILL_GENERATED}) < 259200`);
  expect(Number(expr.match(/<\s*(\d+)$/)?.[1])).toBe(3 * 24 * 3600);
  expect(ruleFor(BILL_GENERATED)).toEqual(match);
  expect(expectCriticalFundAlert(rule)).toMatch(/\b3 days\b|\b259200\b/i);
});

it('[AC-B2-09zn#18] 三个指标只由 couli-fund.yaml 的两条规则读取', () => {
  const fund = fundRules();
  const base = rules('couli.yaml');
  expect(base.filter((rule) => METRICS.some((metric) => references(rule, metric)))).toEqual([]);
  expect(
    fund
      .filter(({ rule }) => METRICS.some((metric) => references(rule, metric)))
      .map(({ rule }) => rule['alert'])
      .sort(),
  ).toEqual(['CouliPayoutReconDiffOpen', 'CouliSettleBillAmountMismatch']);
});
