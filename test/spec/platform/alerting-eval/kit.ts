import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { asset, environment, list, record, services, string } from '../../infra/staging/kit.ts';

// D10-716 acceptance identifiers are local to B1-25b. Read repository assets only;
// never open node env files, spawn a command, connect to a service or start a listener.
export const ENTRIES = ['api', 'worker', 'admin'] as const;
export const RULE_FILES = ['couli.yaml', 'couli-fund.yaml'] as const;
export type Entry = (typeof ENTRIES)[number];

export function yaml(path: string): Record<string, unknown> {
  const source = asset(path); // Missing assets fail an assertion before readFileSync.
  let value: unknown;
  expect(() => {
    value = parseYamlLite(source);
  }, `${path}: valid repository YAML`).not.toThrow();
  return record(value);
}

export function port(value: unknown): number {
  expect(['string', 'number'], 'port is a non-secret, explicit scalar').toContain(typeof value);
  expect(String(value), 'fixed port shared with the static scrape target').toMatch(/^[1-9]\d*$/);
  const result = Number(value);
  expect(Number.isSafeInteger(result)).toBe(true);
  expect(result).toBeGreaterThan(0);
  expect(result).toBeLessThanOrEqual(65535);
  return result;
}

export function metricsPort(entry: Entry): number {
  const env = environment(record(services()[entry])['environment']);
  expect(env, `${entry} declares METRICS_PORT`).toHaveProperty('METRICS_PORT');
  return port(env['METRICS_PORT']);
}

export function scrapeJobs(): Record<string, unknown>[] {
  const config = yaml('infra/monitoring/scrape/couli.yml');
  expect(config['scrape_config_files'], 'no additional scrape files').toBeUndefined();
  const jobs = list(config['scrape_configs']).map(record);
  expect(jobs.map((job) => job['job_name']).sort(), 'exactly the three couli jobs').toEqual(
    ENTRIES.map((entry) => `couli-${entry}`).sort(),
  );
  return jobs;
}

export function args(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const raw of asset('infra/monitoring/vmalert/couli.args').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    expect(line, 'one -flag=value per line, no shell quoting or expansion').toMatch(
      /^-[A-Za-z][A-Za-z0-9.]*=[^\s'"`$]+$/,
    );
    const split = line.indexOf('=');
    const key = line.slice(1, split);
    result.set(key, [...(result.get(key) ?? []), line.slice(split + 1)]);
  }
  expect(result.size, 'vmalert arguments are not empty').toBeGreaterThan(0);
  return result;
}

export function oneArg(flags: Map<string, string[]>, name: string): string {
  const values = flags.get(name) ?? [];
  expect(values, `exactly one -${name}`).toHaveLength(1);
  return string(values[0]);
}

export function durationMs(value: unknown): number {
  const text = string(value);
  expect(text, 'positive duration in ms/s/m/h').toMatch(/^\d+(?:\.\d+)?(?:ms|s|m|h)$/);
  const unit = text.match(/ms|s|m|h/)?.[0] ?? '';
  const scale: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  const result = Number(text.slice(0, -unit.length)) * (scale[unit] ?? 0);
  expect(result).toBeGreaterThan(0);
  return result;
}

export function rules(file: string): Record<string, unknown>[] {
  const groups = list(yaml(`infra/monitoring/rules/${file}`)['groups']);
  expect(groups.length, `${file} groups`).toBeGreaterThan(0);
  return groups.flatMap((group) => {
    const entries = list(record(group)['rules']).map(record);
    expect(entries.length, `${file} rules`).toBeGreaterThan(0);
    return entries;
  });
}
