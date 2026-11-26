import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

const FUND_RULES = new URL('../../../../infra/monitoring/rules/couli-fund.yaml', import.meta.url);
const PENDING_METRIC = 'couli_order_sync_pending_open';

interface Rule {
  readonly alert?: unknown;
  readonly expr?: unknown;
  readonly for?: unknown;
  readonly labels?: unknown;
  readonly annotations?: { readonly summary?: unknown };
}

interface Group {
  readonly name: string;
  readonly rules: readonly Rule[];
}

function expectPendingRule(
  rules: readonly { groupName: string; rule: Rule }[],
  reason: string,
): Rule {
  const selector = new RegExp(
    `\\b${PENDING_METRIC}\\s*\\{\\s*(?:[^}]*,\\s*)?reason\\s*=\\s*"${reason}"\\s*[,}]`,
  );
  const found = rules.filter(
    ({ rule }) => typeof rule.expr === 'string' && selector.test(rule.expr),
  );
  expect(found, `读取 ${reason} 序列的规则应恰好有一条`).toHaveLength(1);
  const { groupName, rule } = found[0]!;
  expect(groupName, `${reason} 的规则组`).toBe('couli-fund-orders');
  expect(rule.expr).toBe(`${PENDING_METRIC}{reason="${reason}"} > 0`);
  return rule;
}

it('[AC-B1-04zzad#1] 淘宝解冻信号有唯一的资金告警，原有两条待处理告警保持同组且表达式不变', () => {
  const doc = parseYamlLite(readFileSync(FUND_RULES, 'utf8')) as { groups: readonly Group[] };
  const rules = doc.groups.flatMap((group) =>
    group.rules.map((rule) => ({ groupName: group.name, rule })),
  );

  const unfreeze = expectPendingRule(rules, 'UNFREEZE_SIGNAL');
  expect(unfreeze.for).toBe('5m');
  expect(unfreeze.labels).toMatchObject({ severity: 'critical', fund: 'true' });
  expect(unfreeze.annotations?.summary).toEqual(expect.stringMatching(/\S/));
  expect(unfreeze.alert).toEqual(expect.stringMatching(/\S/));
  expect(rules.filter(({ rule }) => rule.alert === unfreeze.alert)).toHaveLength(1);

  expectPendingRule(rules, 'UNMAPPED_STATUS');
  expectPendingRule(rules, 'ORDER_ROW_INVALID');
});
