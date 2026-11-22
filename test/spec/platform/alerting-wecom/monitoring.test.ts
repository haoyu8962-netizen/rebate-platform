import { globSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { publishContainerHealth } from '../../../../infra/monitoring/scripts/container-health.ts';
import { asset, list, record, string } from '../../infra/staging/kit.ts';
import {
  args,
  durationMs,
  ENTRIES,
  oneArg,
  port,
  RULE_FILES,
  rules,
  scrapeJobs,
  yaml,
} from '../alerting-eval/kit.ts';
import { CONTAINERS } from './staging-containers.ts';

const MONITORING = 'infra/monitoring';
const EXPORTER_CONFIG = 'exporters.yml';
const OUTAGE_RULES = 'outage.yaml';
const SCRAPE_AUTH_FIELDS = new Set([
  'basic_auth',
  'authorization',
  'oauth2',
  'bearer_token',
  'bearer_token_file',
  'headers',
  'http_headers',
  'tls_config',
]);

function readArgs(path: string): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (const raw of asset(path).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    expect(line, path).toMatch(/^-[A-Za-z][A-Za-z0-9.]*=[^\s'"`$]+$/);
    const split = line.indexOf('=');
    const key = line.slice(1, split);
    flags.set(key, [...(flags.get(key) ?? []), line.slice(split + 1)]);
  }
  return flags;
}

function instanceArgs(
  directory: 'scrape' | 'vmalert',
  existing: string,
  flag: string,
  file: string,
): Map<string, string[]> {
  const folder = new URL(`../../../../${MONITORING}/${directory}/`, import.meta.url);
  const candidates = globSync('*.args', { cwd: fileURLToPath(folder) })
    .filter((name) => name !== existing)
    .map((name) => readArgs(`${MONITORING}/${directory}/${name}`))
    .filter((flags) => flags.get(flag)?.some((path) => posix.basename(path) === file));
  expect(candidates, `one independent instance loading ${file}`).toHaveLength(1);
  const flags = candidates[0]!;
  const path = oneArg(flags, flag);
  expect(path, 'one explicit local file').not.toMatch(/[:*?\[\]{},]/);
  return flags;
}

function localListener(flags: Map<string, string[]>): string {
  const address = oneArg(flags, 'httpListenAddr');
  expect(address).toMatch(/^127\.0\.0\.1:[1-9]\d*$/);
  port(address.split(':')[1]);
  return address;
}

function exporterJobs() {
  const config = yaml(`${MONITORING}/scrape/${EXPORTER_CONFIG}`);
  expect(Object.keys(config).sort()).toEqual(
    config['global'] === undefined ? ['scrape_configs'] : ['global', 'scrape_configs'],
  );
  const jobs = list(config['scrape_configs']).map(record);
  const pg = jobs.filter((job) =>
    /(^|[-_])(?:pg|postgres(?:ql)?)(?:[-_]?exporter)?$/.test(string(job['job_name'])),
  );
  const redis = jobs.filter((job) =>
    /(^|[-_])redis(?:[-_]?exporter)?$/.test(string(job['job_name'])),
  );
  expect(jobs).toHaveLength(2);
  expect(pg, 'pg_exporter scrape job').toHaveLength(1);
  expect(redis, 'redis_exporter scrape job').toHaveLength(1);
  return { pg: pg[0]!, redis: redis[0]! };
}

function targets(job: Record<string, unknown>): string[] {
  return list(job['static_configs']).flatMap((entry) => list(record(entry)['targets']).map(string));
}

// Simple metric == 0 comparisons, with an optional selector. A bool comparison would leave
// healthy series in the result vector and would also trigger an alert for them.
function zeroSelectors(rules: Record<string, unknown>[], metric: string) {
  const expression = new RegExp(`^${metric}(?:\\{([^}]+)\\})?\\s*==\\s*0$`);
  return rules.flatMap((rule) => {
    const match = expression.exec(string(rule['expr']).trim());
    return match ? [{ rule, selector: match[1] }] : [];
  });
}

function outageRules(): Record<string, unknown>[] {
  return rules(OUTAGE_RULES);
}

function checkOps(rule: Record<string, unknown>) {
  expect(string(rule['alert'])).not.toBe('');
  const labels = record(rule['labels']);
  expect(string(labels['severity'])).not.toBe('');
  expect(labels['fund']).not.toBe('true');
  expect(string(record(rule['annotations'])['summary']).trim()).not.toBe('');
}

it('[AC-B1-25c#6] vmagent 以独立的回环任务抓取 PG 与 Redis exporter', () => {
  const { pg, redis } = exporterJobs();
  const sources: string[] = [];
  for (const job of [pg, redis]) {
    const name = string(job['job_name']);
    const endpoints = targets(job);
    expect(endpoints, name).toHaveLength(1);
    const endpoint = endpoints[0]!;
    expect(endpoint).toMatch(/^127\.0\.0\.1:[1-9]\d*$/);
    port(endpoint.split(':')[1]);
    expect(job['metrics_path'] ?? '/metrics').toBe('/metrics');
    expect(job['scheme'] ?? 'http').toBe('http');
    const fields = Object.keys(job);
    const auth = fields.filter((key) => SCRAPE_AUTH_FIELDS.has(key));
    const discoveryOrProxy = fields.filter((key) => /_sd_configs$|^proxy_/.test(key));
    expect(auth, name).toEqual([]);
    expect(discoveryOrProxy, name).toEqual([]);
    expect(job['relabel_configs'] ?? [], name).toEqual([]);
    expect(job['metric_relabel_configs'] ?? [], name).toEqual([]);
    expect(job['params'] ?? {}, name).toEqual({});
    for (const entry of list(job['static_configs'])) {
      const labels = record(record(entry)['labels'] ?? {});
      const reserved = Object.keys(labels).filter((key) => key.startsWith('__'));
      expect(reserved, name).toEqual([]);
    }
    sources.push(endpoint);
  }
  expect(new Set(sources).size).toBe(2);
  for (const job of scrapeJobs()) {
    for (const target of targets(job)) expect(sources).not.toContain(target);
  }
});

it('[AC-B1-25c#7] 宕机组按抓取失败覆盖 api、worker、admin 三个应用任务', () => {
  const checks = zeroSelectors(outageRules(), 'up');
  expect(checks.length).toBeGreaterThan(0);
  const expectedJobs = ENTRIES.map((entry) => `couli-${entry}`);
  const { pg, redis } = exporterJobs();
  const jobNames = [...scrapeJobs(), pg, redis].map((job) => string(job['job_name']));
  const observedJobs = new Set<string>();
  for (const { rule, selector } of checks) {
    checkOps(rule);
    const matcher = /^job\s*(=~|=)\s*"([^"]+)"$/.exec(selector ?? '');
    expect(matcher, 'scope up to the application scrape jobs').not.toBeNull();
    const operator = matcher?.[1];
    const value = matcher?.[2] ?? '';
    const pattern = operator === '=~' ? new RegExp(`^(?:${value})$`) : null;
    const matched = jobNames.filter((name) => (pattern ? pattern.test(name) : value === name));
    expect(matched.length, `jobs matched by ${selector}`).toBeGreaterThan(0);
    for (const name of matched) observedJobs.add(name);
  }
  expect([...observedJobs].sort()).toEqual([...expectedJobs].sort());
});

