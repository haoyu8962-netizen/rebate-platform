// B1-04zv：infra/monitoring/rules/couli-fund.yaml 加 CouliOrderRowInvalid，读待处理 open 数里
// reason=ORDER_ROW_INVALID 的序列，资金告警（夜间推送），critical。用仓库的严格 YAML 子集读取器解析。
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

const FUND_RULES = new URL('../../../../infra/monitoring/rules/couli-fund.yaml', import.meta.url);

interface Rule {
  readonly alert?: unknown;
  readonly expr?: unknown;
  readonly for?: unknown;
  readonly labels?: unknown;
  readonly annotations?: { readonly summary?: unknown };
}

function fundRules(): Rule[] {
  const doc = parseYamlLite(readFileSync(FUND_RULES, 'utf8')) as { groups: { rules: Rule[] }[] };
  return doc.groups.flatMap((group) => group.rules);
}

it('[AC-B1-04zv#16] couli-fund.yaml 有 CouliOrderRowInvalid：表达式读 ORDER_ROW_INVALID 序列 > 0，for 5m，critical，fund', () => {
  const found = fundRules().filter((rule) => rule.alert === 'CouliOrderRowInvalid');
  expect(found).toHaveLength(1);
  const rule = found[0]!;
  expect(String(rule.expr).trim()).toBe(
    'couli_order_sync_pending_open{reason="ORDER_ROW_INVALID"} > 0',
  );
  expect(rule.for).toBe('5m');
  expect(rule.labels).toMatchObject({ severity: 'critical', fund: 'true' });
  expect(rule.annotations?.summary).toEqual(expect.stringMatching(/\S/));
});
