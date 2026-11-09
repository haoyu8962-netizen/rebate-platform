// B2-09zj: infra/monitoring/rules/couli-fund.yaml gains the two payout failure alerts of BR-WDR-24
// (前两项; D10-1157), per app_id:
//   ① the ratio: W6 ÷ (W5 + W6) of the current +08:00 day > 2 %, and the denominator ≥ 20;
//   ② the run: the longest run of consecutive W6 in the W5 / W6 sequence of the last 24 hours
//      (D10-1186) ≥ 3, whatever the day's denominator.
// Each is its own rule (so ② still fires when ① is short of 20, 08 例), for 5m (every fund rule's
// grain, frozen by [AC-B1-01zzi#4]), labels fund 'true' (fund alerts are pushed at night, 规划/02
// §13), a severity, a summary and a description. couli.yaml never reads the three gauges. The same
// change drops the header's outdated TODO about the W6 ratio (blocked on B2-06a).
// Rules are found by the metrics their expressions read. Their expressions are not pinned as text:
// they are evaluated on hand-made gauge values by a small PromQL evaluator (./promql-lite.ts), with
// the expected answers worked out from BR-WDR-24 in integers. Parsed with the repository's strict
// YAML subset reader (tools/lib/yaml-lite).
import { existsSync, readFileSync } from 'node:fs';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../../tools/lib/yaml-lite.ts';
import { ROOT } from '../kit.ts';
import {
  FAIL_METRIC_NAMES,
  W5W6_TODAY_METRIC,
  W6_STREAK_METRIC,
  W6_TODAY_METRIC,
} from './fail-harness.ts';
import { firing, type Series } from './promql-lite.ts';

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

/** The one rule of couli-fund.yaml reading `metric`. */
function onlyReader(metric: string): Rule {
  const found = readers(rules(FUND_RULES), metric);
  expect(
    found.map((rule) => rule.alert),
    `exactly one rule of couli-fund.yaml reads ${metric}`,
  ).toHaveLength(1);
  return found[0]!;
}

/** ① The ratio rule: the one rule reading today's W6 count. */
function ratioRule(): Rule {
  return onlyReader(W6_TODAY_METRIC);
}

/** ② The run rule: the one rule reading the longest W6 run of the last 24 hours. */
function streakRule(): Rule {
  return onlyReader(W6_STREAK_METRIC);
}

/** One app's three gauges; `undefined` leaves that gauge without a sample for the app. */
interface AppValues {
  readonly w6Today?: number;
  readonly w5w6Today?: number;
  readonly w6Streak?: number;
}

/** The series of several apps, each gauge only with the samples given. */
function seriesOf(apps: Readonly<Record<string, AppValues>>): Series {
  const w6: Record<string, number> = {};
  const w5w6: Record<string, number> = {};
  const streak: Record<string, number> = {};
  for (const [app, values] of Object.entries(apps)) {
    if (values.w6Today !== undefined) w6[app] = values.w6Today;
    if (values.w5w6Today !== undefined) w5w6[app] = values.w5w6Today;
    if (values.w6Streak !== undefined) streak[app] = values.w6Streak;
  }
  return { [W6_TODAY_METRIC]: w6, [W5W6_TODAY_METRIC]: w5w6, [W6_STREAK_METRIC]: streak };
}

/** Whether `rule` fires for the one app `a` with these values. */
function firesFor(rule: Rule, values: AppValues): boolean {
  return firing(rule.expr, seriesOf({ a: values })).includes('a');
}

/** BR-WDR-24 ①, in integers: W6 / (W5 + W6) > 2 % ⇔ 50 · W6 > W5 + W6; and W5 + W6 ≥ 20. */
function ratioDue(w6: number, w5w6: number): boolean {
  return w5w6 >= 20 && 50 * w6 > w5w6;
}

