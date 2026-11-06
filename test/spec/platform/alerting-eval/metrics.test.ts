import { expect, it } from 'vitest';
import { createMetricsRegistry } from '../../../../apps/api/src/modules/platform/metrics/registry.ts';
import { string } from '../../infra/staging/kit.ts';
import { ENTRIES, metricsPort, RULE_FILES, rules, scrapeJobs, type Entry } from './kit.ts';

// couli.yaml explicitly sources these four series from the existing redis_exporter, outside
// the three application jobs. This is an exact allowlist, not permission for arbitrary redis_*
// names. Actual exporter ingestion/availability still needs the staging drill.
const REDIS_EXPORTS = new Set([
  'redis_up',
  'redis_memory_used_bytes',
  'redis_memory_max_bytes',
  'redis_errors_total',
]);

function referencedMetrics(expression: string): string[] {
  // The checked-in rules use named selectors, label matchers, ranges, functions and grouping.
  // Remove those syntactic parts before inspecting identifiers; do not merely search couli_*,
  // which would silently miss misspelled prefixes. Fail closed on dynamic name selectors.
  expect(expression, 'rules use explicit metric names').not.toMatch(/\b__name__\b/);
  const stripped = expression
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/g, '""')
    .replace(/\{[^}]*\}|\[[^\]]*\]/g, ' ')
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ')
    .replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\s*(?=\()/g, ' ')
    .replace(/\b(?:and|or|unless|bool)\b/g, ' ');
  const identifiers = stripped.match(/[a-zA-Z_:][a-zA-Z0-9_:]*/g) ?? [];
  expect(identifiers.length, `${expression}: at least one metric reference`).toBeGreaterThan(0);
  return [...new Set(identifiers)];
}

async function exportedMetrics(entry: Entry): Promise<Set<string>> {
  // Use the real registry's entry filtering and names, with in-memory collector snapshots.
  // No DB, timers, application bootstrap or HTTP listener. A stream-only metric cannot pass
  // because stream is never rendered. Values are fixtures, not invented platform responses.
  const registry = createMetricsRegistry({
    entry,
    collect: async () => ({
      queueFailed: { 'evt.order': 1 },
      deadLetters: { 'evt.order.dead': 1 },
      backlog: { 'evt.order': 1 },
      oldestDueEvtAgeSeconds: { 'evt.order': 61 },
      syncWatermarkLagSeconds: { taobao: 1801 },
    }),
    collectFund: async () => ({
      orderSyncPendingOpen: { UNMAPPED_STATUS: 1, ORDER_ROW_INVALID: 1 },
      billJobsFailed: 1,
      partialBatches: 1,
      beneficiariesHeldOver30Days: 1,
      payingNeedsManual: 1,
    }),
    collectAutoPayout: async () => ({
      totalFen: { 'fixture-app': 100 },
      capFen: { 'fixture-app': 100 },
    }),
    collectReviewOverdue: async () => ({ reviewOverdue: 1 }),
    collectWaterLow: async () => ({ waterLow: { 'fixture-app': 1 } }),
    collectTaobaoSearch: () => [{ source: 'official', outcome: 'fallback', value: 1 }],
  });
  const text = await registry.render();
  // Inspect actual sample lines, not HELP/TYPE declarations that could have no samples.
  return new Set(
    [...text.matchAll(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{|\s)/gm)].map((match) => match[1]!),
  );
}

it.each(RULE_FILES)(
  '[AC-B1-25b#8] %s 的每个指标都有被抓取的应用导出方或已知 Redis exporter 来源',
  async (file) => {
    // This test concerns the configured evaluation chain, not the pre-existing registry alone:
    // missing new scrape assets / missing METRICS_PORT must be assertion-red in the test phase.
    const jobs = scrapeJobs();
    const available = new Set<string>();
    for (const entry of ENTRIES) {
      expect(jobs.map((job) => job['job_name'])).toContain(`couli-${entry}`);
      expect(metricsPort(entry)).toBeGreaterThan(0);
      for (const name of await exportedMetrics(entry)) available.add(name);
    }
    for (const rule of rules(file)) {
      const alert = string(rule['alert']);
      for (const name of referencedMetrics(string(rule['expr']))) {
        expect(
          available.has(name) || REDIS_EXPORTS.has(name),
          `${file}/${alert}: ${name} must be exported by api/worker/admin or the known Redis exporter; stream-only is insufficient`,
        ).toBe(true);
      }
    }
  },
);