it('[AC-B1-25c#8] PG 和 Redis 按连接状态告警，Redis 规则只保留一条', () => {
  const outage = outageRules();
  const pg = zeroSelectors(outage, 'pg_up');
  expect(pg).toHaveLength(1);
  checkOps(pg[0]!.rule);

  const existing = RULE_FILES.flatMap(rules);
  const redis = zeroSelectors(existing, 'redis_up');
  expect(redis.map(({ rule }) => rule['alert'])).toEqual(['CouliRedisDown']);
  const all = [...existing, ...outage];
  expect(all.filter((rule) => /\bredis_up\b/.test(string(rule['expr'])))).toHaveLength(1);
  expect(all.filter((rule) => rule['alert'] === 'CouliRedisDown')).toHaveLength(1);
});

it('[AC-B1-25c#9] 容器健康值持续为零两分钟才告警，覆盖五个容器', () => {
  const checks = zeroSelectors(outageRules(), 'couli_container_healthy');
  expect(checks.length).toBeGreaterThan(0);
  const covered = new Set<string>();
  for (const { rule, selector } of checks) {
    checkOps(rule);
    expect(durationMs(rule['for'])).toBe(120_000);
    if (selector === undefined) {
      CONTAINERS.forEach((name) => covered.add(name));
      continue;
    }
    const matcher = /^name\s*(=~|=)\s*"([^"]+)"$/.exec(selector);
    expect(matcher, 'container metric uses the name label').not.toBeNull();
    const value = matcher?.[2] ?? '';
    for (const name of CONTAINERS) {
      if (matcher?.[1] === '=~' ? new RegExp(`^(?:${value})$`).test(name) : value === name) {
        covered.add(name);
      }
    }
  }
  expect([...covered].sort()).toEqual([...CONTAINERS].sort());
});