it('[AC-B2-09zj#19] couli-fund.yaml 有两条新规则：读当日 W6 数的有且只有一条（比例规则，同时读当日 W5+W6 数），读 24 小时内最长连续 W6 数的有且只有一条（连续规则），两条不是同一条；读这三个指标的规则只有这两条；各自 for 5m、labels.fund 为字符串 "true"、severity 为 critical / warning、有 summary 与 description；alert 名在两个文件里唯一', () => {
  const ratio = ratioRule();
  const streak = streakRule();
  expect(ratio.alert, 'the ratio and the run are two rules').not.toBe(streak.alert);
  expect(ratio.expr, `${ratio.alert} reads ${W5W6_TODAY_METRIC}`).toMatch(
    new RegExp(`\\b${W5W6_TODAY_METRIC}\\b`),
  );
  const all = rules(FUND_RULES);
  const readingAny = all
    .filter((rule) =>
      FAIL_METRIC_NAMES.some((metric) => new RegExp(`\\b${metric}\\b`).test(rule.expr)),
    )
    .map((rule) => rule.alert)
    .sort();
  expect(readingAny, 'rules reading the three gauges').toEqual([ratio.alert, streak.alert].sort());
  for (const rule of [ratio, streak]) {
    expect(rule.alert, 'alert name').toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    expect(rule.for, `${rule.alert}.for`).toBe('5m');
    expect(rule.labels['fund'], `${rule.alert}.labels.fund`).toBe('true');
    expect(['critical', 'warning'], `${rule.alert}.labels.severity`).toContain(
      rule.labels['severity'],
    );
    for (const [name, text] of [
      ['summary', rule.summary],
      ['description', rule.description],
    ] as const) {
      expect(text, `${rule.alert}.annotations.${name}`).toEqual(expect.any(String));
      expect((text as string).trim().length, `${rule.alert} ${name}`).toBeGreaterThan(0);
    }
  }
  const names = [...all, ...rules(BASE_RULES)].map((rule) => rule.alert);
  expect(new Set(names).size, 'alert names unique across both files').toBe(names.length);
});

it('[AC-B2-09zj#20] 比例规则按 08 的例子与边界：30 笔中 1 笔 W6（3.3%）告警；10 笔中 1 笔不告警（分母不足）；分母恰好 20 告警、19 不告警；恰好 2%（50 笔中 1 笔、100 笔中 2 笔）不告警（严格大于）；49 笔中 1 笔、100 笔中 3 笔告警；没有 W6、0/0 不告警', () => {
  const rule = ratioRule();
  const cases: readonly (readonly [number, number, boolean, string])[] = [
    [1, 30, true, '08 例: 1 / 30 = 3.3 % > 2 %, 30 ≥ 20'],
    [1, 10, false, '08 例: 10 < 20, no ratio alert'],
    [1, 20, true, '5 %, denominator exactly 20'],
    [1, 19, false, '5.3 %, but 19 < 20'],
    [1, 50, false, 'exactly 2 %: not above it'],
    [2, 100, false, 'exactly 2 %: not above it'],
    [1, 49, true, '2.04 %'],
    [3, 100, true, '3 %'],
    [0, 30, false, 'no W6'],
    [0, 0, false, 'nothing today (0 / 0)'],
    [20, 20, true, 'every one failed'],
    [19, 19, false, 'every one failed, but 19 < 20'],
  ];
  for (const [w6, w5w6, due, why] of cases) {
    expect(ratioDue(w6, w5w6), `oracle: ${why}`).toBe(due);
    // With the run gauge at 0 and absent: the ratio rule does not lean on it.
    expect(
      firesFor(rule, { w6Today: w6, w5w6Today: w5w6, w6Streak: 0 }),
      `${w6}/${w5w6}: ${why}`,
    ).toBe(due);
    expect(firesFor(rule, { w6Today: w6, w5w6Today: w5w6 }), `${w6}/${w5w6} (no run sample)`).toBe(
      due,
    );
  }
});

it('[AC-B2-09zj#21] 比例规则对任意当日计数（W6 ≤ W5+W6 ≤ 2000）都与「W6 ÷ (W5+W6) > 2% 且分母 ≥ 20」一致（fast-check）；最长连续 W6 的大小不影响比例规则', () => {
  const rule = ratioRule();
  fc.assert(
    fc.property(
      fc
        .integer({ min: 0, max: 2000 })
        .chain((w5w6) =>
          fc.tuple(
            fc.constant(w5w6),
            fc.integer({ min: 0, max: w5w6 }),
            fc.integer({ min: 0, max: 50 }),
          ),
        ),
      ([w5w6, w6, streak]) => {
        expect(
          firesFor(rule, { w6Today: w6, w5w6Today: w5w6, w6Streak: streak }),
          `${w6} / ${w5w6}, run ${streak}`,
        ).toBe(ratioDue(w6, w5w6));
        return true;
      },
    ),
    { ...propParams() },
  );
}, 900_000);

