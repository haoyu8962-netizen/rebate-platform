import { posix } from 'node:path';
import { expect, it } from 'vitest';
import { list, record, string } from '../../infra/staging/kit.ts';
import { args, durationMs, ENTRIES, port, yaml } from '../alerting-eval/kit.ts';
import { CONTAINERS } from './staging-containers.ts';

function scrapeJobs() {
  return list(yaml('infra/monitoring/scrape/couli.yml')['scrape_configs']).map(record);
}

function targets(job: Record<string, unknown>): string[] {
  return list(job['static_configs']).flatMap((entry) => list(record(entry)['targets']).map(string));
}

function loadedGroups(): Record<string, unknown>[][] {
  const paths = args().get('rule') ?? [];
  expect(paths.length).toBeGreaterThan(0);
  return paths.flatMap((path) =>
    list(yaml(`infra/monitoring/rules/${posix.basename(path)}`)['groups']).map((group) =>
      list(record(group)['rules']).map(record),
    ),
  );
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
  const groups = loadedGroups().filter((group) => zeroSelectors(group, 'pg_up').length > 0);
  expect(groups, 'vmalert loads the outage group with the PostgreSQL check').toHaveLength(1);
  return groups[0]!;
}

function checkOps(rule: Record<string, unknown>) {
  expect(string(rule['alert'])).not.toBe('');
  const labels = record(rule['labels']);
  expect(string(labels['severity'])).not.toBe('');
  expect(labels['fund']).not.toBe('true');
  expect(string(record(rule['annotations'])['summary']).trim()).not.toBe('');
}

it('[AC-B1-25c#6] vmagent 以独立的回环任务抓取 PG 与 Redis exporter', () => {
  const jobs = scrapeJobs();
  const pg = jobs.filter((job) =>
    /(^|[-_])(?:pg|postgres(?:ql)?)(?:[-_]?exporter)?$/.test(string(job['job_name'])),
  );
  const redis = jobs.filter((job) =>
    /(^|[-_])redis(?:[-_]?exporter)?$/.test(string(job['job_name'])),
  );
  expect(pg, 'pg_exporter scrape job').toHaveLength(1);
  expect(redis, 'redis_exporter scrape job').toHaveLength(1);

  const sources = [];
  for (const job of [...pg, ...redis]) {
    const endpoints = targets(job);
    expect(endpoints, string(job['job_name'])).toHaveLength(1);
    const endpoint = endpoints[0]!;
    expect(endpoint).toMatch(/^127\.0\.0\.1:[1-9]\d*$/);
    port(endpoint.split(':')[1]);
    expect(job['metrics_path'] ?? '/metrics').toBe('/metrics');
    expect(job['scheme'] ?? 'http').toBe('http');
    sources.push(endpoint);
  }
  expect(new Set(sources).size).toBe(2);
  const applicationJobs = jobs.filter((job) =>
    ENTRIES.some((entry) => job['job_name'] === `couli-${entry}`),
  );
  for (const job of applicationJobs) {
    for (const target of targets(job)) expect(sources).not.toContain(target);
  }
});

it('[AC-B1-25c#7] 宕机组按抓取失败覆盖 api、worker、admin 三个应用任务', () => {
  const checks = zeroSelectors(outageRules(), 'up');
  expect(checks.length).toBeGreaterThan(0);
  const expectedJobs = ENTRIES.map((entry) => `couli-${entry}`);
  const observedJobs = new Set<string>();
  for (const { rule, selector } of checks) {
    checkOps(rule);
    const matcher = /^job\s*(=~|=)\s*"([^"]+)"$/.exec(selector ?? '');
    expect(matcher, 'scope up to the application scrape jobs').not.toBeNull();
    const operator = matcher?.[1];
    const value = matcher?.[2] ?? '';
    const pattern = operator === '=~' ? new RegExp(`^(?:${value})$`) : null;
    for (const job of scrapeJobs()) {
      const name = string(job['job_name']);
      if (pattern ? pattern.test(name) : value === name) observedJobs.add(name);
    }
  }
  expect([...observedJobs].sort()).toEqual([...expectedJobs].sort());
});

it('[AC-B1-25c#8] PG 和 Redis 按连接状态告警，Redis 规则只保留一条', () => {
  const pg = zeroSelectors(outageRules(), 'pg_up');
  expect(pg).toHaveLength(1);
  checkOps(pg[0]!.rule);

  const rules = loadedGroups().flat();
  const redis = zeroSelectors(rules, 'redis_up');
  expect(redis.map(({ rule }) => rule['alert'])).toEqual(['CouliRedisDown']);
  expect(rules.filter((rule) => /\bredis_up\b/.test(string(rule['expr'])))).toHaveLength(1);
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
    const hold = rule['for'];
    if (hold !== undefined) expect(hold).toMatch(/^0(?:ms|s|m|h)$/);
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