it('[AC-B1-25c#10] 单个容器五分钟无新样本也能告警', () => {
  const staleRules = outageRules().filter((rule) =>
    /\babsent_over_time\s*\(/.test(string(rule['expr'])),
  );
  expect(staleRules.length).toBeGreaterThan(0);
  const monitored: string[] = [];
  for (const rule of staleRules) {
    checkOps(rule);
    for (const branch of string(rule['expr']).split(/\s+or\s+/)) {
      const match =
        /^absent_over_time\(\s*couli_container_healthy\{\s*name\s*=\s*"([^"]+)"\s*\}\[(5m|300s)\]\s*\)(?:\s*==\s*1)?$/.exec(
          branch.trim(),
        );
      expect(match, 'individual, positive absence check over five minutes').not.toBeNull();
      monitored.push(match?.[1] ?? '');
    }
  }
  expect(monitored.sort()).toEqual([...CONTAINERS].sort());
});

it('[AC-B1-25c#14] 第二个 vmagent 抓取 exporter 并写入同一数据源', () => {
  const flags = instanceArgs('scrape', 'vmagent.args', 'promscrape.config', EXPORTER_CONFIG);
  const existing = readArgs(`${MONITORING}/scrape/vmagent.args`);
  expect(oneArg(flags, 'remoteWrite.url')).toBe(oneArg(existing, 'remoteWrite.url'));
  expect(localListener(flags)).not.toBe(localListener(existing));
});

it('[AC-B1-25c#15] 第二个 vmalert 独立加载宕机规则并检查 for 时长', () => {
  const flags = instanceArgs('vmalert', 'couli.args', 'rule', OUTAGE_RULES);
  const existing = args();
  for (const name of ['datasource.url', 'notifier.url']) {
    expect(oneArg(flags, name)).toBe(oneArg(existing, name));
  }
  for (const name of ['notifier.config', 'notifier.blackhole', 'dryRun']) {
    expect(flags.has(name), `-${name}`).toBe(false);
  }
  expect(localListener(flags)).not.toBe(localListener(existing));
  const interval = durationMs(oneArg(flags, 'evaluationInterval'));
  expect(interval).toBeLessThanOrEqual(60_000);
  const groups = list(yaml(`${MONITORING}/rules/${OUTAGE_RULES}`)['groups']).map(record);
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    const override = group['interval'];
    const groupInterval = override === undefined ? interval : durationMs(override);
    expect(groupInterval).toBeLessThanOrEqual(60_000);
    for (const rule of list(group['rules']).map(record)) {
      const hold = durationMs(rule['for']);
      expect(hold, string(rule['alert'])).toBeGreaterThanOrEqual(Math.max(interval, groupInterval));
    }
  }
});

function referencedMetrics(expression: string): string[] {
  expect(expression, 'rules use explicit metric names').not.toMatch(/\b__name__\b/);
  const selectors = expression
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/g, '')
    .replace(/\{[^}]*\}|\[[^\]]*\]/g, ' ')
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ')
    .replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\s*(?=\()/g, ' ')
    .replace(/\b(?:and|or|unless|bool)\b/g, ' ');
  const metrics = selectors.match(/[a-zA-Z_:][a-zA-Z0-9_:]*/g) ?? [];
  expect(metrics.length, expression).toBeGreaterThan(0);
  return metrics;
}

it('[AC-B1-25c#16] 宕机告警的每个指标均来自抓取任务或节点推送', async () => {
  const outage = outageRules();
  expect(scrapeJobs()).toHaveLength(ENTRIES.length);
  const { pg, redis } = exporterJobs();
  expect(targets(pg)).toHaveLength(1);
  expect(targets(redis)).toHaveLength(1);
  // Exporter metrics have fixed names; container metrics come from the script's payload.
  const available = new Set([
    'up',
    'pg_up',
    'redis_up',
    'redis_memory_used_bytes',
    'redis_memory_max_bytes',
    'redis_errors_total',
  ]);
  const accepted = new Response(null, { status: 204 });
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(accepted);
  await publishContainerHealth({
    inspect: async () => ({ Running: true, Health: { Status: 'healthy' } }),
    fetch,
  });
  for (const call of fetch.mock.calls) {
    const body = await new Request(...call).text();
    for (const match of body.matchAll(/^(couli_container_healthy)\{name="[^"]+"\}\s+[01]\b/gm)) {
      available.add(match[1]!);
    }
  }
  const redisDown = rules('couli.yaml').filter((rule) => rule['alert'] === 'CouliRedisDown');
  expect(redisDown).toHaveLength(1);
  for (const rule of [...outage, ...redisDown]) {
    for (const metric of referencedMetrics(string(rule['expr']))) {
      expect(available.has(metric), `${string(rule['alert'])}: source of ${metric}`).toBe(true);
    }
  }
});