it('[AC-B2-09zj#22] 连续规则（D10-1186：指标为 24 小时内最长连续 W6，规则仍 ≥ 3）：最长连续 W6 为 0、1、2 不告警，3、4、12 告警；与当日分母无关——分母 3（不足 20）、当日没有任何 W5/W6（样本缺失或为 0）时连续 3 次仍告警', () => {
  const rule = streakRule();
  for (const [streak, due] of [
    [0, false],
    [1, false],
    [2, false],
    [3, true],
    [4, true],
    [12, true],
  ] as const) {
    expect(firesFor(rule, { w6Today: 0, w5w6Today: 25, w6Streak: streak }), `run ${streak}`).toBe(
      due,
    );
  }
  // 08 例: the day is short of 20, but 3 W6 in a row still alert.
  expect(firesFor(rule, { w6Today: 3, w5w6Today: 3, w6Streak: 3 }), 'run 3, 3 / 3 today').toBe(
    true,
  );
  // The run lies yesterday, within the 24 hours: nothing today, with zero samples or none at all.
  expect(firesFor(rule, { w6Today: 0, w5w6Today: 0, w6Streak: 3 }), 'run 3, 0 / 0 today').toBe(
    true,
  );
  expect(firesFor(rule, { w6Streak: 3 }), 'run 3, no samples today').toBe(true);
  // And the other way round: a bad ratio alone is not a run.
  expect(firesFor(rule, { w6Today: 10, w5w6Today: 20, w6Streak: 2 }), 'run 2, 10 / 20').toBe(false);
});

it('[AC-B2-09zj#23] 两条规则按 app_id 各算各的：一个 app 的计数不借给另一个 app；比例告警只落在比例超限的 app，连续告警只落在连续 ≥ 3 的 app', () => {
  const ratio = ratioRule();
  const streak = streakRule();
  const series = seriesOf({
    // ① due: 2 / 40 = 5 %.
    ratio_due: { w6Today: 2, w5w6Today: 40, w6Streak: 0 },
    // Many W5 here; if pooled with ratio_short, 1 / 28 would be above 2 % with ≥ 20.
    ratio_pool: { w6Today: 0, w5w6Today: 18, w6Streak: 0 },
    ratio_short: { w6Today: 1, w5w6Today: 10, w6Streak: 1 },
    // ② due on its own.
    streak_due: { w6Today: 3, w5w6Today: 3, w6Streak: 3 },
    // Two apps with 2 each: never 4 pooled.
    streak_two_a: { w6Today: 2, w5w6Today: 2, w6Streak: 2 },
    streak_two_b: { w6Today: 2, w5w6Today: 2, w6Streak: 2 },
    quiet: { w6Today: 0, w5w6Today: 25, w6Streak: 0 },
  });
  expect(firing(ratio.expr, series), ratio.alert).toEqual(['ratio_due']);
  expect(firing(streak.expr, series), streak.alert).toEqual(['streak_due']);
});

it('[AC-B2-09zj#24] couli.yaml 不读这三个指标（夜间只推资金类）', () => {
  const base = rules(BASE_RULES).flatMap((rule) => rule.expr.match(/\bcouli_[a-z0-9_]+/g) ?? []);
  expect(base.filter((name) => FAIL_METRIC_NAMES.includes(name))).toEqual([]);
  // The fund file does read them: the check above is not vacuous.
  const fund = rules(FUND_RULES).flatMap((rule) => rule.expr.match(/\bcouli_[a-z0-9_]+/g) ?? []);
  expect(
    FAIL_METRIC_NAMES.filter((name) => !fund.includes(name)),
    'unread in couli-fund.yaml',
  ).toEqual([]);
});

it('[AC-B2-09zj#25] couli-fund.yaml 不再有「W6 ratio and repeated W6 … blocked on B2-06a」那行过时的 TODO', () => {
  expect(existsSync(FUND_RULES), `${FUND_RULES.pathname} exists`).toBe(true);
  const lines = readFileSync(FUND_RULES, 'utf8').split('\n');
  expect(
    lines.filter((line) => /\bB2-06a\b/.test(line)),
    'lines still naming B2-06a',
  ).toEqual([]);
  expect(
    lines.filter((line) => /\bTODO\b/.test(line) && /\bW6\b/.test(line)),
    'TODO lines about W6',
  ).toEqual([]);
});
